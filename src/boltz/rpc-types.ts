/**
 * The boltzrpc messages roux-boltzd reads and writes, as the proto loader
 * shapes them (see proto.ts): snake_case fields, enum names, numbers for
 * 64-bit integers, undefined for anything unset. Only the subset the
 * daemon serves is spelled out.
 */

export type Currency = 'BTC' | 'LBTC';
export type SwapType = 'SUBMARINE' | 'REVERSE' | 'CHAIN';
export type SwapState =
	| 'PENDING'
	| 'SUCCESSFUL'
	| 'ERROR'
	| 'SERVER_ERROR'
	| 'REFUNDED'
	| 'ABANDONED';
export type IncludeSwaps = 'ALL' | 'MANUAL' | 'AUTO';

export interface Pair {
	from?: Currency;
	to?: Currency;
}

export interface SwapFees {
	percentage: number;
	miner_fees: number;
}

export interface Limits {
	minimal: number;
	maximal: number;
	maximal_zero_conf_amount?: number;
}

export interface PairInfo {
	pair: Pair;
	fees: SwapFees;
	limits: Limits;
	hash: string;
}

export interface SwapInfo {
	id: string;
	pair: Pair;
	state: SwapState;
	error: string;
	status: string;
	private_key: string;
	preimage: string;
	redeem_script: string;
	invoice: string;
	lockup_address: string;
	expected_amount: number;
	timeout_block_height: number;
	lockup_transaction_id: string;
	refund_transaction_id: string;
	refund_address?: string;
	chan_ids: never[];
	created_at: number;
	service_fee?: number;
	onchain_fee?: number;
	tenant_id: number;
	is_auto: boolean;
}

export interface ReverseSwapInfo {
	id: string;
	state: SwapState;
	error: string;
	status: string;
	private_key: string;
	preimage: string;
	redeem_script: string;
	invoice: string;
	claim_address: string;
	onchain_amount: number;
	invoice_amount: number;
	timeout_block_height: number;
	lockup_transaction_id: string;
	claim_transaction_id: string;
	pair: Pair;
	chan_ids: never[];
	created_at: number;
	paid_at?: number;
	service_fee?: number;
	onchain_fee?: number;
	routing_fee_msat?: number;
	external_pay: boolean;
	tenant_id: number;
	is_auto: boolean;
}

export interface AnySwapInfo {
	id: string;
	type: SwapType;
	pair: Pair;
	state: SwapState;
	error?: string;
	status: string;
	from_amount: number;
	to_amount: number;
	created_at: number;
	service_fee?: number;
	onchain_fee?: number;
	is_auto: boolean;
	tenant_id: number;
}

export interface GetSwapInfoResponse {
	swap?: SwapInfo;
	reverse_swap?: ReverseSwapInfo;
}

export interface GetSwapInfoRequest {
	id?: string;
	swap_id?: string;
	payment_hash?: Buffer;
	identifier?: 'swap_id' | 'payment_hash';
}

export interface GetPairInfoRequest {
	type?: SwapType;
	pair?: Pair;
}

export interface GetSwapQuoteRequest {
	type?: SwapType;
	pair?: Pair;
	send_amount?: number;
	receive_amount?: number;
	amount?: 'send_amount' | 'receive_amount';
}

export interface GetSwapQuoteResponse {
	send_amount: number;
	receive_amount: number;
	boltz_fee: number;
	network_fee: number;
	pair_info: PairInfo;
}

export interface ListSwapsRequest {
	from?: Currency;
	to?: Currency;
	state?: SwapState;
	include?: IncludeSwaps;
	limit?: number;
	offset?: number;
	unify?: boolean;
}

export interface ListSwapsResponse {
	swaps: SwapInfo[];
	reverse_swaps: ReverseSwapInfo[];
	chain_swaps: never[];
	all_swaps: AnySwapInfo[];
}

export interface GetStatsRequest {
	include?: IncludeSwaps;
}

export interface SwapStats {
	total_fees: number;
	total_amount: number;
	avg_fees: number;
	avg_amount: number;
	count: number;
	success_count: number;
}

export interface CreateSwapRequest {
	amount?: number;
	pair?: Pair;
	send_from_internal?: boolean;
	refund_address?: string;
	wallet_id?: number;
	invoice?: string;
	zero_conf?: boolean;
	sat_per_vbyte?: number;
	accepted_pair?: PairInfo;
	ignore_mrh?: boolean;
}

export interface CreateSwapResponse {
	id: string;
	address: string;
	expected_amount: number;
	bip21: string;
	tx_id: string;
	timeout_block_height: number;
	timeout_hours: number;
}

export interface CreateReverseSwapRequest {
	amount?: number;
	address?: string;
	accept_zero_conf?: boolean;
	pair?: Pair;
	chan_ids?: string[];
	wallet_id?: number;
	return_immediately?: boolean;
	external_pay?: boolean;
	description?: string;
	description_hash?: Buffer;
	invoice_expiry?: number;
	accepted_pair?: PairInfo;
	routing_fee_limit_ppm?: number;
	add_magic_routing_hint?: boolean;
}

export interface CreateReverseSwapResponse {
	id: string;
	lockup_address: string;
	routing_fee_milli_sat?: number;
	claim_transaction_id?: string;
	invoice?: string;
}

export interface RefundSwapRequest {
	id?: string;
	address?: string;
	wallet_id?: number;
	destination?: 'address' | 'wallet_id';
	lockup_transaction_id?: string;
}

export interface GetInfoResponse {
	version: string;
	node: string;
	network: string;
	node_pubkey: string;
	auto_swap_status: string;
	block_heights: { btc: number };
	refundable_swaps: string[];
	claimable_swaps: string[];
	warnings: string[];
	symbol: string;
	lnd_pubkey: string;
	block_height: number;
	pending_swaps: string[];
	pending_reverse_swaps: string[];
}

export interface GetServiceInfoResponse {
	fees: { percentage: number; miner: { normal: number; reverse: number } };
	limits: Limits;
}
