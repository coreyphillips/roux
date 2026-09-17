/**
 * The front door: one object, one beignet node URI, the liquidity protocols
 * a beignet node serves its peers (JIT, direct funding, swaps in both
 * directions).
 */

import type { directFunding } from 'beignet/lightning';
import { RouxLog, RouxNetwork, noopLog } from './types';
import { IPeerLink } from './link/types';
import { INodeUri, parseNodeUri } from './uri';
import { IJitClientOptions, JitClient } from './jit/client';
import { DirectFundingClient } from './direct-funding/client';
import {
	IWalletDataStorage,
	MemoryStorage,
	isEphemeralStorage
} from './storage';
import { webSocketSocketFactory, NoisePeerLink } from './link/noise-link';
import { ISwapClientOptions, SwapClient } from './swaps/client';

export interface IBeignetClientOptions {
	link: IPeerLink;
	network: RouxNetwork;
	/** Coins to pay direct-funding requests with. Omit for JIT only. */
	wallet?: directFunding.IDfSenderWallet;
	/**
	 * Durable home for direct-funding payment records and swap records (a
	 * swap record holds its claim or refund key, and for reverse swaps the
	 * preimage: treat the storage as a wallet file). Omitted, records live in this process only and every
	 * operation that moves funds refuses to start, unless
	 * `allowEphemeralStorage` says that is intended.
	 */
	storage?: IWalletDataStorage;
	/** Let fund-moving operations run on defaulted, in-process storage. */
	allowEphemeralStorage?: boolean;
	jit?: Pick<IJitClientOptions, 'maxFlatFeeSat' | 'maxFeePpm'>;
	sender?: directFunding.IDfSenderConfig;
	/**
	 * Swaps in both directions: a node that pays and mints invoices, a chain
	 * source, and for submarine swaps a funder that sends the coins (omit it
	 * to fund by hand). Omit all for quotes only.
	 */
	swaps?: Pick<
		ISwapClientOptions,
		'payer' | 'funder' | 'chain' | 'policy' | 'destination'
	>;
	log?: RouxLog;
}

export class BeignetClient {
	/** JIT inbound liquidity from a beignet LSP. */
	readonly jit: JitClient;
	private df: DirectFundingClient | null = null;
	private swapClient: SwapClient | null = null;
	private readonly log: RouxLog;
	private readonly storage: IWalletDataStorage;
	private readonly refuseEphemeralStorage: boolean;

	constructor(private readonly options: IBeignetClientOptions) {
		this.log = options.log ?? noopLog;
		this.storage = options.storage ?? new MemoryStorage();
		// Storage the caller chose is theirs to judge, MemoryStorage included;
		// storage nobody chose must not silently hold a claim key.
		this.refuseEphemeralStorage =
			!options.storage &&
			isEphemeralStorage(this.storage) &&
			!options.allowEphemeralStorage;
		this.jit = new JitClient({
			link: options.link,
			...options.jit,
			log: this.log
		});
	}

	/** Third-party direct funding of a beignet wallet's channel. Needs `wallet`. */
	get directFunding(): DirectFundingClient {
		if (!this.df) {
			if (!this.options.wallet) {
				throw new Error(
					'BeignetClient needs a `wallet` to pay direct-funding requests ' +
						'(KeyedUtxoWallet, or any IDfSenderWallet)'
				);
			}
			this.df = new DirectFundingClient({
				link: this.options.link,
				network: this.options.network,
				wallet: this.options.wallet,
				storage: this.storage,
				refuseEphemeralStorage: this.refuseEphemeralStorage,
				sender: this.options.sender,
				log: this.log
			});
		}
		return this.df;
	}

	/** Swaps against a beignet provider. Quotes need only the link. */
	get swaps(): SwapClient {
		if (!this.swapClient) {
			this.swapClient = new SwapClient({
				link: this.options.link,
				network: this.options.network,
				storage: this.storage,
				refuseEphemeralStorage: this.refuseEphemeralStorage,
				...this.options.swaps,
				log: this.log
			});
		}
		return this.swapClient;
	}

	get link(): IPeerLink {
		return this.options.link;
	}

	/** Bring the link up (a no-op for the standalone Noise link). */
	async open(): Promise<void> {
		await this.options.link.open?.();
	}

	/** Our identity as the beignet node sees it. */
	nodeIdHex(): string {
		return this.options.link.nodeIdHex();
	}

	/**
	 * Connect to a beignet node by URI (`pubkey@host:port`, or `pubkey@ws://...`
	 * for the standalone link). Returns the parsed address; the pubkey is
	 * what the JIT and direct-funding calls take.
	 */
	async connect(uri: string): Promise<INodeUri> {
		await this.open();
		const parsed = parseNodeUri(uri);
		const link = this.options.link;
		if (parsed.webSocketUrl && link instanceof NoisePeerLink) {
			await link.connectPeer(
				parsed.pubkeyHex,
				parsed.host,
				parsed.port,
				webSocketSocketFactory(parsed.webSocketUrl)
			);
		} else {
			await link.connectPeer(parsed.pubkeyHex, parsed.host, parsed.port);
		}
		this.log('connected', {
			pubkey: parsed.pubkeyHex,
			host: parsed.host,
			port: parsed.port
		});
		return parsed;
	}

	isConnected(pubkeyHex: string): boolean {
		return this.options.link.isPeerConnected(pubkeyHex);
	}

	/**
	 * Shut down in order: park every live swap (their passes in flight
	 * finish writing first), stop the direct-funding engine, close the
	 * link. Nothing is cancelled: a payment already handed to the node, a
	 * witness already released, a claim already broadcast all continue in
	 * the node and on the chain, and `resume()` after a restart picks the
	 * records up from where they stopped. Resolves once all of that is done.
	 */
	async close(): Promise<void> {
		await this.swapClient?.stop();
		this.df?.stop();
		await this.options.link.close();
	}
}
