/**
 * Third-party direct funding, payer side, against a beignet receiver.
 *
 * A beignet wallet that wants inbound liquidity mints a signed REQUEST and
 * hands it out inside a BIP 21 URI (`bgnq=` parameter). Anyone holding an
 * on-chain coin can pay it: instead of sending to an address, the payer's
 * coin becomes an input of the receiver's channel funding transaction, so
 * one on-chain payment delivers both the money and the channel. The payer
 * signs only after verifying, in the exact bytes it signs, that its coin
 * funds a channel output the receiver's node key attested, that its change
 * comes back to its own script, and that its cost stays inside the ceiling
 * it set. This is the LFBW protocol (rev 2), beignet issues #610 to #613.
 *
 *   payer (you)                          beignet receiver
 *     │  DIRECT_FUNDING_OFFER (16)          │  coin, amount, fee ceiling,
 *     ├───────────────────────────────────>│  ownership proof
 *     │<── DIRECT_FUNDING_OFFER_ACK (17) ───┤
 *     │<── DIRECT_FUNDING_SIGN_REQUEST (18)─┤  negotiated tx + attestation
 *     │  verify, then                       │
 *     │  DIRECT_FUNDING_WITNESS (19)        │
 *     ├───────────────────────────────────>│  broadcasts
 *     │<── DIRECT_FUNDING_RECEIPT (21) ─────┤  preimage of the receipt hash
 *
 * Every frame is sealed to a per-request key, so the lane it rides carries
 * bytes it cannot read. roux serves two of beignet's three lanes: a direct
 * peer connection to the receiver, and a blind relay through the receiver's
 * LSP. The onion-message lane needs a BOLT 12 onion stack roux does not
 * carry; a request that offers ONLY that lane is reported unreachable.
 *
 * The engine itself is beignet's (`DirectFundingSender`), unchanged: what
 * roux adds is a link to run it over and a wallet to give it coins.
 */

import { directFunding } from 'beignet/lightning';
import {
	RouxLog,
	RouxNetwork,
	Sats,
	noopLog,
	toBeignetNetwork,
	toSats
} from '../types';
import { IPeerLink } from '../link/types';
import {
	EphemeralStorageError,
	IWalletDataStorage,
	MemoryStorage
} from '../storage';

export type DirectFundingError = directFunding.DirectFundingError;
export const DirectFundingErrorCode = directFunding.DirectFundingErrorCode;
export type DirectFundingErrorCode = directFunding.DirectFundingErrorCode;

export interface IDirectFundingClientOptions {
	link: IPeerLink;
	network: RouxNetwork;
	/** The coins to pay with, and how to sign them. */
	wallet: directFunding.IDfSenderWallet;
	/** Where payment records live (default: this process only). */
	storage?: IWalletDataStorage;
	/**
	 * Refuse to pay when the payment record would live in ephemeral storage
	 * (BeignetClient sets this when `storage` was defaulted and not allowed).
	 */
	refuseEphemeralStorage?: boolean;
	/** Engine tuning: fee ceiling default, resend schedule, timeouts. */
	sender?: directFunding.IDfSenderConfig;
	log?: RouxLog;
}

export interface IDirectFundingTransportInfo {
	type:
		| 'direct_peer'
		| 'onion_message'
		| 'lsp_relay'
		| 'rendezvous'
		| 'unknown';
	/** Whether roux can carry frames over this lane. */
	supported: boolean;
	host?: string;
	port?: number;
	/** LSP relay only. */
	relayNodeIdHex?: string;
}

/** A request, decoded and verified, before any network activity. */
export interface IDirectFundingRequestInfo {
	requestIdHex: string;
	receiverNodeIdHex: string;
	/** Milliseconds since epoch. */
	expiresAt: number;
	/** Present when the receiver fixed the amount. */
	amountSat?: bigint;
	receiptHashHex: string;
	transports: IDirectFundingTransportInfo[];
	/** At least one lane roux can use. */
	reachable: boolean;
	/** The bare envelope, with the BIP 21 wrapper stripped. */
	encoded: string;
}

export interface IPayRequestOptions {
	/** Required when the request fixes no amount, refused when it fixes one. */
	amountSat?: Sats;
	/** Ceiling on your own cost above the amount (default 1 000 sat). */
	maxTotalFeeSat?: Sats;
}

export type IDirectFundingResult = directFunding.IDfSendResult;
export type IDirectFundingPayment = directFunding.IDfPaymentRecord;

export class DirectFundingClient {
	private readonly sender: directFunding.DirectFundingSender;
	private readonly store: directFunding.DirectFundingPaymentStore;
	private readonly registry: directFunding.DfTransportRegistry;
	private readonly chainHash: Buffer;
	private readonly log: RouxLog;
	private started = false;

	private readonly wallet: directFunding.IDfSenderWallet;

	private readonly refuseEphemeralStorage: boolean;
	constructor(options: IDirectFundingClientOptions) {
		this.refuseEphemeralStorage = options.refuseEphemeralStorage === true;
		this.log = options.log ?? noopLog;
		this.wallet = options.wallet;
		this.chainHash = directFunding.chainHashForNetwork(
			toBeignetNetwork(options.network)
		);
		const link = options.link;
		const stack = directFunding.createDirectFundingTransports(
			{
				peers: link,
				nodeId: (): Buffer => Buffer.from(link.nodeIdHex(), 'hex')
			},
			{ directPeer: true, relay: true, onion: false, relayServer: false },
			this.log
		);
		this.registry = stack.registry;
		this.store = new directFunding.DirectFundingPaymentStore({
			storage: options.storage ?? new MemoryStorage()
		});
		this.store.restore();
		this.sender = new directFunding.DirectFundingSender(
			{
				wallet: options.wallet,
				registry: this.registry,
				payments: this.store,
				chainHash: (): Buffer => this.chainHash,
				log: this.log
			},
			options.sender
		);
	}

