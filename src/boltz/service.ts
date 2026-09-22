/**
 * boltz-client's RPCs over one BeignetClient: what boltzd does against the
 * Boltz API, done against a beignet provider. BTC submarine and reverse
 * swaps only; everything else answers UNIMPLEMENTED with the reason.
 *
 * Where boltzd and roux differ, the difference is enforced with a clear
 * status rather than papered over:
 *
 *  - A submarine swap pays an invoice of THIS node, minted for the amount
 *    or supplied as a bolt11 the node reports open: roux will not refund
 *    while the node holds the provider's HTLC, and only its own node can
 *    tell it that. Third-party invoices, LNURL, Lightning addresses and
 *    BOLT 12 are refused, and so is an any-amount swap.
 *  - `send_from_internal` funds from the node's own wallet (roux has no
 *    wallets of its own); `wallet_id` is refused.
 *  - Zero-conf is never taken: a claim waits for the policy's
 *    confirmations (at least one). `accept_zero_conf` is accepted and
 *    logged, and still selects boltzd's "wait for the claim" answer.
 *  - `chan_ids` and magic routing hints are refused; an invoice
 *    description or expiry for a reverse swap is the provider's to set and
 *    is ignored with a log line.
 */

import * as grpc from '@grpc/grpc-js';
import { swaps as beignetSwaps } from 'beignet/lightning';
import { BeignetClient } from '../client';
import { EphemeralStorageError } from '../storage';
import { RouxLog, RouxNetwork, noopLog } from '../types';
import { ReverseSwap } from '../swaps/reverse';
import { SubmarineSwap } from '../swaps/submarine';
import { ISwapQuoteResult } from '../swaps/client';
import { decodeSuppliedInvoice, toOutputScript } from '../swaps/verify';
import {
	IReverseSwapChange,
	ISubmarineSwapChange,
	ISwapChain,
	SwapError,
	SwapErrorCode,
	isTerminalReverseSwapState,
	isTerminalSubmarineSwapState
} from '../swaps/types';
import { FeeQuote, reverseOnchainFor, submarineOnchainFor } from './amounts';
import {
	isPendingReverse,
	isPendingSubmarine,
	toAnySwapInfo,
	toPairInfo,
	toReverseSwapInfo,
	toSwapInfo
} from './mapping';
import type { Permission } from './auth';
import type {
	CreateReverseSwapRequest,
	CreateReverseSwapResponse,
	CreateSwapRequest,
	CreateSwapResponse,
	GetInfoResponse,
	GetPairInfoRequest,
	GetServiceInfoResponse,
	GetStatsRequest,
	GetSwapInfoRequest,
	GetSwapInfoResponse,
	GetSwapQuoteRequest,
	GetSwapQuoteResponse,
	ListSwapsRequest,
	ListSwapsResponse,
	Pair,
	PairInfo,
	RefundSwapRequest,
	ReverseSwapInfo,
	SwapInfo,
	SwapStats
} from './rpc-types';

/** A call's failure with the gRPC status it should carry. */
export class RpcError extends Error {
	constructor(
		readonly code: grpc.status,
		message: string
	) {
		super(message);
		this.name = 'RpcError';
	}
}

const SWAP_ERROR_STATUS: Record<SwapErrorCode, grpc.status> = {
	policy: grpc.status.INVALID_ARGUMENT,
	destination: grpc.status.INVALID_ARGUMENT,
	provider_declined: grpc.status.FAILED_PRECONDITION,
	ack_mismatch: grpc.status.ABORTED,
	refund_too_soon: grpc.status.FAILED_PRECONDITION,
	refund_too_late: grpc.status.FAILED_PRECONDITION,
	not_configured: grpc.status.FAILED_PRECONDITION,
	funding_invalid: grpc.status.FAILED_PRECONDITION,
	fee: grpc.status.FAILED_PRECONDITION,
	timeout: grpc.status.UNAVAILABLE,
	deadline: grpc.status.FAILED_PRECONDITION,
	funding_unconfirmed: grpc.status.FAILED_PRECONDITION,
	storage: grpc.status.INTERNAL,
	state: grpc.status.FAILED_PRECONDITION,
	invoice: grpc.status.FAILED_PRECONDITION,
	cltv_unsafe: grpc.status.FAILED_PRECONDITION,
	refund_blocked: grpc.status.FAILED_PRECONDITION,
	already_funded: grpc.status.FAILED_PRECONDITION
};

