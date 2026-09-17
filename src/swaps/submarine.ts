/**
 * One submarine swap, from the terms this device verified to its settle or
 * its refund.
 *
 *   create (submarine-client.ts)  record persisted CREATED with the refund
 *                                 key (or the id that derives it), nothing
 *                                 funded
 *   fund()                        fundingAttempt persisted BEFORE the funder
 *                                 is asked; the outpoint verified and
 *                                 recorded when it answers
 *   attachFunding()               a funding the host made by hand
 *   tick()                        one reconciliation pass; run() loops it:
 *                                   read the invoice (settled ends it),
 *                                   find the funding (attempt txid, wallet,
 *                                     script scan, provider hint), verified
 *                                     on chain,
 *                                   FUNDING -> FUNDED at the provider's depth,
 *                                   refund at the refund height, gated (below),
 *                                   REFUND_BROADCAST -> REFUNDED at depth,
 *                                     rebroadcast / bump while unconfirmed,
 *                                   CANCELLED when never funded and the
 *                                     window closed
 *
 * The refund gate, judged LAST, against the node as it is at that moment:
 * a refund goes out only when the tip has reached the refund height, the
 * output is still unspent, and the invoice is neither settled nor holding
 * an HTLC. An accepted invoice (an HTLC parked or in flight) blocks the
 * refund with no timeout: the provider may still learn the preimage from a
 * settle, and a refund racing that claim is exactly the loss this client
 * exists to avoid. An invoice the node cannot find blocks it too (fail
 * closed); an operator can override that by hand, never the loop.
 *
 * Settlement is the truth in either form: the invoice settled, or the
 * output spent by the claim branch (which carries the preimage). A claim
 * that lands after our refund went out is still SETTLED, since a settled
 * invoice means we hold the Lightning funds whatever the chain does with
 * the contract.
 */

import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { message, swaps } from 'beignet/lightning';
import { RouxLog } from '../types';
import { IPeerLink } from '../link/types';
import { exchange } from '../link/exchange';
import { SubmarineSwapStore } from './store';
import { feeForRate, bumpedFeeRate, replacementFloor } from './fees';
import { submarineRefundKey } from './secrets';
import { isClaimWitness, verifyFundingOutput } from './verify';
import {
	ISubmarineSwapChange,
	ISubmarineSwapRecord,
	ISubmarineSwapRefundAttempt,
	ISwapChain,
	ISwapClientPolicy,
	ISwapFunder,
	ISwapInvoiceStatus,
	ISwapLightningPayer,
	ISwapSecretProvider,
	SwapError,
	isTerminalSubmarineSwapState
} from './types';

export interface ISubmarineSwapDeps {
	link: IPeerLink;
	payer: ISwapLightningPayer;
	funder?: ISwapFunder;
	chain: ISwapChain;
	store: SubmarineSwapStore;
	policy: ISwapClientPolicy;
	log: RouxLog;
	/** Derives the refund key when the record does not hold it. */
	secrets?: ISwapSecretProvider;
	/** Told after every persisted state change. */
	notify?: (change: ISubmarineSwapChange) => void;
}

export interface ISubmarineSwapStatus {
	record: ISubmarineSwapRecord;
	height: number;
	blocksToRefund: number;
	fundingConfirmations: number | null;
	refundConfirmations: number | null;
	invoice: ISwapInvoiceStatus['state'] | undefined;
}

/** An HTLC is parked or in flight for the invoice. */
function invoiceHoldsHtlc(status: ISwapInvoiceStatus): boolean {
	return (
		status.state === 'accepted' ||
		(status.htlcsInFlight !== undefined && status.htlcsInFlight > 0)
	);
}

export class SubmarineSwap {
	private rec: ISubmarineSwapRecord;
	private lastStatusPollAt = 0;
	private stopped = false;
	private running: Promise<ISubmarineSwapRecord> | null = null;
	private ticking: Promise<void> | null = null;
	private funding: Promise<string> | null = null;
	private wake: (() => void) | null = null;

	constructor(
		record: ISubmarineSwapRecord,
		private readonly deps: ISubmarineSwapDeps
	) {
		this.rec = record;
	}

	record(): Readonly<ISubmarineSwapRecord> {
		return { ...this.rec };
	}

	get swapIdHex(): string {
		return this.rec.swapIdHex;
	}

	get state(): ISubmarineSwapRecord['state'] {
		return this.rec.state;
	}

