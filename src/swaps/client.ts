/**
 * Swaps against a beignet provider, the client's front door.
 *
 *   quote()            SWAP_QUOTE_REQUEST (48) -> SWAP_QUOTE (49), link only,
 *                      either direction
 *   reverse.create()   SWAP_CREATE (50) -> SWAP_CREATE_ACK (51); the ack is
 *                      verified (the contract rebuilt from OUR hash and key,
 *                      the invoice decoded, the fee and refund window inside
 *                      policy) and only then a CREATED record is persisted.
 *                      Nothing is paid here.
 *   reverse.run()      create, pay, and follow the swap to its end.
 *   reverse.resume()   after a restart: every unresolved record re-checked.
 *   submarine.*        the other direction (submarine-client.ts): our
 *                      invoice, the provider's claim key, our funding, our
 *                      refund.
 */

import crypto from 'crypto';
import { crypto as bcrypto, message, swaps } from 'beignet/lightning';
import {
	RouxLog,
	RouxNetwork,
	Sats,
	assertPubkeyHex,
	noopLog,
	toSats
} from '../types';
import { IPeerLink } from '../link/types';
import { exchange } from '../link/exchange';
import {
	EphemeralStorageError,
	IWalletDataStorage,
	MemoryStorage
} from '../storage';
import { ReverseSwapStore } from './store';
import { ReverseSwap } from './reverse';
import { SubmarineSwapClient } from './submarine-client';
import {
	assertNativeSegwit,
	submarineCltvProblem,
	verifyReverseAck
} from './verify';
import {
	IReverseSwapChange,
	IReverseSwapRecord,
	ISwapChain,
	ISwapClientPolicy,
	ISwapFunder,
	ISwapLightningPayer,
	SwapError,
	isTerminalReverseSwapState,
	resolvePolicy
} from './types';

export interface ISwapClientOptions {
	link: IPeerLink;
	network: RouxNetwork;
	payer?: ISwapLightningPayer;
	/** Sends a submarine swap's coins; omit to fund by hand (attachFunding). */
	funder?: ISwapFunder;
	chain?: ISwapChain;
	storage?: IWalletDataStorage;
	/**
	 * Refuse to create a swap whose record would live in ephemeral storage
	 * (BeignetClient sets this when `storage` was defaulted and not allowed).
	 */
	refuseEphemeralStorage?: boolean;
	policy?: Partial<ISwapClientPolicy>;
	/** Where claims go when a swap names no destination; falls back to the payer's wallet. */
	destination?: () => Promise<Buffer>;
	log?: RouxLog;
}

export interface ISwapQuoteParams {
	/** reverse: Lightning to on-chain; submarine: on-chain to Lightning. */
	direction: 'reverse' | 'submarine';
	/** On-chain amount (received for reverse, locked for submarine); 0 asks for limits only. */
	amountSat?: Sats;
	timeoutMs?: number;
}

export interface ISwapQuoteResult {
	direction: 'reverse' | 'submarine';
	accepted: boolean;
	reason?: string;
	flatFeeSat: bigint;
	feePpm: number;
	minSwapSat: bigint;
	maxSwapSat: bigint;
	refundDeltaBlocks: number;
	fundingConfirmations: number;
	invoiceExpirySeconds: number;
	/** On this amount: the fee, and the invoice the provider would mint. */
	totalFeeSat: bigint;
	minerFeeSat: bigint;
	invoiceAmountMsat: bigint;
	/** Whether this client's policy would accept such terms. */
	withinPolicy: boolean;
}

export interface IReverseSwapCreateParams {
	/** On-chain amount to receive (sat). */
	amountSat: Sats;
	/** The most to pay above the amount (sat); default 3% plus 1000. */
	maxTotalFeeSat?: Sats;
	/** 32-byte claim private key; random unless given. */
	claimKey?: Buffer;
	/** 32-byte preimage; random unless given. */
	preimage?: Buffer;
	/** Native-segwit output script the claim pays; default the payer's wallet. */
	destinationScript?: Buffer;
	timeoutMs?: number;
}

export interface IResumeReport {
	resumed: ReverseSwap[];
	needsPayment: ReverseSwap[];
	terminal: number;
	errors: Array<{ swapIdHex: string; error: string }>;
}

