/**
 * One reverse swap, from the terms this device verified to its claim.
 *
 *   create (client.ts)   record persisted CREATED, nothing paid
 *   pay()                record PAYING BEFORE the payer is asked
 *   tick()               one reconciliation pass; run() loops it:
 *                          track the payment,
 *                          find the funding (provider status hint, verified
 *                            on chain; script scan as fallback),
 *                          FUNDED at the policy's confirmations,
 *                          claim: attempt persisted BEFORE broadcast,
 *                          CLAIM_BROADCAST -> CLAIMED at one confirmation,
 *                            rebroadcast / bump while unconfirmed,
 *                          EXPIRED on the provider's refund or a dead deadline,
 *                          PAYMENT_FAILED when the payment failed with no
 *                            funding on chain
 *
 * Deadline rule: the FIRST claim, the one that discloses the preimage, is
 * made only while the tip is below refundHeight - claimSafetyBlocks. Past
 * that the provider could learn the preimage from our claim, settle the
 * Lightning side, and still take the output with a refund that confirms
 * first: principal at risk, not fees. So a swap that has not disclosed by
 * then does not claim; the provider refunds, the hold fails back, nothing
 * is lost. A claim already out is followed and bumped regardless, since
 * the preimage is public once it left.
 *
 * Confirmation rule: the floor (minFundingConfirmations, at least 1) is
 * judged against the chain at the moment of the first claim, never from
 * the stored FUNDED state: a funding that fell back into the mempool
 * demotes the swap to PAYING until it confirms again.
 */

import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { message, swaps } from 'beignet/lightning';
import { RouxLog } from '../types';
import { IPeerLink } from '../link/types';
import { exchange } from '../link/exchange';
import { ReverseSwapStore } from './store';
import { claimFeeForRate, bumpedFeeRate, replacementFloor } from './fees';
import { reverseSwapSecrets } from './secrets';
import { isRefundWitness, verifyFundingOutput } from './verify';
import {
	IReverseSwapChange,
	IReverseSwapRecord,
	ISwapChain,
	ISwapClientPolicy,
	ISwapLightningPayer,
	ISwapPaymentStatus,
	ISwapSecretProvider,
	SwapError,
	isTerminalReverseSwapState
} from './types';

export interface IReverseSwapDeps {
	link: IPeerLink;
	payer: ISwapLightningPayer;
	chain: ISwapChain;
	store: ReverseSwapStore;
	policy: ISwapClientPolicy;
	log: RouxLog;
	/** Derives the claim key and preimage when the record does not hold them. */
	secrets?: ISwapSecretProvider;
	/** Told after every persisted state change. */
	notify?: (change: IReverseSwapChange) => void;
}

export interface IReverseSwapStatus {
	record: IReverseSwapRecord;
	height: number;
	blocksToRefund: number;
	fundingConfirmations: number | null;
	claimConfirmations: number | null;
}

export class ReverseSwap {
	private rec: IReverseSwapRecord;
	private lastStatusPollAt = 0;
	private stopped = false;
	private running: Promise<IReverseSwapRecord> | null = null;
	private ticking: Promise<void> | null = null;
	private paying: Promise<ISwapPaymentStatus> | null = null;

	constructor(
		record: IReverseSwapRecord,
		private readonly deps: IReverseSwapDeps
	) {
		this.rec = record;
	}

	record(): Readonly<IReverseSwapRecord> {
		return { ...this.rec };
	}

	get swapIdHex(): string {
		return this.rec.swapIdHex;
	}

	get state(): IReverseSwapRecord['state'] {
		return this.rec.state;
	}

