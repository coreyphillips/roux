/**
 * roux's swap records as boltz-client reports its own: SwapInfo for a
 * submarine swap, ReverseSwapInfo for a reverse one, AnySwapInfo for the
 * unified list, and PairInfo for a provider quote. Pure functions.
 *
 * `state` is boltzd's coarse verdict, `status` the Boltz backend event
 * name its clients switch on. roux's states are finer than the first and
 * name no backend, so each maps to the nearest event:
 *
 *   submarine CREATED           PENDING     invoice.set
 *   submarine FUNDING           PENDING     transaction.mempool | .confirmed
 *   submarine FUNDED            PENDING     transaction.confirmed | invoice.pending
 *   submarine SETTLED           SUCCESSFUL  transaction.claimed | invoice.paid
 *   submarine REFUND_BROADCAST  PENDING     swap.expired
 *   submarine REFUNDED          REFUNDED    swap.expired
 *   submarine CANCELLED         ABANDONED   swap.expired
 *   reverse CREATED, PAYING     PENDING     swap.created (transaction.* once funded)
 *   reverse FUNDED              PENDING     transaction.mempool | .confirmed
 *   reverse CLAIM_BROADCAST     PENDING     transaction.confirmed
 *   reverse CLAIMED             SUCCESSFUL  invoice.settled
 *   reverse PAYMENT_FAILED      ERROR       invoice.expired
 *   reverse EXPIRED             ERROR       transaction.refunded | swap.expired
 *
 * Fees split the way boltzd splits them: `service_fee` is the provider's
 * charge beyond miner fees, `onchain_fee` the miner fees (the provider's,
 * and for a reverse swap our own claim). boltzcli dereferences both on a
 * successful swap, so both are always set.
 */

import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { swaps } from 'beignet/lightning';
import { bitcoinNetwork } from '../direct-funding/key-wallet';
import { RouxNetwork } from '../types';
import type { ISwapQuoteResult } from '../swaps/client';
import {
	IReverseSwapRecord,
	ISubmarineSwapRecord,
	isTerminalReverseSwapState,
	isTerminalSubmarineSwapState
} from '../swaps/types';
import type {
	AnySwapInfo,
	Pair,
	PairInfo,
	ReverseSwapInfo,
	SwapInfo,
	SwapState
} from './rpc-types';

export const BTC_PAIR: Pair = { from: 'BTC', to: 'BTC' };

/** boltzd's default tenant, which every swap here belongs to. */
export const DEFAULT_TENANT_ID = 1;

export interface IMappedState {
	state: SwapState;
	status: string;
}

function seconds(ms: number): number {
	return Math.floor(ms / 1000);
}

function sat(value: string | undefined): bigint {
	return value === undefined ? 0n : BigInt(value);
}

/** The address of a native-segwit script, or '' when it has none. */
export function addressOf(scriptHex: string, network: RouxNetwork): string {
	try {
		return bitcoin.address.fromOutputScript(
			Buffer.from(scriptHex, 'hex'),
			bitcoinNetwork(network)
		);
	} catch {
		return '';
	}
}

function witnessScriptHex(rec: {
	paymentHashHex: string;
	claimPubkeyHex: string;
	refundPubkeyHex: string;
	refundHeight: number;
}): string {
	return swaps
		.buildSwapHtlc({
			paymentHash: Buffer.from(rec.paymentHashHex, 'hex'),
			claimPublicKey: Buffer.from(rec.claimPubkeyHex, 'hex'),
			refundPublicKey: Buffer.from(rec.refundPubkeyHex, 'hex'),
			refundHeight: rec.refundHeight
		})
		.witnessScript.toString('hex');
}

function lastAttempt<T>(attempts: T[] | undefined): T | undefined {
	return attempts && attempts.length > 0
		? attempts[attempts.length - 1]
		: undefined;
}

// ─────────────── submarine ───────────────

export function submarineState(rec: ISubmarineSwapRecord): IMappedState {
	switch (rec.state) {
		case 'CREATED':
			return { state: 'PENDING', status: 'invoice.set' };
		case 'FUNDING':
			return {
				state: 'PENDING',
				status: rec.funding?.confirmedHeight
					? 'transaction.confirmed'
					: 'transaction.mempool'
			};
		case 'FUNDED':
			return {
				state: 'PENDING',
				status:
					rec.invoice?.state === 'accepted'
						? 'invoice.pending'
						: 'transaction.confirmed'
			};
		case 'SETTLED':
			return {
				state: 'SUCCESSFUL',
				status:
					rec.resolution?.kind === 'claim'
						? 'transaction.claimed'
						: 'invoice.paid'
			};
		case 'REFUND_BROADCAST':
			return { state: 'PENDING', status: 'swap.expired' };
		case 'REFUNDED':
			return { state: 'REFUNDED', status: 'swap.expired' };
		case 'CANCELLED':
			return { state: 'ABANDONED', status: 'swap.expired' };
	}
}