export class SwapClient {
	readonly reverse: ReverseSwapClient;
	readonly submarine: SubmarineSwapClient;
	private readonly log: RouxLog;
	private readonly policy: ISwapClientPolicy;

	constructor(private readonly options: ISwapClientOptions) {
		this.log = options.log ?? noopLog;
		this.policy = resolvePolicy(options.policy);
		this.reverse = new ReverseSwapClient(options, this.policy, this.log);
		this.submarine = new SubmarineSwapClient(options, this.policy, this.log);
	}

	async quote(
		providerPubkeyHex: string,
		params: ISwapQuoteParams
	): Promise<ISwapQuoteResult> {
		const peer = assertPubkeyHex(providerPubkeyHex, 'provider pubkey');
		if (params.direction !== 'reverse' && params.direction !== 'submarine') {
			throw new SwapError(
				'direction must be "reverse" or "submarine"',
				'policy'
			);
		}
		const submarine = params.direction === 'submarine';
		const amountSat = toSats(params.amountSat ?? 0, 'amountSat');
		const requestId = crypto.randomBytes(8);
		const q = await exchange(this.options.link, {
			peerHex: peer,
			requestSubtype: message.BeignetCustomSubtype.SWAP_QUOTE_REQUEST,
			requestPayload: swaps.encodeSwapQuoteRequest({
				requestId,
				direction: submarine
					? swaps.SwapWireDirection.SUBMARINE
					: swaps.SwapWireDirection.REVERSE,
				amountSat
			}),
			replySubtype: message.BeignetCustomSubtype.SWAP_QUOTE,
			requestId,
			decode: swaps.decodeSwapQuote,
			timeoutMs: params.timeoutMs ?? this.policy.replyTimeoutMs,
			timeoutMessage: 'provider did not answer the swap quote'
		});
		let withinPolicy =
			q.accepted &&
			q.refundDeltaBlocks >= this.policy.minRefundDeltaBlocks &&
			q.refundDeltaBlocks <= this.policy.maxRefundDeltaBlocks;
		if (withinPolicy && submarine) {
			// The invoice we would mint must fit the provider's window.
			withinPolicy =
				submarineCltvProblem({
					currentHeight: 0,
					refundHeight: q.refundDeltaBlocks,
					fundingConfirmations: q.fundingConfirmations,
					invoiceMinFinalCltv: this.policy.invoiceFinalCltvBlocks,
					policy: this.policy
				}) === null &&
				q.fundingConfirmations <= this.policy.maxProviderFundingConfirmations;
		}
		this.log('swap_quote', {
			provider: peer,
			direction: params.direction,
			accepted: q.accepted,
			totalFeeSat: q.totalFeeSat.toString()
		});
		return {
			direction: params.direction,
			accepted: q.accepted,
			reason: q.accepted
				? undefined
				: `${swaps.SwapRefusalReason[q.reason]}${
						q.reasonText ? `: ${q.reasonText}` : ''
				  }`,
			flatFeeSat: q.flatFeeSat,
			feePpm: q.feePpm,
			minSwapSat: q.minSwapSat,
			maxSwapSat: q.maxSwapSat,
			refundDeltaBlocks: q.refundDeltaBlocks,
			fundingConfirmations: q.fundingConfirmations,
			invoiceExpirySeconds: q.invoiceExpirySeconds,
			totalFeeSat: q.totalFeeSat,
			minerFeeSat: q.minerFeeSat,
			invoiceAmountMsat: q.invoiceAmountMsat,
			withinPolicy
		};
	}

	async stop(): Promise<void> {
		await Promise.all([this.reverse.stop(), this.submarine.stop()]);
	}
}

export class ReverseSwapClient {
	private readonly store: ReverseSwapStore;
	private readonly live = new Map<string, ReverseSwap>();
	private readonly listeners = new Set<(change: IReverseSwapChange) => void>();

	constructor(
		private readonly options: ISwapClientOptions,
		private readonly policy: ISwapClientPolicy,
		private readonly log: RouxLog
	) {
		this.store = new ReverseSwapStore(options.storage ?? new MemoryStorage());
	}