	private persist(patch: Partial<IReverseSwapRecord>): void {
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

	async status(): Promise<IReverseSwapStatus> {
		const height = await this.deps.chain.currentHeight();
		const funding = this.rec.funding
			? await this.deps.chain.getOutput(
					this.rec.funding.txidHex,
					this.rec.funding.vout
			  )
			: null;
		const latest = this.rec.claim?.attempts[this.rec.claim.attempts.length - 1];
		return {
			record: this.record(),
			height,
			blocksToRefund: this.rec.refundHeight - height,
			fundingConfirmations: funding ? funding.confirmations : null,
			claimConfirmations: latest
				? await this.deps.chain.confirmations(latest.txidHex)
				: null
		};
	}

	/**
	 * Fire the payment. The PAYING record is written BEFORE the payer is
	 * asked, so a crash between the two leaves a record that says "check the
	 * node", never a payment the record knows nothing about.
	 */
	pay(opts: { maxFeeSat?: bigint } = {}): Promise<ISwapPaymentStatus> {
		if (this.paying) return this.paying;
		if (this.rec.state !== 'CREATED' && this.rec.state !== 'PAYING') {
			throw new SwapError(`cannot pay a swap in ${this.rec.state}`, 'state');
		}
		const invoiceSat = BigInt(this.rec.invoiceAmountMsat) / 1000n;
		const ppmFee =
			(invoiceSat * BigInt(this.deps.policy.maxLightningFeePpm)) / 1_000_000n;
		const maxFeeSat =
			opts.maxFeeSat ??
			(ppmFee > this.deps.policy.minLightningFeeSat
				? ppmFee
				: this.deps.policy.minLightningFeeSat);
		if (this.rec.state === 'CREATED') {
			this.persist({
				state: 'PAYING',
				payment: { startedAt: Date.now(), status: 'pending' }
			});
		}
		this.deps.log('swap_paying', {
			swapId: this.rec.swapIdHex,
			maxFeeSat: maxFeeSat.toString()
		});
		this.paying = this.deps.payer
			.payInvoice(this.rec.bolt11, {
				maxFeeSat,
				timeoutSeconds: this.deps.policy.paymentTimeoutSeconds
			})
			.then(
				(status) => {
					this.recordPayment(status);
					return status;
				},
				(err) => {
					// The node lost the call, not necessarily the payment:
					// trackPayment decides on the next tick.
					this.deps.log('swap_pay_call_failed', {
						swapId: this.rec.swapIdHex,
						error: err instanceof Error ? err.message : String(err)
					});
					return { status: 'unknown' as const };
				}
			);
		return this.paying;
	}

	/** After a restart: the node already knows this payment (resume). */
	adoptPayment(status: ISwapPaymentStatus): void {
		if (this.rec.state === 'CREATED') {
			this.persist({
				state: 'PAYING',
				payment: { startedAt: this.rec.createdAt, status: 'pending' }
			});
		}
		this.recordPayment(status);
	}

	/** After a restart: an unpaid swap whose refund height has passed. */
	markExpired(): void {
		if (!isTerminalReverseSwapState(this.rec.state)) {
			this.persist({ state: 'EXPIRED' });
		}
	}

	/** Ask the node about the payment while it is not yet terminal. */
	private async refreshPayment(): Promise<void> {
		const known = this.rec.payment?.status;
		if (known === 'succeeded' || known === 'failed') return;
		if (this.rec.state === 'CREATED') return;
		try {
			const status = await this.deps.payer.trackPayment(
				Buffer.from(this.rec.paymentHashHex, 'hex')
			);
			this.recordPayment(status);
		} catch (err) {
			this.deps.log('swap_track_failed', {
				swapId: this.rec.swapIdHex,
				error: String(err)
			});
		}
	}

	private recordPayment(status: ISwapPaymentStatus): void {
		if (status.status === 'unknown') return;
		const current = this.rec.payment ?? {
			startedAt: Date.now(),
			status: 'pending' as const
		};
		this.persist({
			payment: {
				...current,
				status: status.status,
				preimageHex: status.preimage?.toString('hex') ?? current.preimageHex,
				failureReason: status.failureReason ?? current.failureReason
			}
		});
	}

	/** One reconciliation pass. Deterministic; run() loops it on timers. */
	tick(): Promise<void> {
		if (this.ticking) return this.ticking;
		this.ticking = this.tickOnce().finally(() => {
			this.ticking = null;
		});
		return this.ticking;
	}

	private async tickOnce(): Promise<void> {
		if (isTerminalReverseSwapState(this.rec.state)) return;
		const tip = await this.deps.chain.currentHeight();

		await this.refreshPayment();

		if (!this.rec.funding) await this.discoverFunding(tip);
		if (this.rec.funding) await this.checkFunding(tip);

		if (this.rec.state === 'FUNDED') {
			if (this.pastClaimDeadline(tip)) {
				if (!this.rec.claimDeadlinePassedAt) {
					this.persist({ claimDeadlinePassedAt: Date.now() });
					this.deps.log('swap_claim_deadline_passed', {
						swapId: this.rec.swapIdHex,
						tip,
						refundHeight: this.rec.refundHeight
					});
				}
				return;
			}
			await this.claim();
			return;
		}
		if (this.rec.state === 'CLAIM_BROADCAST') {
			await this.followClaim(tip);
			return;
		}
		if (this.rec.state === 'PAYING' && !this.rec.funding) {
			const payment = this.rec.payment?.status ?? 'pending';
			if (payment === 'failed') {
				this.persist({ state: 'PAYMENT_FAILED' });
				this.deps.log('swap_payment_failed', {
					swapId: this.rec.swapIdHex,
					reason: this.rec.payment?.failureReason
				});
				return;
			}
			if (tip > this.rec.refundHeight && payment !== 'pending') {
				this.persist({ state: 'EXPIRED' });
				this.deps.log('swap_expired', { swapId: this.rec.swapIdHex });
			}
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

	private async discoverFunding(tip: number): Promise<void> {
		const outputScript = Buffer.from(this.rec.htlcOutputScriptHex, 'hex');
		const candidates: Array<{
			txidHex: string;
			vout: number;
			rawHint?: Buffer;
			height?: number;
		}> = [];
		const status = await this.pollStatus();
		if (
			status?.found &&
			status.fundingTxid !== undefined &&
			status.fundingVout !== undefined
		) {
			candidates.push({
				txidHex: status.fundingTxid.toString('hex'),
				vout: status.fundingVout,
				rawHint: status.fundingTx,
				height: status.fundingHeight
			});
			if (status.resolutionTxid && !this.rec.resolution) {
				// The provider says it is resolved; the chain check below decides.
				this.deps.log('swap_provider_reports_resolution', {
					swapId: this.rec.swapIdHex,
					kind: status.resolutionKind
				});
			}
		}
		if (candidates.length === 0 && this.deps.chain.findOutputs) {
			for (const c of await this.deps.chain.findOutputs(outputScript)) {
				candidates.push({ txidHex: c.txidHex, vout: c.vout, height: c.height });
			}
		}
		for (const c of candidates) {
			let raw = await this.deps.chain.getTransaction(c.txidHex, c.height);
			if (!raw && c.rawHint) {
				// The provider's bytes, bound to the txid it named: still checked
				// against the chain's own view of the outpoint below.
				try {
					if (bitcoin.Transaction.fromBuffer(c.rawHint).getId() === c.txidHex)
						raw = c.rawHint;
				} catch {
					/* not a transaction */
				}
			}
			if (!raw) continue;
			const output = await this.deps.chain.getOutput(c.txidHex, c.vout);
			const verdict = verifyFundingOutput({
				txidHex: c.txidHex,
				tx: bitcoin.Transaction.fromBuffer(raw),
				vout: c.vout,
				outputScript,
				onchainAmountSat: BigInt(this.rec.onchainAmountSat),
				output
			});
			if (!verdict.ok) {
				this.deps.log('swap_funding_rejected', {
					swapId: this.rec.swapIdHex,
					txid: c.txidHex,
					reason: verdict.reason
				});
				continue;
			}
			this.persist({
				funding: {
					txidHex: c.txidHex,
					vout: c.vout,
					valueSat: verdict.valueSat.toString(),
					firstSeenHeight: tip,
					confirmedHeight: verdict.height > 0 ? verdict.height : undefined
				}
			});
			this.deps.log('swap_funding_seen', {
				swapId: this.rec.swapIdHex,
				txid: c.txidHex,
				vout: c.vout,
				confirmations: verdict.confirmations
			});
			return;
		}
	}

	private async checkFunding(tip: number): Promise<void> {
		const funding = this.rec.funding!;
		const output = await this.deps.chain.getOutput(
			funding.txidHex,
			funding.vout
		);
		if (!output) {
			// Spent or gone. A spender is a resolution; nothing is a reorg.
			await this.classifyMissingFunding();
			return;
		}
		if (output.height > 0 && funding.confirmedHeight !== output.height) {
			this.persist({ funding: { ...funding, confirmedHeight: output.height } });
		}
		const floor = this.deps.policy.minFundingConfirmations;
		if (this.rec.state === 'PAYING' && output.confirmations >= floor) {
			this.persist({ state: 'FUNDED' });
			this.deps.log('swap_funded', {
				swapId: this.rec.swapIdHex,
				height: output.height,
				tip
			});
		} else if (
			this.rec.state === 'FUNDED' &&
			!this.rec.claim &&
			output.confirmations < floor
		) {
			// A stored FUNDED is history: the funding is back in the mempool
			// (a reorg, or a resumed record judged by an earlier chain) and
			// nothing has been disclosed yet, so the floor applies again.
			this.persist({
				state: 'PAYING',
				funding: { ...funding, confirmedHeight: undefined }
			});
			this.deps.log('swap_funding_demoted', {
				swapId: this.rec.swapIdHex,
				confirmations: output.confirmations,
				floor
			});
		}
	}

	private async classifyMissingFunding(): Promise<void> {
		const funding = this.rec.funding!;
		const outputScript = Buffer.from(this.rec.htlcOutputScriptHex, 'hex');
		const ours = new Set(
			(this.rec.claim?.attempts ?? []).map((a) => a.txidHex)
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
			for (const a of this.rec.claim?.attempts ?? []) {
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
			// Our own claim is out and the output is gone, yet no source can
			// name the spender. When the funding itself is still known, the
			// source's scan window may simply not reach the claim's block:
			// that is not evidence of a reorg. Keep the funding and the
			// claim, and ask again next tick. A funding the source no longer
			// has at all is the reorg case below.
			const fundingKnown = await this.deps.chain.getTransaction(
				funding.txidHex,
				funding.confirmedHeight
			);
			if (fundingKnown) {
				this.deps.log('swap_claim_status_unknown', {
					swapId: this.rec.swapIdHex,
					attempts: [...ours]
				});
				return;
			}
		}
		if (spender && ours.has(spender)) {
			const attempt = this.rec.claim!.attempts.find(
				(a) => a.txidHex === spender
			);
			const confs =
				(await this.deps.chain.confirmations(
					spender,
					attempt?.broadcastHeight
				)) ?? 0;
			if (confs >= 1) {
				this.persist({
					state: 'CLAIMED',
					claim: { ...this.rec.claim!, confirmedTxidHex: spender },
					resolution: { kind: 'claim', txidHex: spender }
				});
				this.deps.log('swap_claimed', {
					swapId: this.rec.swapIdHex,
					txid: spender
				});
			}
			return;
		}
		if (spender) {
			const raw = await this.deps.chain.getTransaction(spender);
			let kind: 'refund' | 'other' = 'other';
			if (raw) {
				const tx = bitcoin.Transaction.fromBuffer(raw);
				const script = swaps.buildSwapHtlc(this.htlc()).witnessScript;
				const input = tx.ins.find(
					(i) =>
						Buffer.from(i.hash).reverse().toString('hex') === funding.txidHex &&
						i.index === funding.vout
				);
				if (input && isRefundWitness(input.witness, script)) kind = 'refund';
			}
			this.persist({
				state: 'EXPIRED',
				resolution: { kind, txidHex: spender }
			});
			this.deps.log('swap_resolved_by_other', {
				swapId: this.rec.swapIdHex,
				txid: spender,
				kind
			});
			return;
		}
		// No spender anywhere: the funding was reorged away. Wait for it again.
		this.deps.log('swap_funding_reorged', {
			swapId: this.rec.swapIdHex,
			txid: funding.txidHex
		});
		this.persist({
			funding: undefined,
			state: this.rec.state === 'FUNDED' ? 'PAYING' : this.rec.state
		});
	}

	/** True once the first disclosure would race the provider's refund. */
	private pastClaimDeadline(tip: number): boolean {
		return (
			!this.rec.claim &&
			tip >= this.rec.refundHeight - this.deps.policy.claimSafetyBlocks
		);
	}

	/**
	 * Build, persist, then broadcast a claim of the funded output. The
	 * first claim is refused past the deadline and below the confirmation
	 * floor, both judged against the chain now, not the stored state.
	 */
	async claim(opts: { feeRateSatPerVb?: number } = {}): Promise<string> {
		if (this.rec.state !== 'FUNDED' && this.rec.state !== 'CLAIM_BROADCAST') {
			throw new SwapError(`cannot claim a swap in ${this.rec.state}`, 'state');
		}
		const funding = this.rec.funding;
		if (!funding) {
			throw new SwapError('no funding is recorded for this swap', 'state');
		}
		// Preparation first: the funding bytes, the fee estimate, the secrets
		// and the signed claim. Every one of these awaits a backend, and the
		// world moves while they do.
		const raw = await this.deps.chain.getTransaction(
			funding.txidHex,
			funding.confirmedHeight
		);
		if (!raw)
			throw new SwapError(
				'funding transaction is not available',
				'funding_invalid'
			);
		const rate =
			opts.feeRateSatPerVb ??
			(await this.deps.chain.estimateFeeRateSatPerVb?.(2)) ??
			this.deps.policy.defaultFeeRateSatPerVb;
		const { privateKey, preimage } = await reverseSwapSecrets(
			this.rec,
			this.deps.secrets
		);
		const built = claimFeeForRate(
			(feeSat) =>
				swaps.buildSwapClaimTx({
					htlc: this.htlc(),
					fundingTransaction: bitcoin.Transaction.fromBuffer(raw),
					outputIndex: funding.vout,
					destinationScript: Buffer.from(this.rec.destinationScriptHex, 'hex'),
					feeSatoshis: feeSat,
					privateKey,
					preimage
				}),
			rate,
			this.deps.policy
		);
		// The judgement last, against the chain as it is now, with nothing
		// awaited between it and the persist + broadcast below except the
		// broadcast itself: the deadline and the exact, unspent, confirmed
		// output are what make the first disclosure of the preimage safe.
		const tip = await this.deps.chain.currentHeight();
		if (this.pastClaimDeadline(tip)) {
			throw new SwapError(
				`claim deadline passed: tip ${tip}, refund height ${this.rec.refundHeight}`,
				'deadline'
			);
		}
		if (!this.rec.claim) {
			const output = await this.deps.chain.getOutput(
				funding.txidHex,
				funding.vout
			);
			const verdict = verifyFundingOutput({
				txidHex: funding.txidHex,
				tx: bitcoin.Transaction.fromBuffer(raw),
				vout: funding.vout,
				outputScript: Buffer.from(this.rec.htlcOutputScriptHex, 'hex'),
				onchainAmountSat: BigInt(this.rec.onchainAmountSat),
				output
			});
			if (!verdict.ok || !output) {
				throw new SwapError(
					`funding output is not claimable: ${
						verdict.ok ? 'gone' : verdict.reason
					}`,
					'funding_invalid'
				);
			}
			if (output.confirmations < this.deps.policy.minFundingConfirmations) {
				this.persist({
					state: 'PAYING',
					funding: { ...funding, confirmedHeight: undefined }
				});
				this.deps.log('swap_funding_demoted', {
					swapId: this.rec.swapIdHex,
					confirmations: output.confirmations,
					floor: this.deps.policy.minFundingConfirmations
				});
				throw new SwapError(
					'funding is below the confirmation floor',
					'funding_unconfirmed'
				);
			}
		}
		const attempt = {
			txidHex: built.tx.getId(),
			rawHex: built.tx.toHex(),
			feeSat: built.feeSat.toString(),
			feeRateSatPerVb: built.feeRateSatPerVb,
			builtAt: Date.now()
		};
		// Persisted BEFORE broadcast: a crash after the send still knows the bytes.
		this.persist({
			state: 'CLAIM_BROADCAST',
			claim: { attempts: [...(this.rec.claim?.attempts ?? []), attempt] }
		});
		await this.broadcastLatest(tip);
		return attempt.txidHex;
	}

	private async broadcastLatest(tip: number): Promise<void> {
		const attempts = this.rec.claim!.attempts;
		const latest = attempts[attempts.length - 1];
		try {
			await this.deps.chain.broadcast(latest.rawHex);
			const updated = attempts.map((a, i) =>
				i === attempts.length - 1 && a.broadcastAt === undefined
					? { ...a, broadcastAt: Date.now(), broadcastHeight: tip }
					: a
			);
			this.persist({
				claim: { ...this.rec.claim!, attempts: updated },
				lastError: undefined
			});
			this.deps.log('swap_claim_broadcast', {
				swapId: this.rec.swapIdHex,
				txid: latest.txidHex,
				feeSat: latest.feeSat
			});
		} catch (err) {
			this.persist({
				lastError: err instanceof Error ? err.message : String(err)
			});
			this.deps.log('swap_claim_broadcast_failed', {
				swapId: this.rec.swapIdHex,
				error: String(err)
			});
		}
	}

	private async followClaim(tip: number): Promise<void> {
		const attempts = this.rec.claim?.attempts ?? [];
		for (const a of attempts) {
			const confs = await this.deps.chain.confirmations(
				a.txidHex,
				a.broadcastHeight
			);
			if (confs !== null && confs >= 1) {
				this.persist({
					state: 'CLAIMED',
					claim: {
						...this.rec.claim!,
						confirmedTxidHex: a.txidHex,
						confirmedHeight: tip - confs + 1
					},
					resolution: { kind: 'claim', txidHex: a.txidHex }
				});
				this.deps.log('swap_claimed', {
					swapId: this.rec.swapIdHex,
					txid: a.txidHex
				});
				return;
			}
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
			await this.bumpClaim(tip);
			return;
		}
		await this.broadcastLatest(tip);
	}

	/** Replace the unconfirmed claim with one paying more (BIP 125). */
	async bumpClaim(tip?: number): Promise<string | null> {
		const attempts = this.rec.claim?.attempts ?? [];
		const latest = attempts[attempts.length - 1];
		if (!latest || this.rec.state !== 'CLAIM_BROADCAST') return null;
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
			const { privateKey, preimage } = await reverseSwapSecrets(
				this.rec,
				this.deps.secrets
			);
			built = claimFeeForRate(
				(feeSat) =>
					swaps.buildSwapClaimTx({
						htlc: this.htlc(),
						fundingTransaction: bitcoin.Transaction.fromBuffer(raw),
						outputIndex: funding.vout,
						destinationScript: Buffer.from(
							this.rec.destinationScriptHex,
							'hex'
						),
						feeSatoshis: feeSat,
						privateKey,
						preimage
					}),
				rate,
				this.deps.policy
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
			// The cap is reached: keep the bytes out, nothing more to pay.
			await this.broadcastLatest(height);
			return null;
		}
		const attempt = {
			txidHex: built.tx.getId(),
			rawHex: built.tx.toHex(),
			feeSat: built.feeSat.toString(),
			feeRateSatPerVb: built.feeRateSatPerVb,
			builtAt: Date.now()
		};
		this.persist({
			claim: { ...this.rec.claim!, attempts: [...attempts, attempt] }
		});
		await this.broadcastLatest(height);
		return attempt.txidHex;
	}

	/** Pay if needed, then loop tick() until the swap is terminal or stop(). */
	run(payOpts: { maxFeeSat?: bigint } = {}): Promise<IReverseSwapRecord> {
		if (this.running) return this.running;
		this.running = (async (): Promise<IReverseSwapRecord> => {
			if (
				this.rec.state === 'CREATED' ||
				(this.rec.state === 'PAYING' && !this.paying)
			) {
				const known = await this.deps.payer.trackPayment(
					Buffer.from(this.rec.paymentHashHex, 'hex')
				);
				if (known.status === 'unknown') void this.pay(payOpts);
				else this.recordPayment(known);
			}
			while (!this.stopped && !isTerminalReverseSwapState(this.rec.state)) {
				try {
					await this.tick();
				} catch (err) {
					this.deps.log('swap_tick_failed', {
						swapId: this.rec.swapIdHex,
						error: String(err)
					});
				}
				if (isTerminalReverseSwapState(this.rec.state)) break;
				await new Promise<void>((resolve) => {
					const t = setTimeout(resolve, this.deps.policy.chainPollMs);
					t.unref?.();
					this.wake = (): void => {
						clearTimeout(t);
						resolve();
					};
				});
			}
			// The claim may have settled the payment after the last track.
			await this.refreshPayment();
			return this.record();
		})();
		return this.running;
	}

	private wake: (() => void) | null = null;

	/** Cut a run() wait short (a test that just mined a block). */
	poke(): void {
		this.wake?.();
	}

	/**
	 * Park the swap: no further ticks, and the promise resolves once the
	 * pass in flight (if any) has finished writing. The record is durable
	 * at every step, so `resume()` after a restart, or `run()` again in
	 * this process, continues from exactly where it stopped. A payment
	 * already handed to the node keeps going in the node; a claim already
	 * broadcast keeps confirming; nothing is cancelled by stopping.
	 */
	async stop(): Promise<void> {
		this.stopped = true;
		this.wake?.();
		if (this.ticking) await this.ticking.catch(() => undefined);
		if (this.running) await this.running.catch(() => undefined);
	}
}
