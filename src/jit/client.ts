/**
 * JIT inbound liquidity, wallet side, against a beignet LSP.
 *
 * The exchange is beignet's own (liquidity/jit-receive.ts, issue #594 and
 * #687): ask a QUOTE, then send an AUTHORIZATION; the LSP mints an intercept
 * short channel id and answers with an ACK carrying it and its opening-fee
 * terms. The wallet puts the id in an invoice routing hint. When a payment
 * for that hint reaches the LSP it HOLDS the HTLC, opens a zero-conf channel
 * to the wallet (or splices its existing one bigger), then forwards, taking
 * the agreed opening fee off the top.
 *
 *   wallet (you)                      beignet LSP
 *     │  JIT_RECEIVE_QUOTE (4)           │
 *     ├────────────────────────────────>│  prices it, registers nothing
 *     │<──── JIT_RECEIVE_QUOTE_ACK (5) ──┤
 *     │  JIT_RECEIVE_AUTHORIZATION (1)   │
 *     ├────────────────────────────────>│  mints intercept scid
 *     │<──── JIT_RECEIVE_ACK (2) ────────┤  (scid, flat fee, ppm)
 *     │  invoice hint: LSP → scid        │
 *
 * The opening fee is collected one of two ways, and the ack says which
 * (`feeMode`, beignet PR #734); the grant's hint is built accordingly:
 *
 *  - skim: the LSP deducts the fee from the forwarded HTLC, which arrives
 *    SHORT of the onion's amt_to_forward. Only a final node implementing the
 *    allowance settles that (beignet does; LND and CLN fail it, BOLT 4
 *    final_incorrect_htlc_amount). The hint's fee is zero. Ask for this only
 *    with `acceptsSkimmedFee: true`, from a node that can honour it.
 *  - hop: the hint carries the quoted terms as an ordinary routing fee (base
 *    = flat fee, proportional = ppm), the SENDER pays it on top, and the LSP
 *    forwards the full amount. The final HTLC equals amt_to_forward, so any
 *    node settles it. This is what an LND or CLN wallet gets from a
 *    fee-charging beignet LSP (the default here). An LSP that predates hop
 *    mode declines such an intent instead; `JitDeclinedError` says so.
 *
 * Either way the hint's cltv delta is 80 and the invoice's
 * min_final_cltv_expiry is 72: the LSP needs blocks to fund the channel
 * between receiving the HTLC and forwarding it.
 */

import crypto from 'crypto';
import { gossip, liquidity, message } from 'beignet/lightning';
import { RouxLog, Sats, assertPubkeyHex, noopLog, toSats } from '../types';
import { IPeerLink } from '../link/types';
import { exchange } from '../link/exchange';

// ─────────────── Constants mirrored from beignet's wallet role ───────────────

/** cltv_expiry_delta the JIT hint advertises (lightning-node.ts). */
export const JIT_HINT_CLTV_DELTA = 80;
/** min_final_cltv_expiry a JIT invoice asks payers for. */
export const JIT_MIN_FINAL_CLTV_EXPIRY = 72;
/** Default lifetime asked for an intent. */
export const JIT_DEFAULT_EXPIRY_SECONDS = 3600;
/** Cap an amount-less receive asks the LSP to hold against (sat). */
export const JIT_DEFAULT_MAX_AMOUNT_SAT = 1_000_000n;
/** How long to wait for the LSP's answer. */
export const JIT_REPLY_TIMEOUT_MS = 15_000;
/** Refusal ceilings on a quote, beignet's defaults (JIT_CLIENT_MAX_*). */
export const JIT_DEFAULT_MAX_FLAT_FEE_SAT = 10_000n;
export const JIT_DEFAULT_MAX_FEE_PPM = 50_000;

// ─────────────── Shapes ───────────────

export interface IJitClientOptions {
	link: IPeerLink;
	/** Ceiling on a flat opening fee this client will register (default 10 000 sat). */
	maxFlatFeeSat?: Sats;
	/** Ceiling on a proportional opening fee (default 50 000 ppm, i.e. 5%). */
	maxFeePpm?: number;
	log?: RouxLog;
}

export interface IJitQuoteParams {
	/** The receive in mind (sat); default the amount-less cap. */
	maxAmountSat?: Sats;
	/** Inbound liquidity to leave over after the receive (sat). */
	targetRemainingInboundSat?: Sats;
	timeoutMs?: number;
}

