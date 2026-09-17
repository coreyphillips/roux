/**
 * Submarine swaps against a beignet provider (on-chain to Lightning).
 *
 *   quote (client.ts)   SWAP_QUOTE_REQUEST (48) with direction 2
 *   create()            the invoice minted on OUR node (or supplied by the
 *                       host), SWAP_SUBMARINE_CREATE (54) ->
 *                       SWAP_SUBMARINE_CREATE_ACK (55); the ack is verified
 *                       (the contract rebuilt from OUR refund key and the
 *                       provider's claim key, the invoice and amounts, the
 *                       refund window, the CLTV fit) and only then a CREATED
 *                       record is persisted. Nothing is funded here.
 *   run()               create, fund through the funder, follow to the end.
 *   resume()            after a restart: every record re-checked.
 */

import crypto from 'crypto';
import { crypto as bcrypto, message, swaps } from 'beignet/lightning';
import {
	RouxLog,
	RouxNetwork,
	Sats,
	assertPubkeyHex,
	toBeignetNetwork,
	toSats
} from '../types';
import { exchange } from '../link/exchange';
import { EphemeralStorageError, MemoryStorage } from '../storage';
import { SubmarineSwapStore } from './store';
import { SubmarineSwap } from './submarine';
import {
	assertNativeSegwit,
	decodeSuppliedInvoice,
	submarineCltvProblem,
	verifySubmarineAck
} from './verify';
import type { ISwapClientOptions } from './client';
import {
	ISubmarineSwapChange,
	ISubmarineSwapRecord,
	ISwapChain,
	ISwapClientPolicy,
	ISwapLightningPayer,
	SwapError,
	isTerminalSubmarineSwapState
} from './types';

export interface ISubmarineSwapCreateParams {
	/** On-chain amount to lock (sat); the invoice is this minus the fee. */
	amountSat: Sats;
	/**
	 * A bolt11 of the host's own node for exactly the quoted invoice amount.
	 * Omitted, the payer mints one.
	 */
	invoice?: string;
	/** The most to give up below the amount (sat); default 3% plus 1000. */
	maxTotalFeeSat?: Sats;
	/** 32-byte refund private key; random unless given. */
	refundKey?: Buffer;
	/** Native-segwit output script a refund pays; default the payer's wallet. */
	refundDestinationScript?: Buffer;
	timeoutMs?: number;
}

export interface ISubmarineResumeReport {
	resumed: SubmarineSwap[];
	/** CREATED records nothing was ever sent for. */
	needsFunding: SubmarineSwap[];
	/** CREATED records whose funding call was made and its reply lost. */
	fundingUnknown: SubmarineSwap[];
	terminal: number;
	errors: Array<{ swapIdHex: string; error: string }>;
}

export class SubmarineSwapClient {
	private readonly store: SubmarineSwapStore;
	private readonly live = new Map<string, SubmarineSwap>();
	private readonly listeners = new Set<
		(change: ISubmarineSwapChange) => void
	>();

	constructor(
		private readonly options: ISwapClientOptions,
		private readonly policy: ISwapClientPolicy,
		private readonly log: RouxLog
	) {
		this.store = new SubmarineSwapStore(options.storage ?? new MemoryStorage());
	}

	private deps(): { payer: ISwapLightningPayer; chain: ISwapChain } {
		const missing = [
			!this.options.payer
				? 'payer (LndPayer, ClnPayer or your own ISwapLightningPayer)'
				: null,
			this.options.payer && !this.options.payer.lookupInvoice
				? 'a payer that looks invoices up (lookupInvoice)'
				: null,
			!this.options.chain
				? 'chain (BitcoinCoreChain, ElectrumChain or your own ISwapChain)'
				: null
		].filter((m): m is string => m !== null);
		if (missing.length > 0) {
			throw new SwapError(
				`submarine swaps need ${missing.join(' and ')}`,
				'not_configured'
			);
		}
		return { payer: this.options.payer!, chain: this.options.chain! };
	}

