/**
 * Reverse swaps, client side: the shapes and the two seams.
 *
 * A reverse swap moves Lightning balance to the chain: this client pays a
 * beignet provider's hold invoice for a hash it holds the preimage of, the
 * provider funds a P2WSH contract the client can claim with that preimage,
 * and the claim's witness (mempool or block) is what lets the provider
 * settle the hold. Nothing in roux settles or holds an invoice; the
 * provider does that.
 *
 * Two seams a host supplies, because an LND or CLN wallet can pay an
 * invoice and hand out an address but cannot watch the chain or broadcast:
 *
 *  - ISwapLightningPayer: fire a payment (it blocks for as long as the hold
 *    does), report a payment's status by hash, give a claim destination.
 *  - ISwapChain: height, raw transactions, one outpoint's unspent-ness and
 *    depth, broadcast. Bitcoin Core's RPC or any beignet IChainBackend.
 *
 * A submarine swap moves the other way: this client mints an invoice on
 * its own node, locks coins in a P2WSH contract whose preimage branch is
 * the provider's, the provider pays the invoice under an absolute expiry
 * ceiling and claims the coins with the preimage; unpaid past the refund
 * height, the client refunds itself. The same chain seam serves it, the
 * Lightning seam grows invoice creation and lookup, and a third seam
 * (ISwapFunder) sends the coins.
 *
 * One optional seam, ISwapSecretProvider, moves a swap's secrets out of
 * the record and into the host's wallet; see secrets.ts.
 */

import { RouxNetwork } from '../types';

export interface ISwapPaymentStatus {
	status: 'unknown' | 'pending' | 'succeeded' | 'failed';
	preimage?: Buffer;
	failureReason?: string;
}

export interface ISwapLightningPayer {
	/**
	 * Fire the payment. Resolves on a TERMINAL report from the node, which
	 * for a hold invoice means when the swap resolves; never awaited on the
	 * hot path.
	 */
	payInvoice(
		bolt11: string,
		opts: { maxFeeSat: bigint; timeoutSeconds: number }
	): Promise<ISwapPaymentStatus>;
	/** Point-in-time status by payment hash. */
	trackPayment(paymentHash: Buffer): Promise<ISwapPaymentStatus>;
	/** A fresh native-segwit output script of the paying node's wallet. */
	newDestinationScript?(): Promise<Buffer>;
	/** Submarine swaps: mint an invoice this node will settle. */
	createInvoice?(
		params: ISwapCreateInvoiceParams
	): Promise<ISwapCreatedInvoice>;
	/** Submarine swaps: the invoice's state, HTLCs in flight included. */
	lookupInvoice?(paymentHash: Buffer): Promise<ISwapInvoiceStatus>;
}

export interface ISwapCreateInvoiceParams {
	amountMsat: bigint;
	description: string;
	expirySeconds: number;
	minFinalCltvExpiry: number;
}

export interface ISwapCreatedInvoice {
	bolt11: string;
	paymentHash: Buffer;
}

/**
 * An invoice as the node sees it. `accepted` (or `htlcsInFlight` above
 * zero on an open invoice) means an HTLC is parked or in flight: the payer
 * may still learn the preimage from a settle, so a refund must wait.
 */
export interface ISwapInvoiceStatus {
	state: 'unknown' | 'open' | 'accepted' | 'settled' | 'cancelled' | 'expired';
	preimage?: Buffer;
	htlcsInFlight?: number;
}

/** Sends the swap's coins to the contract address (submarine swaps). */
export interface ISwapFunder {
	/**
	 * Pay `amountSat` to the address. `label` is a per-swap tag a wallet
	 * that supports labels records, so a funding lost between the call and
	 * its reply can be found again.
	 */
	fund(
		address: string,
		amountSat: bigint,
		opts: { label: string; feeRateSatPerVb?: number }
	): Promise<{ txidHex: string; vout?: number; rawHex?: string }>;
	/** Optional: a funding this wallet sent for the label or address. */
	findFunding?(
		address: string,
		label: string
	): Promise<{ txidHex: string; vout: number } | null>;
}