function submarineFees(rec: ISubmarineSwapRecord): {
	service: bigint;
	onchain: bigint;
} {
	const total = sat(rec.totalFeeSat);
	const miner = sat(rec.minerFeeSat);
	return { service: total - miner, onchain: miner };
}

export function toSwapInfo(
	rec: ISubmarineSwapRecord,
	network: RouxNetwork
): SwapInfo {
	const { state, status } = submarineState(rec);
	const fees = submarineFees(rec);
	const refund = lastAttempt(rec.refund?.attempts);
	return {
		id: rec.swapIdHex,
		pair: BTC_PAIR,
		state,
		error: rec.lastError ?? rec.refundBlockedReason ?? '',
		status,
		private_key: rec.refundPrivkeyHex,
		preimage: rec.invoice?.preimageHex ?? '',
		redeem_script: witnessScriptHex(rec),
		invoice: rec.bolt11,
		lockup_address: rec.htlcAddress,
		expected_amount: Number(rec.onchainAmountSat),
		timeout_block_height: rec.refundHeight,
		lockup_transaction_id:
			rec.funding?.txidHex ?? rec.fundingAttempt?.txidHex ?? '',
		refund_transaction_id:
			rec.refund?.confirmedTxidHex ?? refund?.txidHex ?? '',
		refund_address: addressOf(rec.refundDestinationScriptHex, network),
		chan_ids: [],
		created_at: seconds(rec.createdAt),
		service_fee: Number(fees.service),
		onchain_fee: Number(fees.onchain),
		tenant_id: DEFAULT_TENANT_ID,
		is_auto: false
	};
}

// ─────────────── reverse ───────────────

export function reverseState(rec: IReverseSwapRecord): IMappedState {
	const funded = rec.funding?.confirmedHeight
		? 'transaction.confirmed'
		: 'transaction.mempool';
	switch (rec.state) {
		case 'CREATED':
		case 'PAYING':
			return {
				state: 'PENDING',
				status: rec.funding ? funded : 'swap.created'
			};
		case 'FUNDED':
			return { state: 'PENDING', status: funded };
		case 'CLAIM_BROADCAST':
			return { state: 'PENDING', status: 'transaction.confirmed' };
		case 'CLAIMED':
			return { state: 'SUCCESSFUL', status: 'invoice.settled' };
		case 'PAYMENT_FAILED':
			return { state: 'ERROR', status: 'invoice.expired' };
		case 'EXPIRED':
			return {
				state: 'ERROR',
				status:
					rec.resolution?.kind === 'refund'
						? 'transaction.refunded'
						: 'swap.expired'
			};
	}
}

function reverseFees(rec: IReverseSwapRecord): {
	service: bigint;
	onchain: bigint;
} {
	const total = sat(rec.totalFeeSat);
	const miner = sat(rec.minerFeeSat);
	const claimTxid = rec.claim?.confirmedTxidHex;
	const claim =
		rec.claim?.attempts.find((a) => a.txidHex === claimTxid) ??
		lastAttempt(rec.claim?.attempts);
	return {
		service: total - miner,
		onchain: miner + (claim ? sat(claim.feeSat) : 0n)
	};
}

function reverseError(rec: IReverseSwapRecord): string {
	if (rec.lastError) return rec.lastError;
	if (rec.state === 'PAYMENT_FAILED') {
		return `payment failed${
			rec.payment?.failureReason ? `: ${rec.payment.failureReason}` : ''
		}`;
	}
	if (rec.state === 'EXPIRED') {
		return rec.claimDeadlinePassedAt
			? 'the claim deadline passed before the funding could be claimed'
			: 'the swap expired unclaimed';
	}
	return '';
}