	private wrap(record: ISubmarineSwapRecord): SubmarineSwap {
		const existing = this.live.get(record.swapIdHex);
		if (existing) return existing;
		const { payer, chain } = this.deps();
		const swap = new SubmarineSwap(record, {
			link: this.options.link,
			payer,
			funder: this.options.funder,
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

	list(): SubmarineSwap[] {
		return this.store.list().map((r) => this.wrap(r));
	}

	get(swapIdHex: string): SubmarineSwap | null {
		const r = this.store.get(swapIdHex);
		return r ? this.wrap(r) : null;
	}

	/**
	 * Open a swap: quoted, invoiced on our node, verified terms, persisted
	 * CREATED, nothing funded. The refund destination is resolved now so a
	 * refund after a crash needs no wallet.
	 */
	async create(
		providerPubkeyHex: string,
		params: ISubmarineSwapCreateParams
	): Promise<SubmarineSwap> {
		const peer = assertPubkeyHex(providerPubkeyHex, 'provider pubkey');
		const { payer, chain } = this.deps();
		if (this.options.refuseEphemeralStorage) {
			throw new EphemeralStorageError('a submarine swap (its refund key)');
		}
		const amountSat = toSats(params.amountSat, 'amountSat');
		if (amountSat <= 0n)
			throw new SwapError('amountSat must be positive', 'policy');
		const maxTotalFeeSat =
			params.maxTotalFeeSat !== undefined
				? toSats(params.maxTotalFeeSat, 'maxTotalFeeSat')
				: amountSat / 33n + 1_000n;
		const refundKey = params.refundKey ?? crypto.randomBytes(32);
		if (!bcrypto.isValidPrivateKey(refundKey))
			throw new SwapError('refundKey is not a valid scalar', 'policy');
		const refundPubkey = bcrypto.getPublicKey(refundKey);
		const currentHeight = await chain.currentHeight();
		if (!(currentHeight > 0))
			throw new SwapError('chain height unknown', 'not_configured');
		const timeoutMs = params.timeoutMs ?? this.policy.replyTimeoutMs;

		// The quote names the fee floor and the window the provider would
		// use; the invoice is minted for the amount minus that fee plus a
		// little slack so a fee estimate that moved between the two calls
		// cannot refuse the create.
		const quoteId = crypto.randomBytes(8);
		const q = await exchange(this.options.link, {
			peerHex: peer,
			requestSubtype: message.BeignetCustomSubtype.SWAP_QUOTE_REQUEST,
			requestPayload: swaps.encodeSwapQuoteRequest({
				requestId: quoteId,
				direction: swaps.SwapWireDirection.SUBMARINE,
				amountSat
			}),
			replySubtype: message.BeignetCustomSubtype.SWAP_QUOTE,
			requestId: quoteId,
			decode: swaps.decodeSwapQuote,
			timeoutMs,
			timeoutMessage: 'provider did not answer the swap quote'
		});
		if (!q.accepted) {
			throw new SwapError(
				`provider declined the quote: ${
					swaps.SwapRefusalReason[q.reason] ?? q.reason
				}${q.reasonText ? ` (${q.reasonText})` : ''}`,
				'provider_declined'
			);
		}
		const totalFeeSat = q.totalFeeSat + this.policy.submarineFeeSlackSat;
		if (totalFeeSat > maxTotalFeeSat) {
			throw new SwapError(
				`fee ${totalFeeSat} sat (quoted ${q.totalFeeSat} plus slack) exceeds the ${maxTotalFeeSat} sat ceiling`,
				'fee'
			);
		}
		if (totalFeeSat >= amountSat) {
			throw new SwapError('fee leaves nothing to receive', 'fee');
		}
		const invoiceAmountMsat = (amountSat - totalFeeSat) * 1000n;

		// The invoice: supplied and checked, or minted. Its final CLTV must
		// fit the window the quote describes, judged before anything is
		// minted or sent.
		let bolt11: string;
		let paymentHash: Buffer;
		let invoiceFinalCltv: number;
		let invoiceSource: ISubmarineSwapRecord['invoiceSource'];
		if (params.invoice) {
			const decoded = decodeSuppliedInvoice(params.invoice);
			if (decoded.network !== toBeignetNetwork(this.options.network)) {
				throw new SwapError('invoice is for another network', 'invoice');
			}
			if (decoded.amountMsat !== invoiceAmountMsat) {
				throw new SwapError(
					`invoice must be for exactly ${invoiceAmountMsat} msat (amount minus the ${totalFeeSat} sat fee), not ${decoded.amountMsat}`,
					'invoice'
				);
			}
			if (
				decoded.expiresAt * 1000 - Date.now() <
				q.invoiceExpirySeconds * 1000
			) {
				throw new SwapError(
					`invoice expires within the ${q.invoiceExpirySeconds} seconds the provider requires`,
					'invoice'
				);
			}
			if (this.store.has(decoded.paymentHash.toString('hex'))) {
				throw new SwapError(
					'a swap with this payment hash already exists',
					'state'
				);
			}
			const known = await payer.lookupInvoice!(decoded.paymentHash);
			if (known.state !== 'open') {
				throw new SwapError(
					`the node reports the invoice as ${known.state}; only an open invoice of this node can be swapped`,
					'invoice'
				);
			}
			bolt11 = params.invoice;
			paymentHash = decoded.paymentHash;
			invoiceFinalCltv = decoded.minFinalCltvExpiry;
			invoiceSource = 'supplied';
		} else {
			if (!payer.createInvoice) {
				throw new SwapError(
					'the payer cannot mint invoices (createInvoice); pass `invoice` instead',
					'not_configured'
				);
			}
			invoiceFinalCltv = this.policy.invoiceFinalCltvBlocks;
			const fit = submarineCltvProblem({
				currentHeight,
				refundHeight: currentHeight + q.refundDeltaBlocks,
				fundingConfirmations: q.fundingConfirmations,
				invoiceMinFinalCltv: invoiceFinalCltv,
				policy: this.policy
			});
			if (fit) throw new SwapError(fit, 'cltv_unsafe');
			const minted = await payer.createInvoice({
				amountMsat: invoiceAmountMsat,
				description: `submarine swap with ${peer.slice(0, 16)}`,
				expirySeconds: Math.max(
					this.policy.invoiceExpirySeconds,
					q.invoiceExpirySeconds * 2
				),
				minFinalCltvExpiry: invoiceFinalCltv
			});
			bolt11 = minted.bolt11;
			paymentHash = minted.paymentHash;
			invoiceSource = 'minted';
			const decoded = decodeSuppliedInvoice(bolt11);
			if (
				!decoded.paymentHash.equals(paymentHash) ||
				decoded.amountMsat !== invoiceAmountMsat
			) {
				throw new SwapError(
					'the node minted an invoice that does not match what was asked',
					'invoice'
				);
			}
			invoiceFinalCltv = decoded.minFinalCltvExpiry;
		}
		const fit = submarineCltvProblem({
			currentHeight,
			refundHeight: currentHeight + q.refundDeltaBlocks,
			fundingConfirmations: q.fundingConfirmations,
			invoiceMinFinalCltv: invoiceFinalCltv,
			policy: this.policy
		});
		if (fit) {
			this.orphaned(bolt11, invoiceSource, fit);
			throw new SwapError(fit, 'cltv_unsafe');
		}

		const requestId = crypto.randomBytes(8);
		const create: swaps.ISwapSubmarineCreate = {
			requestId,
			direction: swaps.SwapWireDirection.SUBMARINE,
			paymentHash,
			refundPubkey,
			bolt11,
			onchainAmountSat: amountSat,
			maxTotalFeeSat
		};
		let ack: swaps.ISwapSubmarineCreateAck;
		try {
			ack = await exchange(this.options.link, {
				peerHex: peer,
				requestSubtype: message.BeignetCustomSubtype.SWAP_SUBMARINE_CREATE,
				requestPayload: swaps.encodeSwapSubmarineCreate(create),
				replySubtype: message.BeignetCustomSubtype.SWAP_SUBMARINE_CREATE_ACK,
				requestId,
				decode: swaps.decodeSwapSubmarineCreateAck,
				timeoutMs,
				timeoutMessage: 'provider did not answer the submarine create'
			});
		} catch (err) {
			this.orphaned(bolt11, invoiceSource, String(err));
			throw err;
		}
		let terms;
		try {
			terms = verifySubmarineAck({
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
			this.orphaned(
				bolt11,
				invoiceSource,
				err instanceof Error ? err.message : String(err)
			);
			throw err;
		}
		let destination: Buffer;
		if (params.refundDestinationScript) {
			destination = assertNativeSegwit(params.refundDestinationScript);
		} else if (this.options.destination) {
			destination = assertNativeSegwit(await this.options.destination());
		} else if (payer.newDestinationScript) {
			destination = assertNativeSegwit(await payer.newDestinationScript());
		} else {
			throw new SwapError(
				'no refund destination: pass refundDestinationScript or a payer that hands out addresses',
				'destination'
			);
		}
		const record: ISubmarineSwapRecord = {
			version: 1,
			swapIdHex: ack.terms!.swapId.toString('hex'),
			providerNodeIdHex: peer,
			network: this.options.network,
			createdAt: Date.now(),
			createdHeight: currentHeight,
			paymentHashHex: paymentHash.toString('hex'),
			refundPrivkeyHex: refundKey.toString('hex'),
			refundPubkeyHex: refundPubkey.toString('hex'),
			claimPubkeyHex: terms.htlc.claimPublicKey.toString('hex'),
			refundHeight: terms.htlc.refundHeight,
			htlcAddress: terms.address,
			htlcOutputScriptHex: terms.outputScript.toString('hex'),
			onchainAmountSat: amountSat.toString(),
			invoiceAmountMsat: terms.invoiceAmountMsat.toString(),
			totalFeeSat: terms.totalFeeSat.toString(),
			minerFeeSat: terms.minerFeeSat.toString(),
			bolt11,
			invoiceExpiresAt: terms.invoiceExpiresAt,
			invoiceFinalCltv: terms.invoiceMinFinalCltv,
			invoiceSource,
			providerFundingConfirmations: terms.fundingConfirmations,
			providerExpiresAt: terms.expiresAt,
			paymentCeilingHeight: terms.paymentCeilingHeight,
			refundDestinationScriptHex: destination.toString('hex'),
			state: 'CREATED',
			updatedAt: Date.now()
		};
		const stored = this.store.upsert(record);
		this.log('swap_created', {
			swapId: stored.swapIdHex,
			direction: 'submarine',
			provider: peer,
			amountSat: amountSat.toString(),
			totalFeeSat: terms.totalFeeSat.toString(),
			refundHeight: terms.htlc.refundHeight,
			address: terms.address
		});
		return this.wrap(stored);
	}

	/** A minted invoice the swap never used stays on the node: say so. */
	private orphaned(
		bolt11: string,
		source: ISubmarineSwapRecord['invoiceSource'],
		reason: string
	): void {
		if (source !== 'minted') return;
		this.log('swap_invoice_orphaned', {
			bolt11,
			reason,
			level: 'warn'
		});
	}

	/** create, fund and follow the swap to its terminal state. */
	async run(
		providerPubkeyHex: string,
		params: ISubmarineSwapCreateParams,
		runOpts: { fund?: boolean } = {}
	): Promise<ISubmarineSwapRecord> {
		const swap = await this.create(providerPubkeyHex, params);
		return swap.run(runOpts);
	}

	/**
	 * After a restart: every record is re-checked against the node and the
	 * chain. A CREATED record nothing was sent for is reported and funded
	 * only when asked (`fund: true`); one whose funding call was made and
	 * lost is reported and NEVER funded again by this call; `run: true`
	 * starts the loops for everything unresolved.
	 */
	async resume(
		opts: { fund?: boolean; run?: boolean } = {}
	): Promise<ISubmarineResumeReport> {
		const report: ISubmarineResumeReport = {
			resumed: [],
			needsFunding: [],
			fundingUnknown: [],
			terminal: 0,
			errors: []
		};
		for (const record of this.store.restore()) {
			if (isTerminalSubmarineSwapState(record.state)) {
				report.terminal++;
				continue;
			}
			const swap = this.wrap(record);
			try {
				// A pass first: the invoice may have settled, a funding may be
				// found (attempt txid, wallet, script scan), a refund may be due.
				await swap.tick();
				const now = swap.record();
				if (isTerminalSubmarineSwapState(now.state)) {
					report.terminal++;
					continue;
				}
				if (now.state === 'CREATED' && !now.funding) {
					if (now.fundingAttempt) {
						report.fundingUnknown.push(swap);
					} else {
						const tip = await this.deps().chain.currentHeight();
						if (tip > now.refundHeight) {
							swap.markCancelled();
							report.terminal++;
							continue;
						}
						if (opts.fund && this.options.funder) {
							swap.fund().catch(() => undefined);
						} else {
							report.needsFunding.push(swap);
						}
					}
				}
				if (opts.run && !isTerminalSubmarineSwapState(swap.state))
					void swap.run({ fund: false });
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

	onChange(cb: (change: ISubmarineSwapChange) => void): () => void {
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

export type { RouxNetwork };