	private persist(patch: Partial<ISubmarineSwapRecord>): void {
		const from = this.rec.state;
		this.rec = this.deps.store.upsert({ ...this.rec, ...patch });
		if (this.rec.state !== from && this.deps.notify) {
			try {
				this.deps.notify({
					swapIdHex: this.rec.swapIdHex,
					from,
					to: this.rec.state,
					record: this.record()
				});
			} catch (err) {
				this.deps.log('swap_listener_failed', {
					swapId: this.rec.swapIdHex,
					error: String(err)
				});
			}
		}
	}

	private htlc(): swaps.ISwapHtlc {
		return {
			paymentHash: Buffer.from(this.rec.paymentHashHex, 'hex'),
			claimPublicKey: Buffer.from(this.rec.claimPubkeyHex, 'hex'),
			refundPublicKey: Buffer.from(this.rec.refundPubkeyHex, 'hex'),
			refundHeight: this.rec.refundHeight
		};
	}

	private paymentHash(): Buffer {
		return Buffer.from(this.rec.paymentHashHex, 'hex');
	}

	async status(): Promise<ISubmarineSwapStatus> {
		const height = await this.deps.chain.currentHeight();
		const funding = this.rec.funding
			? await this.deps.chain.getOutput(
					this.rec.funding.txidHex,
					this.rec.funding.vout
			  )
			: null;
		const latest =
			this.rec.refund?.attempts[this.rec.refund.attempts.length - 1];
		return {
			record: this.record(),
			height,
			blocksToRefund: this.rec.refundHeight - height,
			fundingConfirmations: funding ? funding.confirmations : null,
			refundConfirmations: latest
				? await this.deps.chain.confirmations(
						latest.txidHex,
						latest.broadcastHeight
				  )
				: null,
			invoice: this.rec.invoice?.state
		};
	}

	// ─────────────── funding ───────────────

	/**
	 * Send the coins through the funder. The attempt is persisted BEFORE
	 * the wallet is asked, so a crash between the two leaves a record that
	 * says "a funding may exist", never a wallet payment the record knows
	 * nothing about. A second call is refused unless forced: the operator
	 * checks the wallet first.
	 */
	fund(
		opts: { force?: boolean; feeRateSatPerVb?: number } = {}
	): Promise<string> {
		if (this.funding) return this.funding;
		this.funding = this.fundOnce(opts).finally(() => {
			this.funding = null;
		});
		return this.funding;
	}

	private async fundOnce(opts: {
		force?: boolean;
		feeRateSatPerVb?: number;
	}): Promise<string> {
		const funder = this.deps.funder;
		if (!funder) {
			throw new SwapError(
				'no funder: pass swaps.funder (LndFunder, ClnFunder or your own ISwapFunder), or fund the address yourself and call attachFunding',
				'not_configured'
			);
		}
		if (this.rec.funding) {
			throw new SwapError('this swap is already funded', 'already_funded');
		}
		if (this.rec.state !== 'CREATED') {
			throw new SwapError(`cannot fund a swap in ${this.rec.state}`, 'state');
		}
		if (this.rec.fundingAttempt && !opts.force) {
			throw new SwapError(
				`a funding was already requested at ${new Date(
					this.rec.fundingAttempt.requestedAt
				).toISOString()}${
					this.rec.fundingAttempt.txidHex
						? ` (txid ${this.rec.fundingAttempt.txidHex})`
						: this.rec.fundingAttempt.error
						? ` and failed: ${this.rec.fundingAttempt.error}`
						: ' and its reply was lost'
				}; check the wallet, then fund({ force: true }) or attachFunding()`,
				'already_funded'
			);
		}
		const tip = await this.deps.chain.currentHeight();
		if (tip >= this.rec.refundHeight - this.deps.policy.claimSafetyBlocks) {
			throw new SwapError(
				`too late to fund: tip ${tip}, refund height ${this.rec.refundHeight}`,
				'deadline'
			);
		}
		const invoice = await this.lookupInvoice();
		if (invoice.state !== 'open') {
			throw new SwapError(
				`invoice is ${invoice.state}; only an open invoice is funded`,
				'invoice'
			);
		}
		const label = `roux-swap-${this.rec.swapIdHex}`;
		this.persist({
			fundingAttempt: { requestedAt: Date.now(), label }
		});
		this.deps.log('swap_funding_requested', {
			swapId: this.rec.swapIdHex,
			address: this.rec.htlcAddress,
			amountSat: this.rec.onchainAmountSat
		});
		let sent: { txidHex: string; vout?: number; rawHex?: string };
		try {
			sent = await funder.fund(
				this.rec.htlcAddress,
				BigInt(this.rec.onchainAmountSat),
				{ label, feeRateSatPerVb: opts.feeRateSatPerVb }
			);
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.persist({
				fundingAttempt: { ...this.rec.fundingAttempt!, error }
			});
			this.deps.log('swap_funding_call_failed', {
				swapId: this.rec.swapIdHex,
				error
			});
			throw new SwapError(`funding failed: ${error}`, 'funding_invalid');
		}
		this.persist({
			fundingAttempt: { ...this.rec.fundingAttempt!, txidHex: sent.txidHex }
		});
		await this.adoptFunding(sent.txidHex, sent.vout, 'funder', sent.rawHex);
		return sent.txidHex;
	}