/**
 * The host's wallet, asked for one swap's secrets instead of roux writing
 * them down. Given one, a record holds only the swap's public material and
 * a non-secret id, and the claim key, preimage or refund key are derived
 * again whenever a claim or a refund has to be signed. HKDF from a
 * wallet-held seed is the natural implementation; `FileSecretProvider` is
 * the one roux ships.
 *
 * Every method takes the record's `secrets.idHex`, the 16 random bytes roux
 * chose for the swap before any wire traffic (the provider names the swap
 * only in its ack, too late for the preimage the payment hash comes from).
 * A derivation must therefore depend on nothing but the seed and that id,
 * and must answer the same bytes for the life of the swap. Roux checks what
 * comes back against the record's payment hash and public keys, so a wrong
 * seed is an error rather than a transaction that pays nobody.
 */
export interface ISwapSecretProvider {
	/** Named on every record this provider derives for; `resume()` matches it. */
	readonly id: string;
	/** Reverse swaps: the 32-byte preimage the payment hash is taken from. */
	derivePreimage(idHex: string): Buffer | Promise<Buffer>;
	/** Reverse swaps: the scalar that signs the claim. */
	deriveClaimKey(idHex: string): Buffer | Promise<Buffer>;
	/** Submarine swaps: the scalar that signs the refund. */
	deriveRefundKey(idHex: string): Buffer | Promise<Buffer>;
}

/** What a record says about the secrets it does not hold. */
export interface ISwapRecordSecrets {
	/** The `ISwapSecretProvider.id` that derived them. */
	provider: string;
	/** The id they were derived from; not secret. */
	idHex: string;
}

export interface ISwapChainOutput {
	valueSat: bigint;
	script: Buffer;
	confirmations: number;
	/** 0 while in the mempool. */
	height: number;
}

export interface ISwapFundingCandidate {
	txidHex: string;
	vout: number;
	valueSat: bigint;
	height: number;
}

export interface ISwapChain {
	currentHeight(): Promise<number>;
	/** Raw bytes, or null when unknown to this source. A height hint helps a pruned Core. */
	getTransaction(txidHex: string, heightHint?: number): Promise<Buffer | null>;
	/** The outpoint while UNSPENT (gettxout semantics); null once spent or unknown. */
	getOutput(txidHex: string, vout: number): Promise<ISwapChainOutput | null>;
	/** Optional: outputs paying a script (Electrum listunspent). */
	findOutputs?(outputScript: Buffer): Promise<ISwapFundingCandidate[]>;
	/** Optional: the txid that spent an outpoint, when the source can answer. */
	findSpender?(
		txidHex: string,
		vout: number,
		outputScript: Buffer
	): Promise<string | null>;
	/**
	 * Confirmations of a transaction; 0 in the mempool; null when unknown.
	 * `heightHint` is where the caller last knew the transaction to be (its
	 * broadcast or confirmation height), for a source that has to scan
	 * blocks to find a mined transaction.
	 */
	confirmations(txidHex: string, heightHint?: number): Promise<number | null>;
	broadcast(rawHex: string): Promise<string>;
	estimateFeeRateSatPerVb?(targetBlocks: number): Promise<number | null>;
}