export interface IJitQuote {
	/** Whether the LSP would register this intent as things stand. */
	accepted: boolean;
	flatFeeSat: bigint;
	feePpm: number;
	/** Most the LSP fronts for one client, open or splice (sat). */
	maxClientFundingSats: bigint;
	/** What the LSP would front for this receive (sat); 0 when refused. */
	fundingSats: bigint;
	/** Plain-language refusal, meant to be shown as is. */
	reason?: string;
	/** The opening fee on `maxAmountSat` at the quoted rate (sat, rounded up). */
	feeSats: bigint;
	/** Whether this client would accept the quoted fee at authorization. */
	withinCeilings: boolean;
}

export interface IJitAuthorizeParams {
	/** Hard cap the LSP may hold and fund against (sat). */
	maxAmountSat: Sats;
	/** Invoice total when it is known (fixed-amount invoices). */
	expectedTotalSat?: Sats;
	/** Inbound to leave over after the receive (sat); default none. */
	targetRemainingInboundSat?: Sats;
	/** Bind the intent to one payment hash (32 bytes). */
	paymentHash?: Buffer;
	expirySeconds?: number;
	/**
	 * Will this wallet's node settle an HTLC short of the onion amount by the
	 * opening fee? TRUE only for a node that implements the allowance (a
	 * beignet wallet does; LND and CLN do not). Default false, which asks a
	 * beignet LSP for hop mode: the fee goes into the hint and the sender
	 * pays it. A false true costs the LSP a funded channel and you a failed
	 * payment.
	 */
	acceptsSkimmedFee?: boolean;
	/** Per-request overrides of the configured fee ceilings. */
	maxFlatFeeSat?: Sats;
	maxFeePpm?: number;
	timeoutMs?: number;
}

/** How the LSP collects its opening fee for this intent. */
export type JitFeeMode = 'skim' | 'hop';

/** A routing hint hop in BOLT 11 terms. */
export interface IJitRouteHint {
	pubkeyHex: string;
	/** 8-byte short channel id, hex. */
	shortChannelIdHex: string;
	/** Zero in skim mode; the flat opening fee in msat in hop mode. */
	feeBaseMsat: number;
	/** Zero in skim mode; the opening fee's ppm in hop mode. */
	feeProportionalMillionths: number;
	cltvExpiryDelta: number;
}

/** An LND `HopHint` (lnrpc), ready for AddInvoice's route_hints. */
export interface ILndHopHint {
	node_id: string;
	/** uint64 as a decimal string, the way LND's REST API carries it. */
	chan_id: string;
	fee_base_msat: number;
	fee_proportional_millionths: number;
	cltv_expiry_delta: number;
}

export interface IJitGrant {
	lspPubkeyHex: string;
	interceptScid: Buffer;
	interceptScidHex: string;
	interceptScidParts: { block: number; txIndex: number; outputIndex: number };
	flatFeeSat: bigint;
	feePpm: number;
	/**
	 * `hop`: the fee rides the hint and the sender pays it; the full amount
	 * is delivered. `skim`: the fee is deducted from what you receive, and
	 * your node must settle the short HTLC.
	 */
	feeMode: JitFeeMode;
	/** The hint to put in the invoice, fee terms already set for `feeMode`. */
	routeHint: IJitRouteHint;
	/** The min_final_cltv_expiry to put in the invoice. */
	minFinalCltvExpiry: number;
	/** The opening fee the LSP will deduct from a delivery of this total. */
	openingFeeSats(totalSat: Sats): bigint;
	/** The hint as LND's AddInvoice wants it. */
	lndHopHint(): ILndHopHint;
	/** The short channel id in CLN's `BLOCKxTXxOUT` form. */
	clnShortChannelId(): string;
}

/** A refusal the LSP sent, or one this client applied to the LSP's terms. */
export class JitDeclinedError extends Error {
	constructor(
		text: string,
		readonly reason: 'lsp_declined' | 'fee_above_ceiling' | 'no_scid'
	) {
		super(text);
		this.name = 'JitDeclinedError';
	}
}

// ─────────────── The client ───────────────

export class JitClient {
	private readonly link: IPeerLink;
	private readonly maxFlatFeeSat: bigint;
	private readonly maxFeePpm: number;
	private readonly log: RouxLog;

	constructor(options: IJitClientOptions) {
		this.link = options.link;
		this.maxFlatFeeSat = toSats(
			options.maxFlatFeeSat ?? JIT_DEFAULT_MAX_FLAT_FEE_SAT,
			'maxFlatFeeSat'
		);
		this.maxFeePpm = options.maxFeePpm ?? JIT_DEFAULT_MAX_FEE_PPM;
		this.log = options.log ?? noopLog;
	}