/** Any error a handler throws, as a gRPC status. */
export function toRpcError(err: unknown): RpcError {
	if (err instanceof RpcError) return err;
	if (err instanceof SwapError) {
		return new RpcError(SWAP_ERROR_STATUS[err.code], err.message);
	}
	if (err instanceof EphemeralStorageError) {
		return new RpcError(grpc.status.FAILED_PRECONDITION, err.message);
	}
	return new RpcError(
		grpc.status.UNKNOWN,
		err instanceof Error ? err.message : String(err)
	);
}

/** Why each RPC roux-boltzd does not serve is left out. */
export const UNIMPLEMENTED_RPCS: Record<string, string> = {
	CreateChainSwap: 'chain swaps are not supported',
	ClaimSwaps:
		'chain swaps are not supported; reverse swaps are claimed automatically',
	Deposit: 'deprecated in boltz-client and not supported',
	CreateChannel: 'deprecated in boltz-client and not supported',
	CreateWallet: 'there are no internal wallets; swaps use the node wallet',
	ImportWallet: 'there are no internal wallets; swaps use the node wallet',
	GetWallets: 'there are no internal wallets; swaps use the node wallet',
	GetWallet: 'there are no internal wallets; swaps use the node wallet',
	GetWalletSendFee: 'there are no internal wallets; swaps use the node wallet',
	ListWalletTransactions:
		'there are no internal wallets; swaps use the node wallet',
	BumpTransaction:
		'refunds and claims are fee-bumped automatically; there are no internal wallets',
	GetWalletCredentials:
		'there are no internal wallets; swaps use the node wallet',
	RemoveWallet: 'there are no internal wallets; swaps use the node wallet',
	WalletSend: 'there are no internal wallets; swaps use the node wallet',
	WalletReceive: 'there are no internal wallets; swaps use the node wallet',
	Unlock: 'there are no encrypted wallets to unlock',
	VerifyWalletPassword: 'there are no encrypted wallets',
	ChangeWalletPassword: 'there are no encrypted wallets',
	CreateTenant: 'tenants are not supported',
	ListTenants: 'tenants are not supported',
	GetTenant: 'tenants are not supported',
	RemoveTenant: 'tenants are not supported',
	BakeMacaroon:
		'baking macaroons is not supported; use the admin or readonly macaroon',
	GetSwapMnemonic:
		'swap keys are random per swap and kept in the swap store, not derived from a mnemonic',
	SetSwapMnemonic:
		'swap keys are random per swap and kept in the swap store, not derived from a mnemonic'
};

export interface IBoltzServiceOptions {
	client: BeignetClient;
	/** The same chain source the client's swaps use. */
	chain: ISwapChain;
	/** The beignet provider's node id (hex). */
	provider: string;
	network: RouxNetwork;
	/** GetInfo.node: which Lightning node the client drives ('lnd', 'cln'). */
	node?: string;
	/** GetInfo.version. */
	version?: string;
	/**
	 * Default Lightning fee limit for reverse swaps, in ppm of the invoice
	 * (boltz.toml `[LIGHTNING] routingFeeLimitPpm`); the swap policy's
	 * otherwise.
	 */
	routingFeeLimitPpm?: number;
	/** Called before any call that talks to the provider (reconnect). */
	ensureProvider?: () => Promise<void>;
	/** Called once Stop has answered. */
	onStop?: () => void;
	log?: RouxLog;
}

/** Who is calling, as the transport authenticated them. */
export interface ICallContext {
	permission: Permission;
}

const ADMIN: ICallContext = { permission: 'admin' };

type Direction = 'submarine' | 'reverse';

export class BoltzService {
	private readonly log: RouxLog;

	constructor(private readonly options: IBoltzServiceOptions) {
		this.log = options.log ?? noopLog;
	}

	private get swaps(): BeignetClient['swaps'] {
		return this.options.client.swaps;
	}

	// ─────────────── helpers ───────────────

	private assertBtc(pair: Pair | undefined): void {
		if (pair?.from === 'LBTC' || pair?.to === 'LBTC') {
			throw new RpcError(
				grpc.status.INVALID_ARGUMENT,
				'roux-boltzd serves BTC only; Liquid is not supported'
			);
		}
	}