export interface ISwapClientPolicy {
	/** Refuse terms whose refund height is closer than this to our tip. */
	minRefundDeltaBlocks: number;
	maxRefundDeltaBlocks: number;
	/**
	 * The FIRST claim (the disclosure of the preimage) is refused once the
	 * tip is within this of the refund height: past it the provider could
	 * learn the preimage, settle the Lightning side, and still win the
	 * output with a refund that confirms first. A claim already out keeps
	 * being followed and bumped, since the preimage is public anyway.
	 */
	claimSafetyBlocks: number;
	/**
	 * Confirmations the funding needs before a claim is broadcast. The claim
	 * reveals the preimage in the mempool, and a provider that learns it
	 * settles the hold; an unconfirmed funding it could then replace would
	 * leave the client paid on Lightning and empty on chain. Never below 1.
	 */
	minFundingConfirmations: number;
	defaultFeeRateSatPerVb: number;
	maxClaimFeeSat: bigint;
	/** Blocks an unconfirmed claim waits before a rebuild at a higher rate. */
	bumpAfterBlocks: number;
	bumpFactor: number;
	/** Lightning fee ceiling as parts per million of the invoice, and a floor in sats. */
	maxLightningFeePpm: number;
	minLightningFeeSat: bigint;
	/** Route-search budget handed to the payer; not the hold's lifetime. */
	paymentTimeoutSeconds: number;
	statusPollMs: number;
	chainPollMs: number;
	replyTimeoutMs: number;
	// Submarine swaps (on-chain to Lightning).
	/** Final CLTV the minted invoice asks for (LND's floor is 18). */
	invoiceFinalCltvBlocks: number;
	/** Route headroom the provider's payment may add above the final CLTV. */
	routeBudgetBlocks: number;
	invoiceExpirySeconds: number;
	maxRefundFeeSat: bigint;
	/** Confirmations our refund needs before the swap is REFUNDED. */
	refundConfirmations: number;
	/** Refuse an ack whose funding depth would eat the window. */
	maxProviderFundingConfirmations: number;
	/**
	 * Sats left to the provider above its quoted fee, so a fee estimate that
	 * rose between the quote and the create cannot refuse the invoice.
	 */
	submarineFeeSlackSat: bigint;
}

export const SWAP_DEFAULT_POLICY: ISwapClientPolicy = {
	minRefundDeltaBlocks: 36,
	maxRefundDeltaBlocks: 4320,
	claimSafetyBlocks: 6,
	minFundingConfirmations: 1,
	defaultFeeRateSatPerVb: 2,
	maxClaimFeeSat: 10_000n,
	bumpAfterBlocks: 3,
	bumpFactor: 1.5,
	maxLightningFeePpm: 10_000,
	minLightningFeeSat: 10n,
	paymentTimeoutSeconds: 600,
	statusPollMs: 10_000,
	chainPollMs: 15_000,
	replyTimeoutMs: 15_000,
	invoiceFinalCltvBlocks: 40,
	routeBudgetBlocks: 12,
	invoiceExpirySeconds: 21_600,
	maxRefundFeeSat: 10_000n,
	refundConfirmations: 1,
	maxProviderFundingConfirmations: 12,
	submarineFeeSlackSat: 100n
};

export function resolvePolicy(
	overrides: Partial<ISwapClientPolicy> = {}
): ISwapClientPolicy {
	const policy = { ...SWAP_DEFAULT_POLICY, ...overrides };
	if (
		!Number.isInteger(policy.minFundingConfirmations) ||
		policy.minFundingConfirmations < 1
	) {
		throw new SwapError(
			'minFundingConfirmations must be at least 1: a claim reveals the preimage',
			'policy'
		);
	}
	if (
		policy.minRefundDeltaBlocks < 1 ||
		policy.maxRefundDeltaBlocks < policy.minRefundDeltaBlocks
	) {
		throw new SwapError(
			'refund delta bounds must satisfy 1 <= min <= max',
			'policy'
		);
	}
	if (
		!Number.isInteger(policy.invoiceFinalCltvBlocks) ||
		policy.invoiceFinalCltvBlocks < 18
	) {
		throw new SwapError('invoiceFinalCltvBlocks must be at least 18', 'policy');
	}
	if (
		!Number.isInteger(policy.routeBudgetBlocks) ||
		policy.routeBudgetBlocks < 0
	) {
		throw new SwapError(
			'routeBudgetBlocks must be a non-negative integer',
			'policy'
		);
	}
	if (
		!Number.isInteger(policy.refundConfirmations) ||
		policy.refundConfirmations < 1
	) {
		throw new SwapError('refundConfirmations must be at least 1', 'policy');
	}
	return policy;
}