	/**
	 * Arm the reconciliation sweep: records whose witness left the device are
	 * checked against the wallet until the funding confirms or a conflicting
	 * spend does. Call once per process; `pay` calls it for you.
	 */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.sender.start();
	}

	stop(): void {
		this.started = false;
		this.sender.stop();
		this.registry.destroy();
	}

	/**
	 * Decode and verify a request without touching the network: expiry,
	 * signature, signer identity, chain. Throws a `DirectFundingError` with
	 * a code for each of those refusals. Accepts a whole BIP 21 URI or the
	 * bare envelope.
	 */
	inspect(requestOrUri: string): IDirectFundingRequestInfo {
		const encoded = extractRequest(requestOrUri);
		const env = directFunding.decodeAndVerifyRequestEnvelope(encoded, {
			expectedChainHash: this.chainHash
		});
		const transports = env.transports.map(describeTransport);
		const info: IDirectFundingRequestInfo = {
			requestIdHex: env.requestId.toString('hex'),
			receiverNodeIdHex: env.receiverNodeId.toString('hex'),
			expiresAt: env.expiresAt,
			receiptHashHex: env.receiptHash.toString('hex'),
			transports,
			reachable: transports.some((t) => t.supported),
			encoded
		};
		if (env.amountSat !== undefined) info.amountSat = env.amountSat;
		return info;
	}

	/** What a payment of this request would cost at most, without starting one. */
	quote(
		requestOrUri: string,
		opts: IPayRequestOptions = {}
	): {
		amountSat: bigint;
		maxTotalFeeSat: bigint;
	} {
		return this.sender.quote(extractRequest(requestOrUri), sendOptions(opts));
	}

	/**
	 * Pay the request by funding the receiver's channel from one of our coins.
	 *
	 * Rejects only BEFORE the witness leaves the device; in every rejecting
	 * path no funding witness was released. A signer may have produced a
	 * local signature that was discarded. Once the witness is
	 * out the call resolves whatever happens next, with `caveat` set if the
	 * receipt did not arrive: the payment is chain-atomic by then. A second
	 * call for the same request replays the first outcome rather than
	 * paying again.
	 */
	async pay(
		requestOrUri: string,
		opts: IPayRequestOptions = {}
	): Promise<IDirectFundingResult> {
		if (this.refuseEphemeralStorage) {
			throw new EphemeralStorageError('a direct-funding payment (its record)');
		}
		await this.refreshWallet();
		this.start();
		return this.sender.send(extractRequest(requestOrUri), sendOptions(opts));
	}

	/** Every payment this device has a record of. */
	payments(): IDirectFundingPayment[] {
		return this.sender.payments();
	}

	/** Reconcile in-flight records against the wallet now. */
	async reconcile(): Promise<void> {
		await this.refreshWallet();
		return this.sender.reconcile();
	}

	/**
	 * A wallet that works from a snapshot of a remote node (`LndWallet`)
	 * exposes `refresh`; the engine's reads are synchronous, so the snapshot
	 * is taken right before it runs.
	 */
	private async refreshWallet(): Promise<void> {
		const wallet = this.wallet as { refresh?: () => Promise<void> };
		await wallet.refresh?.();
	}

	/** Sends running right now. */
	inFlight(): number {
		return this.sender.inFlight();
	}
}

/** The bare envelope from a BIP 21 URI, or the input itself when it is one. */
export function extractRequest(requestOrUri: string): string {
	const trimmed = requestOrUri.trim();
	if (/^bitcoin:/i.test(trimmed)) {
		const found = directFunding.requestFromBip21(trimmed);
		if (!found) {
			throw new directFunding.DirectFundingError(
				directFunding.DirectFundingErrorCode.MALFORMED,
				`the BIP 21 URI carries no ${directFunding.DF_BIP21_PARAM} direct-funding request`
			);
		}
		return found;
	}
	return trimmed;
}

function sendOptions(opts: IPayRequestOptions): directFunding.IDfSendOptions {
	const out: directFunding.IDfSendOptions = {};
	if (opts.amountSat !== undefined)
		out.amountSat = toSats(opts.amountSat, 'amountSat');
	if (opts.maxTotalFeeSat !== undefined) {
		out.maxTotalFeeSat = toSats(opts.maxTotalFeeSat, 'maxTotalFeeSat');
	}
	return out;
}

function describeTransport(
	t: directFunding.DfTransportDescriptor
): IDirectFundingTransportInfo {
	if (directFunding.isUnknownTransport(t)) {
		return {
			type:
				t.type === directFunding.DfTransportType.RENDEZVOUS
					? 'rendezvous'
					: 'unknown',
			supported: false
		};
	}
	switch (t.type) {
		case directFunding.DfTransportType.DIRECT_PEER:
			return {
				type: 'direct_peer',
				supported: true,
				host: t.host,
				port: t.port
			};
		case directFunding.DfTransportType.LSP_RELAY:
			return {
				type: 'lsp_relay',
				supported: true,
				host: t.host,
				port: t.port,
				relayNodeIdHex: t.relayNodeId.toString('hex')
			};
		case directFunding.DfTransportType.ONION_MESSAGE:
			return {
				type: 'onion_message',
				supported: false,
				host: t.host,
				port: t.port
			};
		default:
			return { type: 'unknown', supported: false };
	}
}