	/** A funding the host made by hand (or one lost between call and reply). */
	async attachFunding(txidHex: string, vout?: number): Promise<void> {
		if (isTerminalSubmarineSwapState(this.rec.state)) {
			throw new SwapError(`cannot fund a swap in ${this.rec.state}`, 'state');
		}
		if (this.rec.funding) {
			throw new SwapError('this swap is already funded', 'already_funded');
		}
		await this.adoptFunding(txidHex, vout, 'attached');
		if (!this.rec.funding) {
			throw new SwapError(
				`${txidHex} pays nothing the contract accepts`,
				'funding_invalid'
			);
		}
	}

	/** Verify an outpoint against the contract and record it, or do nothing. */
	private async adoptFunding(
		txidHex: string,
		vout: number | undefined,
		source: NonNullable<ISubmarineSwapRecord['funding']>['source'],
		rawHint?: string
	): Promise<void> {
		const outputScript = Buffer.from(this.rec.htlcOutputScriptHex, 'hex');
		let raw = await this.deps.chain.getTransaction(txidHex);
		if (!raw && rawHint) {
			try {
				const hinted = bitcoin.Transaction.fromHex(rawHint);
				if (hinted.getId() === txidHex) raw = hinted.toBuffer();
			} catch {
				/* not a transaction */
			}
		}
		if (!raw) {
			this.deps.log('swap_funding_not_found', {
				swapId: this.rec.swapIdHex,
				txid: txidHex
			});
			return;
		}
		const tx = bitcoin.Transaction.fromBuffer(raw);
		const index =
			vout ?? tx.outs.findIndex((o) => o.script.equals(outputScript));
		if (index < 0) {
			this.deps.log('swap_funding_rejected', {
				swapId: this.rec.swapIdHex,
				txid: txidHex,
				reason: 'wrong_script'
			});
			return;
		}
		const output = await this.deps.chain.getOutput(txidHex, index);
		const verdict = verifyFundingOutput({
			txidHex,
			tx,
			vout: index,
			outputScript,
			onchainAmountSat: BigInt(this.rec.onchainAmountSat),
			output
		});
		if (!verdict.ok) {
			this.deps.log('swap_funding_rejected', {
				swapId: this.rec.swapIdHex,
				txid: txidHex,
				reason: verdict.reason
			});
			return;
		}
		const tip = await this.deps.chain.currentHeight();
		this.persist({
			state: this.rec.state === 'CREATED' ? 'FUNDING' : this.rec.state,
			funding: {
				txidHex,
				vout: index,
				valueSat: verdict.valueSat.toString(),
				firstSeenHeight: tip,
				confirmedHeight: verdict.height > 0 ? verdict.height : undefined,
				source
			}
		});
		this.deps.log('swap_funding_seen', {
			swapId: this.rec.swapIdHex,
			txid: txidHex,
			vout: index,
			confirmations: verdict.confirmations,
			source
		});
	}

	// ─────────────── the invoice ───────────────

	private async lookupInvoice(): Promise<ISwapInvoiceStatus> {
		if (!this.deps.payer.lookupInvoice) {
			throw new SwapError(
				'the payer cannot look invoices up (lookupInvoice); a submarine swap needs it',
				'not_configured'
			);
		}
		return this.deps.payer.lookupInvoice(this.paymentHash());
	}

	/** Read the invoice; a settled one ends the swap whatever its state. */
	private async refreshInvoice(): Promise<ISwapInvoiceStatus | null> {
		let status: ISwapInvoiceStatus;
		try {
			status = await this.lookupInvoice();
		} catch (err) {
			this.deps.log('swap_invoice_lookup_failed', {
				swapId: this.rec.swapIdHex,
				error: err instanceof Error ? err.message : String(err)
			});
			return null;
		}
		const previous = this.rec.invoice;
		this.persist({
			invoice: {
				state: status.state,
				preimageHex: status.preimage?.toString('hex') ?? previous?.preimageHex,
				htlcsInFlight: status.htlcsInFlight,
				checkedAt: Date.now(),
				acceptedSeenAt: invoiceHoldsHtlc(status)
					? previous?.acceptedSeenAt ?? Date.now()
					: previous?.acceptedSeenAt
			}
		});
		if (
			status.state === 'settled' &&
			!isTerminalSubmarineSwapState(this.rec.state)
		) {
			const refundOut = (this.rec.refund?.attempts.length ?? 0) > 0;
			this.persist({
				state: 'SETTLED',
				settledBy: 'invoice',
				resolution: this.rec.resolution ?? { kind: 'settled' }
			});
			this.deps.log(
				refundOut ? 'swap_settled_after_refund_broadcast' : 'swap_settled',
				{
					swapId: this.rec.swapIdHex,
					level: refundOut ? 'error' : 'info'
				}
			);
		}
		return status;
	}