export type ReverseSwapState =
	| 'CREATED'
	| 'PAYING'
	| 'FUNDED'
	| 'CLAIM_BROADCAST'
	| 'CLAIMED'
	| 'PAYMENT_FAILED'
	| 'EXPIRED';

export function isTerminalReverseSwapState(state: ReverseSwapState): boolean {
	return (
		state === 'CLAIMED' || state === 'PAYMENT_FAILED' || state === 'EXPIRED'
	);
}

export interface IReverseSwapClaimAttempt {
	txidHex: string;
	rawHex: string;
	feeSat: string;
	feeRateSatPerVb: number;
	builtAt: number;
	broadcastAt?: number;
	broadcastHeight?: number;
}

/**
 * One swap as this device knows it. A claim after a crash needs the claim
 * key and the preimage and nothing else, so the record holds them, unless
 * `secrets` names the host provider that derives them instead. Bigints are
 * decimal strings and buffers hex, so the record is plain JSON.
 */
export interface IReverseSwapRecord {
	version: 1;
	swapIdHex: string;
	providerNodeIdHex: string;
	network: RouxNetwork;
	createdAt: number;
	createdHeight: number;
	paymentHashHex: string;
	/** Absent when `secrets` is set: derived on demand instead. */
	preimageHex?: string;
	claimPrivkeyHex?: string;
	/** Set when the host's wallet keeps the two above. */
	secrets?: ISwapRecordSecrets;
	claimPubkeyHex: string;
	refundPubkeyHex: string;
	refundHeight: number;
	htlcAddress: string;
	htlcOutputScriptHex: string;
	onchainAmountSat: string;
	invoiceAmountMsat: string;
	totalFeeSat: string;
	bolt11: string;
	invoiceExpiresAt: number;
	providerFundingConfirmations: number;
	destinationScriptHex: string;
	state: ReverseSwapState;
	payment?: {
		startedAt: number;
		status: ISwapPaymentStatus['status'];
		preimageHex?: string;
		failureReason?: string;
	};
	funding?: {
		txidHex: string;
		vout: number;
		valueSat: string;
		firstSeenHeight: number;
		confirmedHeight?: number;
	};
	claim?: {
		attempts: IReverseSwapClaimAttempt[];
		confirmedTxidHex?: string;
		confirmedHeight?: number;
	};
	resolution?: { kind: 'claim' | 'refund' | 'other'; txidHex: string };
	/** Set when the first claim was refused for being past the deadline. */
	claimDeadlinePassedAt?: number;
	lastError?: string;
	updatedAt: number;
}

export type SwapErrorCode =
	| 'policy'
	| 'provider_declined'
	| 'ack_mismatch'
	| 'refund_too_soon'
	| 'refund_too_late'
	| 'not_configured'
	| 'funding_invalid'
	| 'destination'
	| 'fee'
	| 'timeout'
	| 'deadline'
	| 'funding_unconfirmed'
	| 'storage'
	| 'state'
	| 'secrets'
	// Submarine swaps.
	| 'invoice'
	| 'cltv_unsafe'
	| 'refund_blocked'
	| 'already_funded';

export class SwapError extends Error {
	constructor(
		message: string,
		readonly code: SwapErrorCode
	) {
		super(message);
		this.name = 'SwapError';
	}
}

/** A swap moved from one state to another; the record is the new one. */
export interface IReverseSwapChange {
	swapIdHex: string;
	from: ReverseSwapState;
	to: ReverseSwapState;
	record: IReverseSwapRecord;
}

// ─────────────── Submarine swaps (on-chain to Lightning) ───────────────