	/**
	 * What a receive of this size would cost, and whether the LSP would serve
	 * it right now. Registers nothing; a decline is returned, not thrown.
	 */
	async quote(
		lspPubkeyHex: string,
		params: IJitQuoteParams = {}
	): Promise<IJitQuote> {
		const lsp = assertPubkeyHex(lspPubkeyHex, 'lspPubkeyHex');
		const maxAmountSat = toSats(
			params.maxAmountSat ?? JIT_DEFAULT_MAX_AMOUNT_SAT,
			'maxAmountSat'
		);
		if (maxAmountSat <= 0n) throw new Error('maxAmountSat must be positive');
		const maxAmountMsat = maxAmountSat * 1000n;
		const requestId = crypto.randomBytes(8);
		const reply = await this.exchange(
			lsp,
			message.BeignetCustomSubtype.JIT_RECEIVE_QUOTE,
			liquidity.encodeJitQuoteRequest({
				requestId,
				maxAmountMsat,
				targetRemainingInboundSat: toSats(
					params.targetRemainingInboundSat ?? 0n,
					'targetRemainingInboundSat'
				)
			}),
			message.BeignetCustomSubtype.JIT_RECEIVE_QUOTE_ACK,
			requestId,
			liquidity.decodeJitQuote,
			params.timeoutMs ?? JIT_REPLY_TIMEOUT_MS,
			'timed out waiting for the LSP JIT quote'
		);
		const feeMsat = liquidity.jitOpeningFeeMsat(maxAmountMsat, reply);
		const quote: IJitQuote = {
			accepted: reply.accepted,
			flatFeeSat: reply.flatFeeSat,
			feePpm: reply.feePpm,
			maxClientFundingSats: reply.maxClientFundingSats,
			fundingSats: reply.fundingSats,
			feeSats: (feeMsat + 999n) / 1000n,
			withinCeilings:
				reply.flatFeeSat <= this.maxFlatFeeSat && reply.feePpm <= this.maxFeePpm
		};
		if (reply.reason !== undefined) quote.reason = reply.reason;
		this.log('jit_quote', {
			lsp,
			accepted: quote.accepted,
			feeSats: quote.feeSats
		});
		return quote;
	}