export function toReverseSwapInfo(
	rec: IReverseSwapRecord,
	network: RouxNetwork
): ReverseSwapInfo {
	const { state, status } = reverseState(rec);
	const fees = reverseFees(rec);
	const claim = lastAttempt(rec.claim?.attempts);
	return {
		id: rec.swapIdHex,
		state,
		error: reverseError(rec),
		status,
		private_key: rec.claimPrivkeyHex,
		preimage: rec.preimageHex,
		redeem_script: witnessScriptHex(rec),
		invoice: rec.bolt11,
		claim_address: addressOf(rec.destinationScriptHex, network),
		onchain_amount: Number(rec.onchainAmountSat),
		invoice_amount: Number(sat(rec.invoiceAmountMsat) / 1000n),
		timeout_block_height: rec.refundHeight,
		lockup_transaction_id: rec.funding?.txidHex ?? '',
		claim_transaction_id: rec.claim?.confirmedTxidHex ?? claim?.txidHex ?? '',
		pair: BTC_PAIR,
		chan_ids: [],
		created_at: seconds(rec.createdAt),
		service_fee: Number(fees.service),
		onchain_fee: Number(fees.onchain),
		external_pay: rec.payment?.external === true,
		tenant_id: DEFAULT_TENANT_ID,
		is_auto: false
	};
}

// ─────────────── both ───────────────

export function isPendingSubmarine(rec: ISubmarineSwapRecord): boolean {
	return !isTerminalSubmarineSwapState(rec.state);
}

export function isPendingReverse(rec: IReverseSwapRecord): boolean {
	return !isTerminalReverseSwapState(rec.state);
}

export function toAnySwapInfo(info: SwapInfo | ReverseSwapInfo): AnySwapInfo {
	const submarine = 'expected_amount' in info;
	const from = submarine
		? info.expected_amount
		: (info as ReverseSwapInfo).invoice_amount;
	const serviceFee = info.service_fee ?? 0;
	const onchainFee = info.onchain_fee ?? 0;
	return {
		id: info.id,
		type: submarine ? 'SUBMARINE' : 'REVERSE',
		pair: BTC_PAIR,
		state: info.state,
		error: info.error || undefined,
		status: info.status,
		from_amount: from,
		to_amount: from - serviceFee - onchainFee,
		created_at: info.created_at,
		service_fee: info.service_fee,
		onchain_fee: info.onchain_fee,
		is_auto: false,
		tenant_id: DEFAULT_TENANT_ID
	};
}

// ─────────────── pairs ───────────────

export interface IPairTerms {
	/** The amount-0 quote: the fee terms, the limits and the window. */
	limits: ISwapQuoteResult;
	/** What the provider actually charges at its minimum and its maximum. */
	feeAtMinSat: bigint;
	feeAtMaxSat: bigint;
	/** The miner fee it quoted with those. */
	minerFeeSat: bigint;
	/** roux's invoice slack, which a submarine swap also gives up. */
	slackSat: bigint;
}

/**
 * A provider's terms as a boltz pair. Boltz prices a swap as a percentage
 * plus miner fees; the provider's flat fee, roux's invoice slack and the
 * routing budget a submarine provider charges on the net amount have no
 * slot of their own, so they ride in `miner_fees`, measured at the
 * provider's minimum. Limits are Boltz's, on the invoice, and come from
 * what the provider charges at each end rather than from a fee formula
 * repeated here: the submarine routing budget is not in that formula.
 */
export function toPairInfo(
	direction: 'submarine' | 'reverse',
	terms: IPairTerms
): PairInfo {
	const { limits } = terms;
	const slack = direction === 'submarine' ? terms.slackSat : 0n;
	const invoiceFor = (onchain: bigint, fee: bigint): bigint => {
		if (direction === 'reverse') return onchain + fee;
		return onchain > fee + slack ? onchain - fee - slack : 0n;
	};
	// beignet rounds the proportional part up (swaps.reverseSwapFee).
	const proportionalAtMin =
		(limits.minSwapSat * BigInt(limits.feePpm) + 999_999n) / 1_000_000n;
	const nonProportional = terms.feeAtMinSat + slack - proportionalAtMin;
	const hash = crypto
		.createHash('sha256')
		.update(
			JSON.stringify([
				direction,
				limits.flatFeeSat.toString(),
				limits.feePpm,
				terms.minerFeeSat.toString(),
				terms.feeAtMinSat.toString(),
				terms.feeAtMaxSat.toString(),
				limits.minSwapSat.toString(),
				limits.maxSwapSat.toString(),
				limits.refundDeltaBlocks,
				limits.fundingConfirmations
			])
		)
		.digest('hex');
	return {
		pair: BTC_PAIR,
		fees: {
			percentage: limits.feePpm / 10_000,
			miner_fees: Number(nonProportional > 0n ? nonProportional : 0n)
		},
		limits: {
			minimal: Number(invoiceFor(limits.minSwapSat, terms.feeAtMinSat)),
			maximal: Number(invoiceFor(limits.maxSwapSat, terms.feeAtMaxSat)),
			maximal_zero_conf_amount: 0
		},
		hash
	};
}