	// ─────────────── the pass ───────────────

	/** One reconciliation pass. Deterministic; run() loops it on timers. */
	tick(): Promise<void> {
		if (this.ticking) return this.ticking;
		this.ticking = this.tickOnce().finally(() => {
			this.ticking = null;
		});
		return this.ticking;
	}

	private async tickOnce(): Promise<void> {
		if (isTerminalSubmarineSwapState(this.rec.state)) return;
		const tip = await this.deps.chain.currentHeight();
		const invoice = await this.refreshInvoice();
		if (isTerminalSubmarineSwapState(this.rec.state)) return;

		if (!this.rec.funding) await this.discoverFunding();
		if (this.rec.funding) await this.checkFunding(tip);
		if (isTerminalSubmarineSwapState(this.rec.state)) return;

		if (this.rec.state === 'CREATED' && !this.rec.funding) {
			// Never funded: the window closes at the refund height, or when
			// the invoice can no longer be paid. An unknown invoice on a
			// minted swap is a lookup problem, not a verdict.
			const closed =
				tip > this.rec.refundHeight ||
				(invoice !== null &&
					(invoice.state === 'expired' || invoice.state === 'cancelled'));
			// A funding request whose reply was lost keeps the swap open: the
			// coins may be on chain, and only the operator can say.
			if (closed && !this.rec.fundingAttempt) {
				this.persist({ state: 'CANCELLED' });
				this.deps.log('swap_cancelled', {
					swapId: this.rec.swapIdHex,
					reason: tip > this.rec.refundHeight ? 'window closed' : invoice?.state
				});
			}
			return;
		}
		if (
			(this.rec.state === 'FUNDING' || this.rec.state === 'FUNDED') &&
			tip >= this.rec.refundHeight
		) {
			try {
				await this.refund();
			} catch (err) {
				if (!(err instanceof SwapError) || err.code !== 'refund_blocked') {
					this.deps.log('swap_refund_failed', {
						swapId: this.rec.swapIdHex,
						error: err instanceof Error ? err.message : String(err)
					});
				}
			}
			return;
		}
		if (this.rec.state === 'REFUND_BROADCAST') {
			await this.followRefund(tip);
		}
	}

	private async pollStatus(): Promise<swaps.ISwapStatus | null> {
		const now = Date.now();
		if (now - this.lastStatusPollAt < this.deps.policy.statusPollMs)
			return null;
		this.lastStatusPollAt = now;
		const requestId = crypto.randomBytes(8);
		try {
			return await exchange(this.deps.link, {
				peerHex: this.rec.providerNodeIdHex,
				requestSubtype: message.BeignetCustomSubtype.SWAP_STATUS_REQUEST,
				requestPayload: swaps.encodeSwapStatusRequest({
					requestId,
					swapId: Buffer.from(this.rec.swapIdHex, 'hex')
				}),
				replySubtype: message.BeignetCustomSubtype.SWAP_STATUS,
				requestId,
				decode: swaps.decodeSwapStatus,
				timeoutMs: this.deps.policy.replyTimeoutMs,
				timeoutMessage: 'provider did not answer the status request'
			});
		} catch (err) {
			this.deps.log('swap_status_poll_failed', {
				swapId: this.rec.swapIdHex,
				error: String(err)
			});
			return null;
		}
	}