	private deps(): { payer: ISwapLightningPayer; chain: ISwapChain } {
		const missing = [
			!this.options.payer
				? 'payer (LndPayer, ClnPayer or your own ISwapLightningPayer)'
				: null,
			!this.options.chain
				? 'chain (BitcoinCoreChain, ElectrumChain or your own ISwapChain)'
				: null
		].filter((m): m is string => m !== null);
		if (missing.length > 0) {
			throw new SwapError(
				`reverse swaps need ${missing.join(' and ')}`,
				'not_configured'
			);
		}
		return { payer: this.options.payer!, chain: this.options.chain! };
	}

	private wrap(record: IReverseSwapRecord): ReverseSwap {
		const existing = this.live.get(record.swapIdHex);
		if (existing) return existing;
		const { payer, chain } = this.deps();
		const swap = new ReverseSwap(record, {
			link: this.options.link,
			payer,
			chain,
			store: this.store,
			policy: this.policy,
			log: this.log,
			notify: (change) => {
				for (const cb of this.listeners) cb(change);
			}
		});
		this.live.set(record.swapIdHex, swap);
		return swap;
	}

	list(): ReverseSwap[] {
		return this.store.list().map((r) => this.wrap(r));
	}

	get(swapIdHex: string): ReverseSwap | null {
		const r = this.store.get(swapIdHex);
		return r ? this.wrap(r) : null;
	}

	/**
	 * Open a swap: verified terms, persisted CREATED, nothing paid. The
	 * destination is resolved now so a claim after a crash needs no wallet.
	 */
	async create(
		providerPubkeyHex: string,
		params: IReverseSwapCreateParams
	): Promise<ReverseSwap> {
		const peer = assertPubkeyHex(providerPubkeyHex, 'provider pubkey');
		const { payer, chain } = this.deps();
		if (this.options.refuseEphemeralStorage) {
			throw new EphemeralStorageError(
				'a reverse swap (its claim key and preimage)'
			);
		}
		const amountSat = toSats(params.amountSat, 'amountSat');
		if (amountSat <= 0n)
			throw new SwapError('amountSat must be positive', 'policy');
		const maxTotalFeeSat =
			params.maxTotalFeeSat !== undefined
				? toSats(params.maxTotalFeeSat, 'maxTotalFeeSat')
				: amountSat / 33n + 1_000n;
		const preimage = params.preimage ?? crypto.randomBytes(32);
		if (preimage.length !== 32)
			throw new SwapError('preimage must be 32 bytes', 'policy');
		const claimKey = params.claimKey ?? crypto.randomBytes(32);
		if (!bcrypto.isValidPrivateKey(claimKey))
			throw new SwapError('claimKey is not a valid scalar', 'policy');
		const paymentHash = crypto.createHash('sha256').update(preimage).digest();
		if (this.store.has(paymentHash.toString('hex'))) {
			throw new SwapError(
				'a swap with this payment hash already exists',
				'state'
			);
		}
		const claimPubkey = bcrypto.getPublicKey(claimKey);
		const currentHeight = await chain.currentHeight();
		if (!(currentHeight > 0))
			throw new SwapError('chain height unknown', 'not_configured');

		const requestId = crypto.randomBytes(8);
		const create: swaps.ISwapCreate = {
			requestId,
			direction: swaps.SwapWireDirection.REVERSE,
			paymentHash,
			claimPubkey,
			onchainAmountSat: amountSat,
			maxTotalFeeSat
		};
		const ack = await exchange(this.options.link, {
			peerHex: peer,
			requestSubtype: message.BeignetCustomSubtype.SWAP_CREATE,
			requestPayload: swaps.encodeSwapCreate(create),
			replySubtype: message.BeignetCustomSubtype.SWAP_CREATE_ACK,
			requestId,
			decode: swaps.decodeSwapCreateAck,
			timeoutMs: params.timeoutMs ?? this.policy.replyTimeoutMs,
			timeoutMessage: 'provider did not answer the swap create'
		});
		let terms;
		try {
			terms = verifyReverseAck({
				create,
				ack,
				currentHeight,
				network: this.options.network,
				policy: this.policy,
				maxTotalFeeSat
			});
		} catch (err) {
			this.log('swap_ack_rejected', {
				provider: peer,
				code: err instanceof SwapError ? err.code : 'unknown',
				error: err instanceof Error ? err.message : String(err)
			});
			throw err;
		}
		let destination: Buffer;
		if (params.destinationScript) {
			destination = assertNativeSegwit(params.destinationScript);
		} else if (this.options.destination) {
			destination = assertNativeSegwit(await this.options.destination());
		} else if (payer.newDestinationScript) {
			destination = assertNativeSegwit(await payer.newDestinationScript());
		} else {
			throw new SwapError(
				'no claim destination: pass destinationScript or a payer that hands out addresses',
				'destination'
			);
		}
		const record: IReverseSwapRecord = {
			version: 1,
			swapIdHex: ack.terms!.swapId.toString('hex'),
			providerNodeIdHex: peer,
			network: this.options.network,
			createdAt: Date.now(),
			createdHeight: currentHeight,
			paymentHashHex: paymentHash.toString('hex'),
			preimageHex: preimage.toString('hex'),
			claimPrivkeyHex: claimKey.toString('hex'),
			claimPubkeyHex: claimPubkey.toString('hex'),
			refundPubkeyHex: terms.htlc.refundPublicKey.toString('hex'),
			refundHeight: terms.htlc.refundHeight,
			htlcAddress: terms.address,
			htlcOutputScriptHex: terms.outputScript.toString('hex'),
			onchainAmountSat: amountSat.toString(),
			invoiceAmountMsat: terms.invoiceAmountMsat.toString(),
			totalFeeSat: terms.totalFeeSat.toString(),
			bolt11: ack.terms!.bolt11,
			invoiceExpiresAt: terms.invoiceExpiresAt,
			providerFundingConfirmations: ack.terms!.fundingConfirmations,
			destinationScriptHex: destination.toString('hex'),
			state: 'CREATED',
			updatedAt: Date.now()
		};
		const stored = this.store.upsert(record);
		this.log('swap_created', {
			swapId: stored.swapIdHex,
			provider: peer,
			amountSat: amountSat.toString(),
			totalFeeSat: terms.totalFeeSat.toString(),
			refundHeight: terms.htlc.refundHeight,
			address: terms.address
		});
		return this.wrap(stored);
	}