	private script(address: string): Buffer {
		try {
			return toOutputScript(address, this.options.network);
		} catch (err) {
			throw new RpcError(
				grpc.status.INVALID_ARGUMENT,
				`invalid address ${address}: ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}
	}

	private async rawQuote(
		direction: Direction,
		amountSat: bigint
	): Promise<ISwapQuoteResult> {
		await this.options.ensureProvider?.();
		return this.swaps.quote(this.options.provider, { direction, amountSat });
	}

	private async quote(
		direction: Direction,
		amountSat: bigint
	): Promise<ISwapQuoteResult> {
		const q = await this.rawQuote(direction, amountSat);
		if (!q.accepted) {
			throw new RpcError(
				grpc.status.FAILED_PRECONDITION,
				`the provider declined the quote: ${q.reason ?? 'no reason given'}`
			);
		}
		return q;
	}

	/**
	 * The provider's fee as a function of the on-chain amount, for the
	 * amount searches. A probe outside the provider's limits is not a
	 * question it answers (the submarine search starts below the minimum by
	 * construction, and the reverse one above the maximum), so a probe is
	 * clamped into the limits; the amount the search settles on is checked
	 * against them afterwards.
	 */
	private feeProbe(direction: Direction, limits: ISwapQuoteResult): FeeQuote {
		return async (onchain) => {
			let probe = onchain;
			if (limits.minSwapSat > 0n && probe < limits.minSwapSat) {
				probe = limits.minSwapSat;
			}
			if (limits.maxSwapSat > 0n && probe > limits.maxSwapSat) {
				probe = limits.maxSwapSat;
			}
			return (await this.quote(direction, probe)).totalFeeSat;
		};
	}

	/** The on-chain amount for a Lightning amount, inside the limits. */
	private async onchainFor(
		direction: Direction,
		invoiceSat: bigint,
		limits?: ISwapQuoteResult
	): Promise<bigint> {
		const terms = limits ?? (await this.quote(direction, 0n));
		const probe = this.feeProbe(direction, terms);
		let onchain: bigint;
		try {
			onchain =
				direction === 'submarine'
					? await submarineOnchainFor(
							invoiceSat,
							probe,
							this.swaps.policy.submarineFeeSlackSat
					  )
					: await reverseOnchainFor(invoiceSat, probe);
		} catch (err) {
			if (err instanceof RpcError) throw err;
			throw new RpcError(
				grpc.status.INVALID_ARGUMENT,
				err instanceof Error ? err.message : String(err)
			);
		}
		this.assertWithinLimits(onchain, terms);
		return onchain;
	}

	private assertWithinLimits(
		onchainSat: bigint,
		limits: ISwapQuoteResult
	): void {
		const outside =
			limits.minSwapSat > 0n && onchainSat < limits.minSwapSat
				? `below the provider's minimum ${limits.minSwapSat}`
				: limits.maxSwapSat > 0n && onchainSat > limits.maxSwapSat
				? `above the provider's maximum ${limits.maxSwapSat}`
				: null;
		if (outside) {
			throw new RpcError(
				grpc.status.INVALID_ARGUMENT,
				`the swap's on-chain amount ${onchainSat} is ${outside}`
			);
		}
	}

	/** What the provider charges at an amount, priced from its terms when it declines that end. */
	private async feeAt(
		direction: Direction,
		amountSat: bigint
	): Promise<{ totalFeeSat: bigint; minerFeeSat: bigint }> {
		const q = await this.rawQuote(direction, amountSat);
		if (q.accepted) return q;
		return {
			totalFeeSat: beignetSwaps.reverseSwapFee(amountSat, {
				flatFeeSat: q.flatFeeSat,
				feePpm: q.feePpm,
				minerFeeSat: q.minerFeeSat
			}),
			minerFeeSat: q.minerFeeSat
		};
	}

	private async pairInfo(direction: Direction): Promise<PairInfo> {
		const limits = await this.quote(direction, 0n);
		const min = limits.minSwapSat > 0n ? limits.minSwapSat : 1n;
		const max = limits.maxSwapSat > min ? limits.maxSwapSat : min;
		const [atMin, atMax] = await Promise.all([
			this.feeAt(direction, min),
			this.feeAt(direction, max)
		]);
		return toPairInfo(direction, {
			limits,
			feeAtMinSat: atMin.totalFeeSat,
			feeAtMaxSat: atMax.totalFeeSat,
			minerFeeSat: atMin.minerFeeSat,
			slackSat: this.swaps.policy.submarineFeeSlackSat
		});
	}

	private checkAcceptedPair(
		accepted: PairInfo | undefined,
		current: PairInfo
	): void {
		if (accepted?.hash && accepted.hash !== current.hash) {
			throw new RpcError(
				grpc.status.FAILED_PRECONDITION,
				"the provider's terms changed since accepted_pair was quoted; fetch the pair again"
			);
		}
	}

	private findSubmarine(id: string): SubmarineSwap | null {
		return this.swaps.submarine.get(id.toLowerCase());
	}

	private findReverse(id: string): ReverseSwap | null {
		return this.swaps.reverse.get(id.toLowerCase());
	}

	private swapInfo(swap: SubmarineSwap, ctx: ICallContext): SwapInfo {
		return redactSwap(toSwapInfo(swap.record(), this.options.network), ctx);
	}

	private reverseInfo(swap: ReverseSwap, ctx: ICallContext): ReverseSwapInfo {
		return redactReverse(
			toReverseSwapInfo(swap.record(), this.options.network),
			ctx
		);
	}

	private follow(
		swap: SubmarineSwap | ReverseSwap,
		run: Promise<unknown>
	): void {
		run.catch((err) =>
			this.log('boltz_swap_run_failed', {
				swapId: swap.swapIdHex,
				error: err instanceof Error ? err.message : String(err)
			})
		);
	}

	// ─────────────── info ───────────────

	async getInfo(): Promise<GetInfoResponse> {
		const height = await this.options.chain.currentHeight();
		const submarine = this.swaps.submarine.list().map((s) => s.record());
		const reverse = this.swaps.reverse.list().map((s) => s.record());
		const pendingSwaps = submarine
			.filter(isPendingSubmarine)
			.map((r) => r.swapIdHex);
		const pendingReverse = reverse
			.filter(isPendingReverse)
			.map((r) => r.swapIdHex);
		const warnings: string[] = [];
		if (!this.options.client.isConnected(this.options.provider)) {
			warnings.push(
				`not connected to the beignet provider ${this.options.provider}`
			);
		}
		const nodePubkey = this.options.client.nodeIdHex();
		return {
			version: this.options.version ?? 'roux-boltzd',
			node: this.options.node ?? 'roux',
			network: this.options.network,
			node_pubkey: nodePubkey,
			auto_swap_status: 'disabled',
			block_heights: { btc: height },
			// Refunds are automatic; these are the ones held for the operator.
			refundable_swaps: submarine
				.filter((r) => isPendingSubmarine(r) && r.refundBlockedReason)
				.map((r) => r.swapIdHex),
			claimable_swaps: [],
			warnings,
			symbol: 'BTC',
			lnd_pubkey: nodePubkey,
			block_height: height,
			pending_swaps: pendingSwaps,
			pending_reverse_swaps: pendingReverse
		};
	}

	async getPairInfo(req: GetPairInfoRequest): Promise<PairInfo> {
		this.assertBtc(req.pair);
		const type = req.type ?? 'SUBMARINE';
		if (type === 'CHAIN') {
			throw new RpcError(
				grpc.status.UNIMPLEMENTED,
				'chain swaps are not supported'
			);
		}
		return this.pairInfo(type === 'REVERSE' ? 'reverse' : 'submarine');
	}

	async getPairs(): Promise<{
		submarine: PairInfo[];
		reverse: PairInfo[];
		chain: PairInfo[];
	}> {
		const [submarine, reverse] = await Promise.all([
			this.pairInfo('submarine'),
			this.pairInfo('reverse')
		]);
		return { submarine: [submarine], reverse: [reverse], chain: [] };
	}

	async getServiceInfo(): Promise<GetServiceInfoResponse> {
		const [submarine, reverse] = await Promise.all([
			this.pairInfo('submarine'),
			this.pairInfo('reverse')
		]);
		return {
			fees: {
				percentage: submarine.fees.percentage,
				miner: {
					normal: submarine.fees.miner_fees,
					reverse: reverse.fees.miner_fees
				}
			},
			limits: submarine.limits
		};
	}

	async getSwapQuote(req: GetSwapQuoteRequest): Promise<GetSwapQuoteResponse> {
		this.assertBtc(req.pair);
		const type = req.type ?? 'SUBMARINE';
		if (type === 'CHAIN') {
			throw new RpcError(
				grpc.status.UNIMPLEMENTED,
				'chain swaps are not supported'
			);
		}
		const send = req.amount === 'send_amount' ? req.send_amount : undefined;
		const receive =
			req.amount === 'receive_amount' ? req.receive_amount : undefined;
		if (!send && !receive) {
			throw new RpcError(
				grpc.status.INVALID_ARGUMENT,
				'either send_amount or receive_amount must be specified'
			);
		}
		const direction: Direction = type === 'REVERSE' ? 'reverse' : 'submarine';
		const pairInfo = await this.pairInfo(direction);
		const slack = this.swaps.policy.submarineFeeSlackSat;
		let sendSat: bigint;
		let receiveSat: bigint;
		let q: ISwapQuoteResult;
		if (direction === 'submarine') {
			// Send on chain, receive the invoice.
			const onchain = send
				? BigInt(send)
				: await this.onchainFor('submarine', BigInt(receive!));
			q = await this.quote('submarine', onchain);
			sendSat = onchain;
			receiveSat = onchain - q.totalFeeSat - slack;
		} else {
			// Pay the invoice, receive on chain.
			const onchain = receive
				? BigInt(receive)
				: await this.onchainFor('reverse', BigInt(send!));
			q = await this.quote('reverse', onchain);
			sendSat = onchain + q.totalFeeSat;
			receiveSat = onchain;
		}
		if (receiveSat <= 0n) {
			throw new RpcError(
				grpc.status.INVALID_ARGUMENT,
				'the amount does not cover the fees'
			);
		}
		// Boltz's limits: on the invoice, received or paid.
		const checked = direction === 'submarine' ? receiveSat : sendSat;
		if (checked < BigInt(pairInfo.limits.minimal)) {
			throw new RpcError(
				grpc.status.INVALID_ARGUMENT,
				`amount ${checked} is below minimum ${pairInfo.limits.minimal}`
			);
		}
		if (checked > BigInt(pairInfo.limits.maximal)) {
			throw new RpcError(
				grpc.status.INVALID_ARGUMENT,
				`amount ${checked} exceeds maximum ${pairInfo.limits.maximal}`
			);
		}
		const serviceFee =
			q.totalFeeSat - q.minerFeeSat + (direction === 'submarine' ? slack : 0n);
		return {
			send_amount: Number(sendSat),
			receive_amount: Number(receiveSat),
			boltz_fee: Number(serviceFee),
			network_fee: Number(q.minerFeeSat),
			pair_info: pairInfo
		};
	}

	async getSwapInfo(
		req: GetSwapInfoRequest,
		ctx: ICallContext = ADMIN
	): Promise<GetSwapInfoResponse> {
		const id = req.swap_id || req.id;
		if (id) {
			const reverse = this.findReverse(id);
			if (reverse) return { reverse_swap: this.reverseInfo(reverse, ctx) };
			const submarine = this.findSubmarine(id);
			if (submarine) return { swap: this.swapInfo(submarine, ctx) };
			throw new RpcError(
				grpc.status.NOT_FOUND,
				`could not find Swap with ID ${id}`
			);
		}
		if (req.payment_hash && req.payment_hash.length > 0) {
			const hash = Buffer.from(req.payment_hash).toString('hex');
			const swap = this.swaps.submarine
				.list()
				.find((s) => s.record().paymentHashHex === hash);
			if (!swap) {
				throw new RpcError(
					grpc.status.NOT_FOUND,
					'could not find Swap with payment hash'
				);
			}
			return { swap: this.swapInfo(swap, ctx) };
		}
		throw new RpcError(
			grpc.status.INVALID_ARGUMENT,
			'no ID or payment hash provided'
		);
	}

	/**
	 * GetSwapInfoStream. One swap: its current info, then one message per
	 * state change, ending once it is final. No id (or "*"): every change of
	 * every swap, until the caller cancels. Returns the unsubscribe.
	 */
	streamSwapInfo(
		req: GetSwapInfoRequest,
		send: (info: GetSwapInfoResponse) => void,
		end: () => void,
		ctx: ICallContext = ADMIN
	): Promise<() => void> {
		const id = (req.swap_id || req.id || '').toLowerCase();
		const onReverse = (change: IReverseSwapChange): GetSwapInfoResponse => ({
			reverse_swap: redactReverse(
				toReverseSwapInfo(change.record, this.options.network),
				ctx
			)
		});
		const onSubmarine = (
			change: ISubmarineSwapChange
		): GetSwapInfoResponse => ({
			swap: redactSwap(toSwapInfo(change.record, this.options.network), ctx)
		});
		if (id === '' || id === '*') {
			const offReverse = this.swaps.reverse.onChange((c) => send(onReverse(c)));
			const offSubmarine = this.swaps.submarine.onChange((c) =>
				send(onSubmarine(c))
			);
			return Promise.resolve(() => {
				offReverse();
				offSubmarine();
			});
		}
		// Subscribe first, then send the current info: a change landing in
		// between is sent twice rather than missed.
		return this.getSwapInfo({ swap_id: id }, ctx).then((found) => {
			const isReverse = found.reverse_swap !== undefined;
			let finished = false;
			const finish = (): void => {
				if (finished) return;
				finished = true;
				off();
				end();
			};
			const off = isReverse
				? this.swaps.reverse.onChange((c) => {
						if (c.swapIdHex !== id || finished) return;
						send(onReverse(c));
						if (isTerminalReverseSwapState(c.to)) finish();
				  })
				: this.swaps.submarine.onChange((c) => {
						if (c.swapIdHex !== id || finished) return;
						send(onSubmarine(c));
						if (isTerminalSubmarineSwapState(c.to)) finish();
				  });
			const terminal = isReverse
				? isTerminalReverseSwapState(this.findReverse(id)!.state)
				: isTerminalSubmarineSwapState(this.findSubmarine(id)!.state);
			send(
				isReverse
					? { reverse_swap: this.reverseInfo(this.findReverse(id)!, ctx) }
					: { swap: this.swapInfo(this.findSubmarine(id)!, ctx) }
			);
			if (terminal) finish();
			return () => {
				finished = true;
				off();
			};
		});
	}

	async listSwaps(
		req: ListSwapsRequest,
		ctx: ICallContext = ADMIN
	): Promise<ListSwapsResponse> {
		const empty: ListSwapsResponse = {
			swaps: [],
			reverse_swaps: [],
			chain_swaps: [],
			all_swaps: []
		};
		if (!req.unify && (req.offset !== undefined || req.limit !== undefined)) {
			throw new RpcError(
				grpc.status.INVALID_ARGUMENT,
				'offset and limit are only supported with unify'
			);
		}
		// Everything here is BTC and made by hand; Liquid and autoswap filters match nothing.
		if (req.from === 'LBTC' || req.to === 'LBTC' || req.include === 'AUTO') {
			return empty;
		}
		const keep = (info: { state: string }): boolean =>
			req.state === undefined || info.state === req.state;
		const swaps = this.swaps.submarine
			.list()
			.map((s) => this.swapInfo(s, ctx))
			.filter(keep);
		const reverse = this.swaps.reverse
			.list()
			.map((s) => this.reverseInfo(s, ctx))
			.filter(keep);
		if (!req.unify) return { ...empty, swaps, reverse_swaps: reverse };
		const all = [...swaps, ...reverse]
			.map(toAnySwapInfo)
			.sort((a, b) => b.created_at - a.created_at);
		const offset = req.offset ?? 0;
		const limited =
			req.limit !== undefined
				? all.slice(offset, offset + req.limit)
				: all.slice(offset);
		return { ...empty, all_swaps: limited };
	}

	async getStats(req: GetStatsRequest): Promise<{ stats: SwapStats }> {
		const stats: SwapStats = {
			total_fees: 0,
			total_amount: 0,
			avg_fees: 0,
			avg_amount: 0,
			count: 0,
			success_count: 0
		};
		if (req.include === 'AUTO') return { stats };
		const infos = [
			...this.swaps.submarine.list().map((s) => this.swapInfo(s, ADMIN)),
			...this.swaps.reverse.list().map((s) => this.reverseInfo(s, ADMIN))
		].map(toAnySwapInfo);
		stats.count = infos.length;
		for (const info of infos) {
			if (info.state !== 'SUCCESSFUL') continue;
			stats.success_count++;
			stats.total_amount += info.from_amount;
			stats.total_fees += (info.service_fee ?? 0) + (info.onchain_fee ?? 0);
		}
		if (stats.success_count > 0) {
			stats.avg_fees = Math.round(stats.total_fees / stats.success_count);
			stats.avg_amount = Math.round(stats.total_amount / stats.success_count);
		}
		return { stats };
	}

	// ─────────────── submarine ───────────────

	async createSwap(req: CreateSwapRequest): Promise<CreateSwapResponse> {
		this.assertBtc(req.pair);
		if (req.wallet_id !== undefined) {
			throw new RpcError(
				grpc.status.FAILED_PRECONDITION,
				"roux-boltzd has no internal wallets: send_from_internal funds the swap from the node's own wallet"
			);
		}
		const invoice = req.invoice || undefined;
		let amountSat: bigint;
		if (invoice) {
			let decoded;
			try {
				decoded = decodeSuppliedInvoice(invoice);
			} catch {
				throw new RpcError(
					grpc.status.INVALID_ARGUMENT,
					'roux-boltzd takes a bolt11 invoice of this node (not LNURL, a Lightning address or BOLT 12)'
				);
			}
			if (!decoded.amountMsat) {
				throw new RpcError(
					grpc.status.INVALID_ARGUMENT,
					'0 amount invoices are not supported'
				);
			}
			if (decoded.amountMsat % 1000n !== 0n) {
				throw new RpcError(
					grpc.status.INVALID_ARGUMENT,
					'the invoice amount must be whole satoshis'
				);
			}
			amountSat = decoded.amountMsat / 1000n;
		} else {
			if (!req.amount) {
				throw new RpcError(
					grpc.status.INVALID_ARGUMENT,
					'amount is required: roux-boltzd mints an invoice of this node for it (any-amount swaps are not supported)'
				);
			}
			amountSat = BigInt(req.amount);
		}
		const refundScript = req.refund_address
			? this.script(req.refund_address)
			: undefined;
		if (req.accepted_pair?.hash) {
			this.checkAcceptedPair(
				req.accepted_pair,
				await this.pairInfo('submarine')
			);
		}
		const onchain = await this.onchainFor('submarine', amountSat);
		const swap = await this.swaps.submarine.create(this.options.provider, {
			amountSat: onchain,
			invoice,
			refundDestinationScript: refundScript
		});
		let txId = '';
		if (req.send_from_internal) {
			try {
				txId = await swap.fund({ feeRateSatPerVb: req.sat_per_vbyte });
			} catch (err) {
				// The attempt is on the record: the loop still watches for a
				// funding the wallet may have sent before it failed.
				this.follow(swap, swap.run({ fund: false }));
				throw err;
			}
		}
		this.follow(swap, swap.run({ fund: false }));
		const rec = swap.record();
		const height = await this.options.chain.currentHeight();
		this.log('boltz_swap_created', {
			swapId: rec.swapIdHex,
			invoiceSat: amountSat.toString(),
			onchainSat: rec.onchainAmountSat,
			funded: txId !== ''
		});
		return {
			id: rec.swapIdHex,
			address: rec.htlcAddress,
			expected_amount: Number(rec.onchainAmountSat),
			bip21: bip21(rec.htlcAddress, BigInt(rec.onchainAmountSat)),
			tx_id: txId,
			timeout_block_height: rec.refundHeight,
			timeout_hours: blocksToHours(rec.refundHeight - height)
		};
	}

	async refundSwap(
		req: RefundSwapRequest,
		ctx: ICallContext = ADMIN
	): Promise<GetSwapInfoResponse> {
		const id = req.id ?? '';
		const swap = this.findSubmarine(id);
		if (!swap) {
			throw new RpcError(
				grpc.status.NOT_FOUND,
				`no refundable swap with id ${id} found`
			);
		}
		if (req.destination === 'wallet_id' || req.wallet_id !== undefined) {
			throw new RpcError(
				grpc.status.FAILED_PRECONDITION,
				'roux-boltzd has no internal wallets: refund to an address'
			);
		}
		if (req.lockup_transaction_id && !swap.record().funding) {
			await swap.attachFunding(req.lockup_transaction_id);
		}
		if (req.address) {
			await swap.setRefundDestination(this.script(req.address));
		}
		const rec = swap.record();
		const height = await this.options.chain.currentHeight();
		if (height < rec.refundHeight) {
			throw new RpcError(
				grpc.status.FAILED_PRECONDITION,
				`not refundable before block ${rec.refundHeight} (tip ${height})${
					req.address ? '; the new refund address is saved' : ''
				}; roux refunds automatically then`
			);
		}
		await swap.refund();
		return this.getSwapInfo({ swap_id: rec.swapIdHex }, ctx);
	}

	// ─────────────── reverse ───────────────

	async createReverseSwap(
		req: CreateReverseSwapRequest,
		cancelled?: Promise<void>
	): Promise<CreateReverseSwapResponse> {
		this.assertBtc(req.pair);
		if (req.chan_ids && req.chan_ids.length > 0) {
			throw new RpcError(
				grpc.status.FAILED_PRECONDITION,
				'chan_ids is not supported: the node routes the payment'
			);
		}
		if (req.wallet_id !== undefined) {
			throw new RpcError(
				grpc.status.FAILED_PRECONDITION,
				"roux-boltzd has no internal wallets: pass an address, or none for a fresh address of the node's wallet"
			);
		}
		if (req.add_magic_routing_hint) {
			throw new RpcError(
				grpc.status.FAILED_PRECONDITION,
				'magic routing hints are not supported'
			);
		}
		const external = req.external_pay === true;
		if (external && req.return_immediately === false) {
			throw new RpcError(
				grpc.status.INVALID_ARGUMENT,
				'can not wait for swap transaction when using external pay'
			);
		}
		if (!req.amount) {
			throw new RpcError(grpc.status.INVALID_ARGUMENT, 'amount is required');
		}
		if (
			req.description ||
			(req.description_hash && req.description_hash.length > 0) ||
			req.invoice_expiry
		) {
			this.log('boltz_invoice_terms_ignored', {
				reason: "the provider mints the reverse swap's invoice"
			});
		}
		if (req.accept_zero_conf) {
			this.log('boltz_zero_conf_ignored', {
				minFundingConfirmations: this.swaps.policy.minFundingConfirmations
			});
		}
		const destination = req.address ? this.script(req.address) : undefined;
		if (req.accepted_pair?.hash) {
			this.checkAcceptedPair(req.accepted_pair, await this.pairInfo('reverse'));
		}
		const invoiceSat = BigInt(req.amount);
		const onchain = await this.onchainFor('reverse', invoiceSat);
		const swap = await this.swaps.reverse.create(this.options.provider, {
			amountSat: onchain,
			destinationScript: destination
		});
		if (external) swap.expectExternalPayment();
		const ppm = req.routing_fee_limit_ppm ?? this.options.routingFeeLimitPpm;
		const maxFeeSat =
			ppm !== undefined
				? routingFeeLimit(invoiceSat, ppm, this.swaps.policy.minLightningFeeSat)
				: undefined;
		this.follow(swap, swap.run({ maxFeeSat }));
		const rec = swap.record();
		this.log('boltz_reverse_swap_created', {
			swapId: rec.swapIdHex,
			invoiceSat: invoiceSat.toString(),
			onchainSat: rec.onchainAmountSat,
			external
		});
		const response: CreateReverseSwapResponse = {
			id: rec.swapIdHex,
			lockup_address: rec.htlcAddress,
			invoice: rec.bolt11
		};
		if (!external && req.accept_zero_conf && req.return_immediately !== true) {
			// boltzd answers once the claim is out; so does this, at the depth
			// roux claims at.
			response.claim_transaction_id = await this.waitForClaim(
				rec.swapIdHex,
				cancelled
			);
		}
		return response;
	}

	private waitForClaim(
		swapIdHex: string,
		cancelled?: Promise<void>
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const settle = (): boolean => {
				const rec = this.findReverse(swapIdHex)!.record();
				const claim =
					rec.claim?.confirmedTxidHex ??
					rec.claim?.attempts[rec.claim.attempts.length - 1]?.txidHex;
				if (claim) {
					resolve(claim);
					return true;
				}
				if (isTerminalReverseSwapState(rec.state)) {
					const info = toReverseSwapInfo(rec, this.options.network);
					reject(
						new RpcError(
							grpc.status.ABORTED,
							`reverse swap failed: ${info.error || info.status}`
						)
					);
					return true;
				}
				return false;
			};
			if (settle()) return;
			const off = this.swaps.reverse.onChange((change) => {
				if (change.swapIdHex === swapIdHex && settle()) off();
			});
			cancelled?.then(() => {
				off();
				reject(new RpcError(grpc.status.CANCELLED, 'call cancelled'));
			});
		});
	}