	/**
	 * Find the funding: the attempt's txid, the wallet's own record of it,
	 * a scan of the contract script, the provider's hint. Each candidate is
	 * verified against the chain before it is adopted.
	 */
	private async discoverFunding(): Promise<void> {
		const attempt = this.rec.fundingAttempt;
		if (attempt?.txidHex) {
			await this.adoptFunding(attempt.txidHex, undefined, 'funder');
			if (this.rec.funding) return;
		}
		if (attempt && !attempt.txidHex && this.deps.funder?.findFunding) {
			try {
				const found = await this.deps.funder.findFunding(
					this.rec.htlcAddress,
					attempt.label
				);
				if (found) {
					this.persist({
						fundingAttempt: { ...attempt, txidHex: found.txidHex }
					});
					await this.adoptFunding(found.txidHex, found.vout, 'funder');
					if (this.rec.funding) return;
				}
			} catch (err) {
				this.deps.log('swap_funding_lookup_failed', {
					swapId: this.rec.swapIdHex,
					error: err instanceof Error ? err.message : String(err)
				});
			}
		}
		if (this.deps.chain.findOutputs) {
			const outputScript = Buffer.from(this.rec.htlcOutputScriptHex, 'hex');
			for (const c of await this.deps.chain.findOutputs(outputScript)) {
				await this.adoptFunding(c.txidHex, c.vout, 'discovered');
				if (this.rec.funding) return;
			}
		}
		const status = await this.pollStatus();
		if (
			status?.found &&
			status.fundingTxid &&
			status.fundingVout !== undefined
		) {
			await this.adoptFunding(
				status.fundingTxid.toString('hex'),
				status.fundingVout,
				'discovered'
			);
		}
	}

	private async checkFunding(tip: number): Promise<void> {
		const funding = this.rec.funding!;
		const output = await this.deps.chain.getOutput(
			funding.txidHex,
			funding.vout
		);
		if (!output) {
			await this.classifyMissingFunding();
			return;
		}
		if (output.height > 0 && funding.confirmedHeight !== output.height) {
			this.persist({ funding: { ...funding, confirmedHeight: output.height } });
		}
		const depth = this.rec.providerFundingConfirmations;
		if (this.rec.state === 'FUNDING' && output.confirmations >= depth) {
			this.persist({ state: 'FUNDED' });
			this.deps.log('swap_funded', {
				swapId: this.rec.swapIdHex,
				height: output.height,
				tip
			});
		} else if (
			this.rec.state === 'FUNDED' &&
			!this.rec.refund &&
			output.confirmations < depth
		) {
			this.persist({
				state: 'FUNDING',
				funding: { ...funding, confirmedHeight: undefined }
			});
			this.deps.log('swap_funding_demoted', {
				swapId: this.rec.swapIdHex,
				confirmations: output.confirmations,
				depth
			});
		}
	}

	/**
	 * The output is gone. Our own refund confirmed is REFUNDED; the claim
	 * branch is SETTLED (the preimage is on chain, so the invoice is paid or
	 * about to be); anything else is a resolution we cannot name; no
	 * spender at all with the funding unknown to the source is a reorg.
	 */
	private async classifyMissingFunding(): Promise<void> {
		const funding = this.rec.funding!;
		const outputScript = Buffer.from(this.rec.htlcOutputScriptHex, 'hex');
		const ours = new Map(
			(this.rec.refund?.attempts ?? []).map((a) => [a.txidHex, a] as const)
		);
		let spender: string | null = null;
		if (this.deps.chain.findSpender) {
			spender = await this.deps.chain.findSpender(
				funding.txidHex,
				funding.vout,
				outputScript
			);
		}
		if (!spender) {
			for (const a of ours.values()) {
				const confs = await this.deps.chain.confirmations(
					a.txidHex,
					a.broadcastHeight
				);
				if (confs !== null) {
					spender = a.txidHex;
					break;
				}
			}
		}
		if (!spender) {
			const status = await this.pollStatus();
			if (status?.resolutionTxid)
				spender = status.resolutionTxid.toString('hex');
		}
		if (!spender && ours.size > 0) {
			const fundingKnown = await this.deps.chain.getTransaction(
				funding.txidHex,
				funding.confirmedHeight
			);
			if (fundingKnown) {
				this.deps.log('swap_refund_status_unknown', {
					swapId: this.rec.swapIdHex,
					attempts: [...ours.keys()]
				});
				return;
			}
		}
		if (spender && ours.has(spender)) {
			const confs =
				(await this.deps.chain.confirmations(
					spender,
					ours.get(spender)!.broadcastHeight
				)) ?? 0;
			if (confs >= this.deps.policy.refundConfirmations) {
				this.persist({
					state: 'REFUNDED',
					refund: { ...this.rec.refund!, confirmedTxidHex: spender },
					resolution: { kind: 'refund', txidHex: spender }
				});
				this.deps.log('swap_refunded', {
					swapId: this.rec.swapIdHex,
					txid: spender
				});
			}
			return;
		}
		if (spender) {
			const raw = await this.deps.chain.getTransaction(spender);
			if (raw) {
				const tx = bitcoin.Transaction.fromBuffer(raw);
				const script = swaps.buildSwapHtlc(this.htlc()).witnessScript;
				const input = tx.ins.find(
					(i) =>
						Buffer.from(i.hash).reverse().toString('hex') === funding.txidHex &&
						i.index === funding.vout
				);
				if (input && isClaimWitness(input.witness, script)) {
					const fundingRaw = await this.deps.chain.getTransaction(
						funding.txidHex,
						funding.confirmedHeight
					);
					const preimage = fundingRaw
						? swaps.extractSwapPreimage(tx, {
								htlc: this.htlc(),
								fundingTransaction: bitcoin.Transaction.fromBuffer(fundingRaw),
								outputIndex: funding.vout
						  })
						: input.witness[1];
					const invoiceSettled = this.rec.invoice?.state === 'settled';
					this.persist({
						state: 'SETTLED',
						settledBy: this.rec.settledBy ?? 'chain',
						resolution: { kind: 'claim', txidHex: spender },
						invoice: {
							...(this.rec.invoice ?? {
								state: 'unknown',
								checkedAt: Date.now()
							}),
							preimageHex:
								this.rec.invoice?.preimageHex ?? preimage?.toString('hex')
						}
					});
					this.deps.log(
						invoiceSettled
							? 'swap_claimed_by_provider'
							: 'swap_preimage_on_chain_invoice_unpaid',
						{
							swapId: this.rec.swapIdHex,
							txid: spender,
							level: invoiceSettled ? 'info' : 'error'
						}
					);
					return;
				}
			}
			this.persist({
				state: 'CANCELLED',
				resolution: { kind: 'other', txidHex: spender }
			});
			this.deps.log('swap_resolved_by_other', {
				swapId: this.rec.swapIdHex,
				txid: spender,
				level: 'error'
			});
			return;
		}
		// No spender anywhere: reorged away. Keep the attempt, look again.
		this.deps.log('swap_funding_reorged', {
			swapId: this.rec.swapIdHex,
			txid: funding.txidHex
		});
		this.persist({
			funding: undefined,
			state:
				this.rec.state === 'FUNDING' || this.rec.state === 'FUNDED'
					? 'CREATED'
					: this.rec.state
		});
	}

