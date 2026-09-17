/**
 * `roux/lnd`: everything an LND integration needs, and one call that
 * wires it up. LND speaks over its REST API with a macaroon; the same
 * credentials serve the peer link (custom messages), the wallet (coins,
 * PSBT signing, message signing), the payer (invoices, payments,
 * addresses) and the funder (on-chain sends for submarine swaps).
 */

import { BeignetClient, IBeignetClientOptions } from './client';
import { LndPeerLink } from './link/lnd-link';
import { LndWallet } from './direct-funding/lnd-wallet';
import { LndPayer } from './swaps/lnd-payer';
import { LndFunder } from './swaps/lnd-funder';
import { IHttpEndpoint } from './link/http';
import { RouxLog, RouxNetwork } from './types';

export { LndPeerLink } from './link/lnd-link';
export type { ILndPeerLinkOptions } from './link/lnd-link';
export { LndWallet, LND_WALLET_LEASE_ID } from './direct-funding/lnd-wallet';
export type { ILndWalletOptions } from './direct-funding/lnd-wallet';
export { LndPayer } from './swaps/lnd-payer';
export type { ILndPayerOptions } from './swaps/lnd-payer';
export { LndFunder } from './swaps/lnd-funder';
export type { ILndFunderOptions } from './swaps/lnd-funder';

export interface ILndClientOptions
	extends Pick<
		IBeignetClientOptions,
		'storage' | 'allowEphemeralStorage' | 'jit' | 'sender' | 'log'
	> {
	host: string;
	/** REST port (default 8080). */
	port?: number;
	/** Hex macaroon; see LndWallet for the permissions the wallet needs. */
	macaroonHex: string;
	network: RouxNetwork;
	https?: boolean;
	ca?: IHttpEndpoint['ca'];
	rejectUnauthorized?: boolean;
	/** Confirmations a coin needs before it is offered (default 1). */
	minConfs?: number;
	/** Chain access for swaps (BitcoinCoreChain, ElectrumChain); omit for quotes only. */
	chain?: NonNullable<IBeignetClientOptions['swaps']>['chain'];
	/** Keeps the swap keys and preimages out of the records (FileSecretProvider). */
	secrets?: NonNullable<IBeignetClientOptions['swaps']>['secrets'];
	policy?: NonNullable<IBeignetClientOptions['swaps']>['policy'];
	destination?: NonNullable<IBeignetClientOptions['swaps']>['destination'];
}

/**
 * A BeignetClient whose link, wallet and Lightning payer are all this LND.
 * Nothing is contacted until `connect()`.
 */
export function createLndClient(options: ILndClientOptions): BeignetClient {
	const log: RouxLog | undefined = options.log;
	const rest = {
		host: options.host,
		port: options.port,
		macaroonHex: options.macaroonHex,
		https: options.https,
		ca: options.ca,
		rejectUnauthorized: options.rejectUnauthorized,
		log
	};
	return new BeignetClient({
		network: options.network,
		link: new LndPeerLink(rest),
		wallet: new LndWallet({
			...rest,
			network: options.network,
			minConfs: options.minConfs
		}),
		storage: options.storage,
		allowEphemeralStorage: options.allowEphemeralStorage,
		jit: options.jit,
		sender: options.sender,
		swaps: {
			payer: new LndPayer({ ...rest, network: options.network }),
			funder: new LndFunder({ ...rest, network: options.network }),
			chain: options.chain,
			secrets: options.secrets,
			policy: options.policy,
			destination: options.destination
		},
		log
	});
}
