/**
 * roux: the client that goes with beignet.
 *
 * Request liquidity services from an enabled beignet node through a
 * supported node link and wallet adapter. Three protocols use beignet's
 * custom peer message type 44069; the provider side of each is beignet.
 *
 *  - JIT inbound liquidity (`client.jit`): register a receive intent with
 *    a beignet LSP, get an intercept short channel id for your invoice, and
 *    the LSP opens a zero-conf channel to you when the payment arrives.
 *  - Direct funding (`client.directFunding`): pay a beignet wallet's BIP 21
 *    request by making your on-chain coin the input of its channel funding
 *    transaction, verified and attested before you sign.
 *  - Reverse swaps (`client.swaps.reverse`): move Lightning balance to the
 *    chain. Pay a beignet provider's hold invoice for a hash you hold the
 *    preimage of, verify the contract it funds, claim it to your own wallet;
 *    the claim settles the hold.
 *  - Submarine swaps (`client.swaps.submarine`): move on-chain coins to
 *    Lightning balance. Mint an invoice on your node, verify the contract
 *    the provider offers, fund it; the provider pays your invoice and
 *    claims the coins with the preimage, or you refund after the height.
 */

export { BeignetClient } from './client';
export type { IBeignetClientOptions } from './client';

export type { RouxLog, RouxNetwork, Sats } from './types';
export { consoleLog, noopLog, toBeignetNetwork } from './types';

export { formatNodeUri, parseNodeUri } from './uri';
export type { INodeUri } from './uri';

export {
	EphemeralStorageError,
	FileStorage,
	MemoryStorage,
	isEphemeralStorage
} from './storage';
export type { IWalletDataStorage } from './storage';
export { createLndClient } from './lnd';
export type { ILndClientOptions } from './lnd';
export { createClnClient } from './cln';
export type { IClnClientOptions } from './cln';

export { deliverIsolated } from './link/types';
export type { ICustomMessage, IPeerLink } from './link/types';
export { NoisePeerLink, webSocketSocketFactory } from './link/noise-link';
export type { INoisePeerLinkOptions } from './link/noise-link';
export { LndPeerLink } from './link/lnd-link';
export type { ILndPeerLinkOptions } from './link/lnd-link';
export { ClnPeerLink } from './link/cln-link';
export { BridgePeerLink } from './link/bridge-link';
export type { IBridgePeerLinkOptions } from './link/bridge-link';
export type {
	ClnNotificationSource,
	IClnPeerLinkOptions
} from './link/cln-link';
export { HttpError } from './link/http';
export { clnSocketIoNotifications } from './link/cln-socketio';
export type { IClnSocketIoOptions } from './link/cln-socketio';

export {
	JIT_DEFAULT_EXPIRY_SECONDS,
	JIT_DEFAULT_MAX_AMOUNT_SAT,
	JIT_DEFAULT_MAX_FEE_PPM,
	JIT_DEFAULT_MAX_FLAT_FEE_SAT,
	JIT_HINT_CLTV_DELTA,
	JIT_MIN_FINAL_CLTV_EXPIRY,
	JIT_REPLY_TIMEOUT_MS,
	JitClient,
	JitDeclinedError
} from './jit/client';
export type {
	IJitAuthorizeParams,
	IJitClientOptions,
	IJitGrant,
	IJitQuote,
	IJitQuoteParams,
	IJitRouteHint,
	ILndHopHint,
	JitFeeMode
} from './jit/client';

export {
	DirectFundingClient,
	DirectFundingErrorCode,
	extractRequest
} from './direct-funding/client';
export type {
	DirectFundingError,
	IDirectFundingClientOptions,
	IDirectFundingPayment,
	IDirectFundingRequestInfo,
	IDirectFundingResult,
	IDirectFundingTransportInfo,
	IPayRequestOptions
} from './direct-funding/client';
export {
	KeyedUtxoWallet,
	bitcoinNetwork,
	coinKindOf,
	taprootTweakPrivateKey
} from './direct-funding/key-wallet';
export type {
	CoinKind,
	IKeyedCoin,
	IKeyedUtxoWalletOptions
} from './direct-funding/key-wallet';