	// ─────────────── lifecycle ───────────────

	stop(): void {
		setImmediate(() => this.options.onStop?.());
	}
}

function redactSwap(info: SwapInfo, ctx: ICallContext): SwapInfo {
	return ctx.permission === 'admin'
		? info
		: { ...info, private_key: '', preimage: '' };
}

function redactReverse(
	info: ReverseSwapInfo,
	ctx: ICallContext
): ReverseSwapInfo {
	// The claim key and the preimage are enough to take a reverse swap's
	// funding: they never leave through a read-only macaroon.
	return ctx.permission === 'admin'
		? info
		: { ...info, private_key: '', preimage: '' };
}

function routingFeeLimit(
	invoiceSat: bigint,
	ppm: number,
	floorSat: bigint
): bigint {
	const fee = (invoiceSat * BigInt(Math.floor(ppm))) / 1_000_000n;
	return fee > floorSat ? fee : floorSat;
}

function blocksToHours(blocks: number): number {
	return Math.max(0, (blocks * 10) / 60);
}

function formatBtc(sats: bigint): string {
	const whole = sats / 100_000_000n;
	const fraction = (sats % 100_000_000n)
		.toString()
		.padStart(8, '0')
		.replace(/0+$/, '');
	return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** The BIP 21 URI boltzd hands out for a submarine swap's lockup. */
export function bip21(address: string, sats: bigint): string {
	return `bitcoin:${address}?amount=${formatBtc(
		sats
	)}&label=${encodeURIComponent('Send to BTC lightning')}`;
}