	// ─────────────── the refund ───────────────

	/**
	 * Build, persist, then broadcast a refund. Preparation (bytes, fee,
	 * signature) first; the judgement last: the height, the unspent output,
	 * and the invoice as the node reports it NOW.
	 */
	async refund(
		opts: { feeRateSatPerVb?: number; allowUnknownInvoice?: boolean } = {}
	): Promise<string> {
		if (
			this.rec.state !== 'FUNDING' &&
			this.rec.state !== 'FUNDED' &&
			this.rec.state !== 'REFUND_BROADCAST'
		) {
			throw new SwapError(`cannot refund a swap in ${this.rec.state}`, 'state');
		}
		const funding = this.rec.funding;
		if (!funding) {
			throw new SwapError('no funding is recorded for this swap', 'state');
		}
		const raw = await this.deps.chain.getTransaction(
			funding.txidHex,
			funding.confirmedHeight
		);
		if (!raw) {
			throw new SwapError(
				'funding transaction is not available',
				'funding_invalid'
			);
		}
		const rate =
			opts.feeRateSatPerVb ??
			(await this.deps.chain.estimateFeeRateSatPerVb?.(2)) ??
			this.deps.policy.defaultFeeRateSatPerVb;
		const privateKey = await submarineRefundKey(this.rec, this.deps.secrets);
		const built = feeForRate(
			(feeSat) =>
				swaps.buildSwapRefundTx({
					htlc: this.htlc(),
					fundingTransaction: bitcoin.Transaction.fromBuffer(raw),
					outputIndex: funding.vout,
					destinationScript: Buffer.from(
						this.rec.refundDestinationScriptHex,
						'hex'
					),
					feeSatoshis: feeSat,
					privateKey
				}),
			rate,
			{ maxFeeSat: this.deps.policy.maxRefundFeeSat }
		);
		// The judgement, last.
		const tip = await this.deps.chain.currentHeight();
		if (tip < this.rec.refundHeight) {
			throw new SwapError(
				`refund height ${this.rec.refundHeight} not reached (tip ${tip})`,
				'deadline'
			);
		}
		const output = await this.deps.chain.getOutput(
			funding.txidHex,
			funding.vout
		);
		if (!output) {
			throw new SwapError(
				'funding output is spent or gone; the next pass classifies it',
				'funding_invalid'
			);
		}
		const blocked = (reason: string): SwapError => {
			this.persist({ refundBlockedReason: reason });
			this.deps.log('swap_refund_blocked', {
				swapId: this.rec.swapIdHex,
				reason
			});
			return new SwapError(`refund withheld: ${reason}`, 'refund_blocked');
		};
		let invoice: ISwapInvoiceStatus;
		try {
			invoice = await this.lookupInvoice();
		} catch (err) {
			throw blocked(
				`invoice lookup failed (${
					err instanceof Error ? err.message : String(err)
				})`
			);
		}
		if (invoice.state === 'settled') {
			this.persist({
				state: 'SETTLED',
				settledBy: 'invoice',
				resolution: this.rec.resolution ?? { kind: 'settled' },
				invoice: {
					state: 'settled',
					preimageHex: invoice.preimage?.toString('hex'),
					checkedAt: Date.now()
				}
			});
			throw blocked('the invoice is settled: nothing to refund');
		}
		if (invoiceHoldsHtlc(invoice)) {
			throw blocked(
				'an HTLC is in flight for the invoice: the provider may still settle it'
			);
		}
		if (invoice.state === 'unknown' && !opts.allowUnknownInvoice) {
			throw blocked(
				'the node does not know the invoice; pass allowUnknownInvoice to refund anyway'
			);
		}
		if (isTerminalSubmarineSwapState(this.rec.state)) {
			throw new SwapError(`swap became ${this.rec.state}`, 'state');
		}
		const attempt: ISubmarineSwapRefundAttempt = {
			txidHex: built.tx.getId(),
			rawHex: built.tx.toHex(),
			feeSat: built.feeSat.toString(),
			feeRateSatPerVb: built.feeRateSatPerVb,
			builtAt: Date.now()
		};
		// Persisted BEFORE broadcast: a crash after the send still knows the bytes.
		this.persist({
			state: 'REFUND_BROADCAST',
			refund: { attempts: [...(this.rec.refund?.attempts ?? []), attempt] },
			refundBlockedReason: undefined
		});
		await this.broadcastLatest(tip);
		return attempt.txidHex;
	}