	/**
	 * Register a receive intent and get back everything the invoice needs.
	 *
	 * Throws `JitDeclinedError` when the LSP declines or quotes a fee above
	 * this client's ceilings (an ack is the peer's number; registering an
	 * allowance for it would authorize a deduction nobody agreed to).
	 */
	async authorize(
		lspPubkeyHex: string,
		params: IJitAuthorizeParams
	): Promise<IJitGrant> {
		const lsp = assertPubkeyHex(lspPubkeyHex, 'lspPubkeyHex');
		const maxAmountSat = toSats(params.maxAmountSat, 'maxAmountSat');
		if (maxAmountSat <= 0n) throw new Error('maxAmountSat must be positive');
		if (params.paymentHash !== undefined && params.paymentHash.length !== 32) {
			throw new Error('paymentHash must be 32 bytes');
		}
		const expirySeconds = params.expirySeconds ?? JIT_DEFAULT_EXPIRY_SECONDS;
		if (!Number.isInteger(expirySeconds) || expirySeconds <= 0) {
			throw new Error('expirySeconds must be a positive integer');
		}
		const requestId = crypto.randomBytes(8);
		const authorization: liquidity.IJitReceiveAuthorization = {
			requestId,
			maxAmountMsat: maxAmountSat * 1000n,
			targetRemainingInboundSat: toSats(
				params.targetRemainingInboundSat ?? 0n,
				'targetRemainingInboundSat'
			),
			expirySeconds,
			acceptsSkimmedFee: params.acceptsSkimmedFee === true
		};
		if (params.paymentHash) authorization.paymentHash = params.paymentHash;
		if (params.expectedTotalSat !== undefined) {
			authorization.expectedTotalMsat =
				toSats(params.expectedTotalSat, 'expectedTotalSat') * 1000n;
		}
		const ack = await this.exchange(
			lsp,
			message.BeignetCustomSubtype.JIT_RECEIVE_AUTHORIZATION,
			liquidity.encodeJitAuthorization(authorization),
			message.BeignetCustomSubtype.JIT_RECEIVE_ACK,
			requestId,
			liquidity.decodeJitAck,
			params.timeoutMs ?? JIT_REPLY_TIMEOUT_MS,
			'timed out waiting for the LSP JIT receive ack'
		);
		if (!ack.accepted) {
			this.log('jit_declined', { lsp, reason: ack.reason });
			throw new JitDeclinedError(
				`LSP declined the JIT receive intent: ${
					ack.reason ?? 'no reason given'
				}`,
				'lsp_declined'
			);
		}
		if (ack.interceptScid.every((b) => b === 0)) {
			throw new JitDeclinedError(
				'LSP accepted the intent without an intercept scid',
				'no_scid'
			);
		}
		const maxFlat =
			params.maxFlatFeeSat === undefined
				? this.maxFlatFeeSat
				: toSats(params.maxFlatFeeSat, 'maxFlatFeeSat');
		const maxPpm = params.maxFeePpm ?? this.maxFeePpm;
		if (ack.flatFeeSat > maxFlat || ack.feePpm > maxPpm) {
			throw new JitDeclinedError(
				`LSP quoted ${ack.flatFeeSat} sat + ${ack.feePpm} ppm, above the ` +
					`accepted maximum of ${maxFlat} sat + ${maxPpm} ppm`,
				'fee_above_ceiling'
			);
		}
		const scid = Buffer.from(ack.interceptScid);
		const parts = gossip.decodeShortChannelId(scid);
		const flatFeeSat = ack.flatFeeSat;
		const feePpm = ack.feePpm;
		// An ack without the field is from an LSP that predates hop mode; it
		// only ever accepts a skim, or charges nothing.
		const feeMode: JitFeeMode = ack.feeMode ?? 'skim';
		if (feeMode === 'hop' && params.acceptsSkimmedFee === true) {
			// Would charge twice: once on the sender, again off the forward.
			throw new JitDeclinedError(
				'LSP answered a skim-accepting intent with hop-mode fee terms',
				'lsp_declined'
			);
		}
		if (
			feeMode === 'skim' &&
			params.acceptsSkimmedFee !== true &&
			(flatFeeSat > 0n || feePpm > 0)
		) {
			// Cannot happen against beignet (a fee with no skim consent is hop
			// mode there), but a hint built as zero-fee here would have the
			// LSP skim a node that will fail the short HTLC.
			throw new JitDeclinedError(
				'LSP would skim a fee this wallet did not agree to accept',
				'lsp_declined'
			);
		}
		const hintBaseMsat = feeMode === 'hop' ? Number(flatFeeSat * 1000n) : 0;
		const hintPpm = feeMode === 'hop' ? feePpm : 0;
		const grant: IJitGrant = {
			lspPubkeyHex: lsp,
			interceptScid: scid,
			interceptScidHex: scid.toString('hex'),
			interceptScidParts: parts,
			flatFeeSat,
			feePpm,
			feeMode,
			routeHint: {
				pubkeyHex: lsp,
				shortChannelIdHex: scid.toString('hex'),
				feeBaseMsat: hintBaseMsat,
				feeProportionalMillionths: hintPpm,
				cltvExpiryDelta: JIT_HINT_CLTV_DELTA
			},
			minFinalCltvExpiry: JIT_MIN_FINAL_CLTV_EXPIRY,
			openingFeeSats: (totalSat: Sats): bigint => {
				const msat = liquidity.jitOpeningFeeMsat(
					toSats(totalSat, 'totalSat') * 1000n,
					{ flatFeeSat, feePpm }
				);
				return (msat + 999n) / 1000n;
			},
			lndHopHint: (): ILndHopHint => ({
				node_id: lsp,
				chan_id: scid.readBigUInt64BE(0).toString(10),
				fee_base_msat: hintBaseMsat,
				fee_proportional_millionths: hintPpm,
				cltv_expiry_delta: JIT_HINT_CLTV_DELTA
			}),
			clnShortChannelId: (): string =>
				`${parts.block}x${parts.txIndex}x${parts.outputIndex}`
		};
		this.log('jit_granted', {
			lsp,
			scid: grant.interceptScidHex,
			flatFeeSat,
			feePpm,
			feeMode
		});
		return grant;
	}

	// ─────────────── Internals ───────────────

	/** One round trip on the custom message type (link/exchange.ts). */
	private exchange<T extends { requestId: Buffer }>(
		peerHex: string,
		requestSubtype: number,
		requestPayload: Buffer,
		replySubtype: number,
		requestId: Buffer,
		decode: (payload: Buffer) => T,
		timeoutMs: number,
		timeoutMessage: string
	): Promise<T> {
		return exchange(this.link, {
			peerHex,
			requestSubtype,
			requestPayload,
			replySubtype,
			requestId,
			decode,
			timeoutMs,
			timeoutMessage
		});
	}
}
