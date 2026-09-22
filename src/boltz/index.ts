/**
 * `roux/boltz`: boltz-client's gRPC API (boltzrpc) served by roux against a
 * beignet provider. `roux-boltzd` is the daemon; the pieces are here for a
 * host that wires its own client, chain or transport.
 */

export {
	startBoltzDaemon,
	buildDaemonClient,
	lndMacaroonHex,
	packageVersion
} from './daemon';
export type { IBoltzDaemon, IBoltzDaemonOptions } from './daemon';
export {
	BOLTZ_DAEMON_USAGE,
	expandHome,
	loadBoltzDaemonConfig,
	parseFlags
} from './config';
export type { IBoltzDaemonConfig } from './config';
export {
	BoltzService,
	RpcError,
	UNIMPLEMENTED_RPCS,
	bip21,
	toRpcError
} from './service';
export type { IBoltzServiceOptions, ICallContext } from './service';
export { boltzServiceImplementation, startBoltzServer } from './server';
export type { IBoltzServer, IBoltzServerOptions } from './server';
export {
	READ_METHODS,
	RpcAuth,
	isLoopback,
	mintMacaroon,
	serverCredentials
} from './auth';
export type { IRpcAuthOptions, ITlsOptions, Permission } from './auth';
export {
	BOLTZRPC_LOADER_OPTIONS,
	BOLTZRPC_PROTO_PATH,
	BOLTZRPC_PROTO_VERSION,
	boltzClient,
	boltzServiceDefinition
} from './proto';
export { reverseOnchainFor, submarineOnchainFor } from './amounts';
export type { FeeQuote } from './amounts';
export {
	BTC_PAIR,
	reverseState,
	submarineState,
	toAnySwapInfo,
	toPairInfo,
	toReverseSwapInfo,
	toSwapInfo
} from './mapping';
export type * from './rpc-types';
