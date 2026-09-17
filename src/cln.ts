/**
 * `roux/cln`: everything a Core Lightning integration needs, and one
 * call that wires it up. CLN speaks over clnrest with a rune; the same
 * credentials serve the peer link (custom messages and the Socket.IO
 * notification stream), the wallet (coins, reservations, signpsbt), the
 * payer (pay, listpays, newaddr, invoice, listinvoices) and the funder
 * (withdraw, for submarine swaps).
 */

import { BeignetClient, IBeignetClientOptions } from './client';
import { ClnPeerLink } from './link/cln-link';
import { ClnWallet } from './direct-funding/cln-wallet';
import { ClnPayer } from './swaps/cln-payer';
import { ClnFunder } from './swaps/cln-funder';
import { IHttpEndpoint } from './link/http';
import { RouxLog, RouxNetwork } from './types';

export { ClnPeerLink } from './link/cln-link';
export type {
	ClnNotificationSource,
	IClnPeerLinkOptions
} from './link/cln-link';
export { clnSocketIoNotifications } from './link/cln-socketio';
export type { IClnSocketIoOptions } from './link/cln-socketio';
export { ClnWallet } from './direct-funding/cln-wallet';
export type { IClnWalletOptions } from './direct-funding/cln-wallet';
export { ClnPayer } from './swaps/cln-payer';
export type { IClnPayerOptions } from './swaps/cln-payer';
export { ClnFunder } from './swaps/cln-funder';
export type { IClnFunderOptions } from './swaps/cln-funder';

export interface IClnClientOptions
	extends Pick<
		IBeignetClientOptions,
		'storage' | 'allowEphemeralStorage' | 'jit' | 'sender' | 'log'
	> {
	host: string;
	/** clnrest port (default 3010). */
	port?: number;
	/** A rune permitting getinfo, listpeers, connect, sendcustommsg, listfunds, listtransactions, newaddr, reserveinputs, unreserveinputs, signpsbt, pay, listpays, and for submarine swaps invoice, listinvoices, listpeerchannels, withdraw. */
	rune: string;
	network: RouxNetwork;
	https?: boolean;
	ca?: IHttpEndpoint['ca'];
	rejectUnauthorized?: boolean;
	/** Raw transaction lookup for the funding's foreign inputs (see ClnWallet). */
	getTransaction?: (txidHex: string) => Promise<Buffer>;
	reserveBlocks?: number;
	/** Chain access for swaps (BitcoinCoreChain, ElectrumChain); omit for quotes only. */
	chain?: NonNullable<IBeignetClientOptions['swaps']>['chain'];
	policy?: NonNullable<IBeignetClientOptions['swaps']>['policy'];
	destination?: NonNullable<IBeignetClientOptions['swaps']>['destination'];
}

/**
 * A BeignetClient whose link, wallet and Lightning payer are all this CLN.
 * Nothing is contacted until `connect()`.
 */
export function createClnClient(options: IClnClientOptions): BeignetClient {
	const log: RouxLog | undefined = options.log;
	const rest = {
		host: options.host,
		port: options.port,
		rune: options.rune,
		https: options.https,
		ca: options.ca,
		rejectUnauthorized: options.rejectUnauthorized,
		log
	};
	return new BeignetClient({
		network: options.network,
		link: new ClnPeerLink(rest),
		wallet: new ClnWallet({
			...rest,
			network: options.network,
			getTransaction: options.getTransaction,
			reserveBlocks: options.reserveBlocks
		}),
		storage: options.storage,
		allowEphemeralStorage: options.allowEphemeralStorage,
		jit: options.jit,
		sender: options.sender,
		swaps: {
			payer: new ClnPayer({ ...rest, network: options.network }),
			funder: new ClnFunder({ ...rest, network: options.network }),
			chain: options.chain,
			policy: options.policy,
			destination: options.destination
		},
		log
	});
}