	private async broadcastLatest(tip: number): Promise<void> {
		const attempts = this.rec.refund!.attempts;
		const latest = attempts[attempts.length - 1];
		try {
			await this.deps.chain.broadcast(latest.rawHex);
			const updated = attempts.map((a, i) =>
				i === attempts.length - 1 && a.broadcastAt === undefined
					? { ...a, broadcastAt: Date.now(), broadcastHeight: tip }
					: a
			);
			this.persist({
				refund: { ...this.rec.refund!, attempts: updated },
				lastError: undefined
			});
			this.deps.log('swap_refund_broadcast', {
				swapId: this.rec.swapIdHex,
				txid: latest.txidHex,
				feeSat: latest.feeSat
			});
		} catch (err) {
			this.persist({
				lastError: err instanceof Error ? err.message : String(err)
			});
			this.deps.log('swap_refund_broadcast_failed', {
				swapId: this.rec.swapIdHex,
				error: String(err)
			});
		}
	}

	private async followRefund(tip: number): Promise<void> {
		const attempts = this.rec.refund?.attempts ?? [];
		for (const a of attempts) {
			const confs = await this.deps.chain.confirmations(
				a.txidHex,
				a.broadcastHeight
			);
			if (confs !== null && confs >= this.deps.policy.refundConfirmations) {
				this.persist({
					state: 'REFUNDED',
					refund: {
						...this.rec.refund!,
						confirmedTxidHex: a.txidHex,
						confirmedHeight: tip - confs + 1
					},
					resolution: { kind: 'refund', txidHex: a.txidHex }
				});
				this.deps.log('swap_refunded', {
					swapId: this.rec.swapIdHex,
					txid: a.txidHex
				});
				return;
			}
		}
		// The output may have gone to the provider's claim meanwhile; our own
		// unconfirmed refund spending it is not a resolution yet.
		const funding = this.rec.funding!;
		const output = await this.deps.chain.getOutput(
			funding.txidHex,
			funding.vout
		);
		if (!output) {
			const before = this.rec.state;
			await this.classifyMissingFunding();
			if (this.rec.state !== before || !this.rec.funding) return;
		}
		const latest = attempts[attempts.length - 1];
		if (!latest) return;
		if (latest.broadcastAt === undefined) {
			await this.broadcastLatest(tip);
			return;
		}
		const due =
			latest.broadcastHeight !== undefined &&
			tip - latest.broadcastHeight >= this.deps.policy.bumpAfterBlocks;
		if (due) {
			await this.bumpRefund(tip);
			return;
		}
		await this.broadcastLatest(tip);
	}