/**
 *   CREATED          terms verified, refund key persisted, no coins moved
 *   FUNDING          a funding outpoint is recorded and verified, below the
 *                    provider's depth
 *   FUNDED           at the provider's depth: it may pay now
 *   SETTLED          terminal: our invoice was paid (or the output was
 *                    claimed with a valid preimage)
 *   REFUND_BROADCAST a refund attempt is persisted and out
 *   REFUNDED         terminal: a refund attempt confirmed
 *   CANCELLED        terminal: never funded and the window closed
 *
 * There is no PAYING: the provider paying shows as the invoice being
 * `accepted`, a fact on the record that can flip back to open.
 */
export type SubmarineSwapState =
	| 'CREATED'
	| 'FUNDING'
	| 'FUNDED'
	| 'SETTLED'
	| 'REFUND_BROADCAST'
	| 'REFUNDED'
	| 'CANCELLED';

export function isTerminalSubmarineSwapState(
	state: SubmarineSwapState
): boolean {
	return state === 'SETTLED' || state === 'REFUNDED' || state === 'CANCELLED';
}

/** A refund attempt has the same shape as a claim attempt. */
export type ISubmarineSwapRefundAttempt = IReverseSwapClaimAttempt;

/**
 * One submarine swap as this device knows it. A refund after a crash needs
 * the refund private key, so the record holds it unless `secrets` names the
 * host provider that derives it instead. No preimage either way: the
 * invoice is the node's, and the provider learns the preimage by paying it.
 */
export interface ISubmarineSwapRecord {
	version: 1;
	swapIdHex: string;
	providerNodeIdHex: string;
	network: RouxNetwork;
	createdAt: number;
	createdHeight: number;
	paymentHashHex: string;
	/** Absent when `secrets` is set: derived on demand instead. */
	refundPrivkeyHex?: string;
	/** Set when the host's wallet keeps the refund key. */
	secrets?: ISwapRecordSecrets;
	refundPubkeyHex: string;
	claimPubkeyHex: string;
	refundHeight: number;
	htlcAddress: string;
	htlcOutputScriptHex: string;
	/** What we lock. */
	onchainAmountSat: string;
	/** (onchainAmountSat - totalFeeSat) * 1000: our invoice. */
	invoiceAmountMsat: string;
	totalFeeSat: string;
	minerFeeSat: string;
	bolt11: string;
	invoiceExpiresAt: number;
	invoiceFinalCltv: number;
	invoiceSource: 'minted' | 'supplied';
	providerFundingConfirmations: number;
	/** The provider stops watching for funding after this (unix seconds). */
	providerExpiresAt: number;
	/** Informational: the provider's absolute HTLC expiry ceiling. */
	paymentCeilingHeight?: number;
	refundDestinationScriptHex: string;
	state: SubmarineSwapState;
	invoice?: {
		state: ISwapInvoiceStatus['state'];
		preimageHex?: string;
		htlcsInFlight?: number;
		checkedAt: number;
		acceptedSeenAt?: number;
	};
	/** Persisted BEFORE the funder is asked; a retry needs the operator. */
	fundingAttempt?: {
		requestedAt: number;
		label: string;
		txidHex?: string;
		error?: string;
	};
	funding?: {
		txidHex: string;
		vout: number;
		valueSat: string;
		firstSeenHeight: number;
		confirmedHeight?: number;
		source: 'funder' | 'attached' | 'discovered';
	};
	refund?: {
		attempts: ISubmarineSwapRefundAttempt[];
		confirmedTxidHex?: string;
		confirmedHeight?: number;
	};
	resolution?: {
		kind: 'settled' | 'refund' | 'claim' | 'other';
		txidHex?: string;
	};
	settledBy?: 'invoice' | 'chain';
	/** Why a due refund was last withheld. */
	refundBlockedReason?: string;
	lastError?: string;
	updatedAt: number;
}

export interface ISubmarineSwapChange {
	swapIdHex: string;
	from: SubmarineSwapState;
	to: SubmarineSwapState;
	record: ISubmarineSwapRecord;
}