/** The beignet types a host implementing its own wallet or link needs. */
import type { directFunding as _df } from 'beignet/lightning';
export type IDfCoinSigner = _df.IDfCoinSigner;
export type IDfCustomMessage = _df.IDfCustomMessage;
export type IDfPeerMessaging = _df.IDfPeerMessaging;
export type IDfSenderCoin = _df.IDfSenderCoin;
export type IDfSenderConfig = _df.IDfSenderConfig;
export type IDfSenderWallet = _df.IDfSenderWallet;
export type IDfSendResult = _df.IDfSendResult;
export type IDfPaymentRecord = _df.IDfPaymentRecord;
export { exchange } from './link/exchange';
export type { IExchangeParams } from './link/exchange';

export { ReverseSwapClient, SwapClient } from './swaps/client';
export { SubmarineSwapClient } from './swaps/submarine-client';
export type {
	ISubmarineResumeReport,
	ISubmarineSwapCreateParams
} from './swaps/submarine-client';
export { SubmarineSwap } from './swaps/submarine';
export type { ISubmarineSwapStatus } from './swaps/submarine';
export { LndFunder } from './swaps/lnd-funder';
export type { ILndFunderOptions } from './swaps/lnd-funder';
export { ClnFunder } from './swaps/cln-funder';
export type { IClnFunderOptions } from './swaps/cln-funder';
export type {
	IReverseSwapCreateParams,
	IResumeReport,
	ISwapClientOptions,
	ISwapQuoteParams,
	ISwapQuoteResult
} from './swaps/client';
export { ReverseSwap } from './swaps/reverse';
export type { IReverseSwapStatus } from './swaps/reverse';
export {
	SWAP_DEFAULT_POLICY,
	SwapError,
	isTerminalReverseSwapState,
	isTerminalSubmarineSwapState,
	resolvePolicy
} from './swaps/types';
export type {
	IReverseSwapClaimAttempt,
	IReverseSwapChange,
	IReverseSwapRecord,
	ISubmarineSwapChange,
	ISubmarineSwapRecord,
	ISubmarineSwapRefundAttempt,
	ISwapChain,
	ISwapChainOutput,
	ISwapClientPolicy,
	ISwapCreateInvoiceParams,
	ISwapCreatedInvoice,
	ISwapFunder,
	ISwapFundingCandidate,
	ISwapInvoiceStatus,
	ISwapLightningPayer,
	ISwapPaymentStatus,
	ReverseSwapState,
	SubmarineSwapState,
	SwapErrorCode
} from './swaps/types';
export {
	REVERSE_SWAP_STORAGE_KEY,
	ReverseSwapStore,
	SUBMARINE_SWAP_STORAGE_KEY,
	SubmarineSwapStore,
	SwapStore
} from './swaps/store';
export {
	assertNativeSegwit,
	decodeSuppliedInvoice,
	isClaimWitness,
	isRefundWitness,
	submarineCltvProblem,
	toOutputScript,
	verifyFundingOutput,
	verifyReverseAck,
	verifySubmarineAck
} from './swaps/verify';
export type {
	FundingVerdict,
	IVerifiedReverseTerms,
	IVerifiedSubmarineTerms
} from './swaps/verify';
export {
	bumpedFeeRate,
	claimFeeForRate,
	feeForRate,
	replacementFloor
} from './swaps/fees';
export { LndPayer } from './swaps/lnd-payer';
export type { ILndPayerOptions } from './swaps/lnd-payer';
export { ClnPayer } from './swaps/cln-payer';
export type { IClnPayerOptions } from './swaps/cln-payer';
export {
	BitcoinCoreChain,
	BitcoinCoreRpcError
} from './swaps/bitcoin-core-chain';
export type { IBitcoinCoreChainOptions } from './swaps/bitcoin-core-chain';
export { ElectrumChain } from './swaps/electrum-chain';

export { LND_WALLET_LEASE_ID, LndWallet } from './direct-funding/lnd-wallet';
export type { ILndWalletOptions } from './direct-funding/lnd-wallet';
export { ClnWallet } from './direct-funding/cln-wallet';
export type { IClnWalletOptions } from './direct-funding/cln-wallet';