	/** create, pay and follow the swap to its terminal state. */
	async run(
		providerPubkeyHex: string,
		params: IReverseSwapCreateParams,
		payOpts: { maxFeeSat?: bigint } = {}
	): Promise<IReverseSwapRecord> {
		const swap = await this.create(providerPubkeyHex, params);
		return swap.run(payOpts);
	}

	/**
	 * After a restart: every record is re-checked against the node and the
	 * chain. A CREATED record whose payment the node knows nothing about is
	 * reported, and paid only when asked (`pay: true`); `run: true` starts
	 * the loops for everything unresolved.
	 */
	async resume(
		opts: { pay?: boolean; run?: boolean } = {}
	): Promise<IResumeReport> {
		const report: IResumeReport = {
			resumed: [],
			needsPayment: [],
			terminal: 0,
			errors: []
		};
		for (const record of this.store.restore()) {
			if (isTerminalReverseSwapState(record.state)) {
				report.terminal++;
				continue;
			}
			const swap = this.wrap(record);
			try {
				if (record.state === 'CREATED') {
					const { payer, chain } = this.deps();
					const known = await payer.trackPayment(
						Buffer.from(record.paymentHashHex, 'hex')
					);
					const tip = await chain.currentHeight();
					if (known.status === 'unknown') {
						if (tip > record.refundHeight) {
							swap.markExpired();
							report.terminal++;
							continue;
						}
						if (opts.pay) void swap.pay();
						else {
							report.needsPayment.push(swap);
							continue;
						}
					} else {
						// Crashed between the record and the PAYING mark.
						swap.adoptPayment(known);
					}
				}
				await swap.tick();
				if (opts.run && !isTerminalReverseSwapState(swap.state))
					void swap.run();
				report.resumed.push(swap);
			} catch (err) {
				report.errors.push({
					swapIdHex: record.swapIdHex,
					error: err instanceof Error ? err.message : String(err)
				});
			}
		}
		return report;
	}

	/**
	 * Watch every swap this client drives: one call per persisted state
	 * change, with the new record. Returns the unsubscribe.
	 */
	onChange(cb: (change: IReverseSwapChange) => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	/** Park every live swap; resolves once their passes in flight finished. */
	async stop(): Promise<void> {
		await Promise.all([...this.live.values()].map((swap) => swap.stop()));
	}
}