	/** Replace the unconfirmed refund with one paying more (BIP 125). */
	async bumpRefund(tip?: number): Promise<string | null> {
		const attempts = this.rec.refund?.attempts ?? [];
		const latest = attempts[attempts.length - 1];
		if (!latest || this.rec.state !== 'REFUND_BROADCAST') return null;
		const height = tip ?? (await this.deps.chain.currentHeight());
		const funding = this.rec.funding;
		if (!funding) return null;
		const raw = await this.deps.chain.getTransaction(
			funding.txidHex,
			funding.confirmedHeight
		);
		if (!raw) return null;
		const rate = bumpedFeeRate(latest.feeRateSatPerVb, this.deps.policy);
		let built;
		try {
			const privateKey = await submarineRefundKey(this.rec, this.deps.secrets);
			built = feeForRate(
				(feeSat) =>
					swaps.buildSwapRefundTx({
						htlc: this.htlc(),
						fundingTransaction: bitcoin.Transaction.fromBuffer(raw),
						outputIndex: funding.vout,
						destinationScript: Buffer.from(
							this.rec.refundDestinationScriptHex,
							'hex'
						),
						feeSatoshis: feeSat,
						privateKey
					}),
				rate,
				{ maxFeeSat: this.deps.policy.maxRefundFeeSat }
			);
		} catch (err) {
			this.deps.log('swap_bump_failed', {
				swapId: this.rec.swapIdHex,
				error: String(err)
			});
			return null;
		}
		const floor = replacementFloor(
			BigInt(latest.feeSat),
			built.tx.virtualSize()
		);
		if (built.feeSat < floor) {
			await this.broadcastLatest(height);
			return null;
		}
		const attempt: ISubmarineSwapRefundAttempt = {
			txidHex: built.tx.getId(),
			rawHex: built.tx.toHex(),
			feeSat: built.feeSat.toString(),
			feeRateSatPerVb: built.feeRateSatPerVb,
			builtAt: Date.now()
		};
		this.persist({
			refund: { ...this.rec.refund!, attempts: [...attempts, attempt] }
		});
		await this.broadcastLatest(height);
		return attempt.txidHex;
	}

	// ─────────────── lifecycle ───────────────

	/** After a restart: an unfunded swap whose window closed. */
	markCancelled(): void {
		if (
			!isTerminalSubmarineSwapState(this.rec.state) &&
			!this.rec.funding &&
			!this.rec.fundingAttempt
		) {
			this.persist({ state: 'CANCELLED' });
		}
	}

	/**
	 * Fund if a funder is configured and nothing was ever requested, then
	 * loop tick() until the swap is terminal or stop().
	 */
	run(opts: { fund?: boolean } = {}): Promise<ISubmarineSwapRecord> {
		if (this.running) return this.running;
		this.running = (async (): Promise<ISubmarineSwapRecord> => {
			if (
				this.rec.state === 'CREATED' &&
				!this.rec.funding &&
				!this.rec.fundingAttempt &&
				this.deps.funder &&
				opts.fund !== false
			) {
				try {
					await this.fund();
				} catch (err) {
					this.deps.log('swap_fund_failed', {
						swapId: this.rec.swapIdHex,
						error: err instanceof Error ? err.message : String(err)
					});
				}
			}
			while (!this.stopped && !isTerminalSubmarineSwapState(this.rec.state)) {
				try {
					await this.tick();
				} catch (err) {
					this.deps.log('swap_tick_failed', {
						swapId: this.rec.swapIdHex,
						error: String(err)
					});
				}
				if (isTerminalSubmarineSwapState(this.rec.state)) break;
				await new Promise<void>((resolve) => {
					const t = setTimeout(resolve, this.deps.policy.chainPollMs);
					t.unref?.();
					this.wake = (): void => {
						clearTimeout(t);
						resolve();
					};
				});
			}
			return this.record();
		})();
		return this.running;
	}

	/** Cut a run() wait short (a test that just mined a block). */
	poke(): void {
		this.wake?.();
	}

	/**
	 * Park the swap: no further ticks, and the promise resolves once the
	 * pass in flight (if any) has finished writing. Nothing is cancelled: a
	 * funding already sent stays sent, a refund already broadcast keeps
	 * confirming, and `resume()` continues from the record.
	 */
	async stop(): Promise<void> {
		this.stopped = true;
		this.wake?.();
		if (this.ticking) await this.ticking.catch(() => undefined);
		// A funding call in flight is not awaited: the attempt is persisted,
		// and a wallet that never answers must not hold shutdown hostage;
		// resume() finds the funding or reports it unknown.
		if (this.running) await this.running.catch(() => undefined);
	}
}
