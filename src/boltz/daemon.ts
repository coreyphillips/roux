/**
 * roux-boltzd put together: the node client (LND or CLN) with Bitcoin
 * Core as the chain and a file as the swap store, every unresolved swap
 * resumed, then the gRPC server.
 *
 * The provider connection is kept up in the background and retried before
 * any call that needs it. Swaps already running do not wait for it: a
 * refund or a claim needs only the node and the chain.
 */

import fs from 'fs';
import path from 'path';
import { BeignetClient } from '../client';
import { createClnClient } from '../cln';
import { createLndClient } from '../lnd';
import { FileStorage } from '../storage';
import { RouxLog, noopLog } from '../types';
import { parseNodeUri } from '../uri';
import { BitcoinCoreChain } from '../swaps/bitcoin-core-chain';
import { ISwapChain } from '../swaps/types';
import { IBoltzDaemonConfig } from './config';
import { RpcAuth, isLoopback, serverCredentials } from './auth';
import { BoltzService } from './service';
import { startBoltzServer } from './server';

const RECONNECT_MS = 60_000;

export interface IBoltzDaemonOptions {
	log?: RouxLog;
	version?: string;
	/** Replace the node client (tests); built from the config otherwise. */
	client?: BeignetClient;
	/** Replace the chain source (tests); Bitcoin Core from the config otherwise. */
	chain?: ISwapChain;
}

export interface IBoltzDaemon {
	service: BoltzService;
	client: BeignetClient;
	/** The gRPC port bound. */
	port: number;
	tls: boolean;
	/** Resolves when a caller asked the daemon to stop (the Stop RPC). */
	stopRequested: Promise<void>;
	/** Stop serving, then park every swap and close the node link. */
	close(): Promise<void>;
}

/** roux's own version, for GetInfo. */
export function packageVersion(): string {
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
		) as { version?: string };
		return `roux-boltzd ${pkg.version ?? ''}`.trim();
	} catch {
		return 'roux-boltzd';
	}
}

function readIfExists(file: string | undefined): Buffer | undefined {
	return file && fs.existsSync(file) ? fs.readFileSync(file) : undefined;
}

/** A self-signed node certificate on loopback is trusted without a pin. */
function trust(
	host: string,
	ca: Buffer | undefined
): { ca?: Buffer; rejectUnauthorized?: boolean } {
	if (ca) return { ca };
	return isLoopback(host) ? { rejectUnauthorized: false } : {};
}

export function buildDaemonClient(
	config: IBoltzDaemonConfig,
	chain: ISwapChain,
	log: RouxLog
): BeignetClient {
	const storage = new FileStorage(config.storePath);
	if (config.node === 'lnd') {
		const lnd = config.lnd!;
		if (!fs.existsSync(lnd.macaroonPath)) {
			throw new Error(
				`no LND macaroon at ${lnd.macaroonPath}: set [LND] macaroon, or [LND] datadir and network`
			);
		}
		return createLndClient({
			host: lnd.host,
			port: lnd.restPort,
			macaroonHex: fs.readFileSync(lnd.macaroonPath).toString('hex'),
			network: config.network,
			...trust(lnd.host, readIfExists(lnd.certificatePath)),
			storage,
			chain,
			policy: config.policy,
			log
		});
	}
	const cln = config.cln!;
	return createClnClient({
		host: cln.host,
		port: cln.port,
		rune: cln.rune,
		network: config.network,
		...trust(cln.host, readIfExists(cln.caPath)),
		storage,
		chain,
		policy: config.policy,
		log
	});
}

export async function startBoltzDaemon(
	config: IBoltzDaemonConfig,
	options: IBoltzDaemonOptions = {}
): Promise<IBoltzDaemon> {
	const log = options.log ?? noopLog;
	const chain =
		options.chain ?? new BitcoinCoreChain({ ...config.bitcoind, log });
	const client = options.client ?? buildDaemonClient(config, chain, log);
	const provider = parseNodeUri(config.provider).pubkeyHex;

	try {
		await client.open();
	} catch (err) {
		throw new Error(
			`could not reach the ${config.node.toUpperCase()} node: ${
				err instanceof Error ? err.message : String(err)
			}`
		);
	}

	let connecting: Promise<void> | null = null;
	const ensureProvider = async (): Promise<void> => {
		if (client.isConnected(provider)) return;
		if (!connecting) {
			connecting = client
				.connect(config.provider)
				.then(() => undefined)
				.finally(() => {
					connecting = null;
				});
		}
		await connecting;
	};
	const reconnect = (): void => {
		ensureProvider().catch((err) =>
			log('boltz_provider_unreachable', {
				provider: config.provider,
				error: err instanceof Error ? err.message : String(err)
			})
		);
	};
	reconnect();
	const timer = setInterval(reconnect, RECONNECT_MS);
	timer.unref?.();

	// Every unresolved swap continues from its record, provider or not.
	const [reverse, submarine] = await Promise.all([
		client.swaps.reverse.resume({ run: true }),
		client.swaps.submarine.resume({ run: true })
	]);
	log('boltz_swaps_resumed', {
		reverse: reverse.resumed.length,
		submarine: submarine.resumed.length,
		reverseNeedsPayment: reverse.needsPayment.map((s) => s.swapIdHex),
		submarineNeedsFunding: submarine.needsFunding.map((s) => s.swapIdHex),
		submarineFundingUnknown: submarine.fundingUnknown.map((s) => s.swapIdHex),
		errors: [...reverse.errors, ...submarine.errors]
	});

	const auth = new RpcAuth({
		noMacaroons: config.rpc.noMacaroons,
		password: config.rpc.password,
		adminMacaroonPath: config.rpc.adminMacaroonPath,
		readonlyMacaroonPath: config.rpc.readonlyMacaroonPath
	});
	const { minted } = auth.init();
	if (minted.length > 0) log('boltz_macaroons_minted', { files: minted });
	const transport = serverCredentials({
		certPath: config.rpc.tlsCertPath,
		keyPath: config.rpc.tlsKeyPath,
		noTls: config.rpc.noTls,
		host: config.rpc.host
	});
	if (transport.warning) log('boltz_tls', { warning: transport.warning });

	let requestStop: () => void = () => undefined;
	const stopRequested = new Promise<void>((resolve) => {
		requestStop = resolve;
	});
	const service = new BoltzService({
		client,
		chain,
		provider,
		network: config.network,
		node: config.node,
		version: options.version ?? packageVersion(),
		routingFeeLimitPpm: config.routingFeeLimitPpm,
		ensureProvider,
		onStop: () => requestStop(),
		log
	});
	let server;
	try {
		server = await startBoltzServer({
			service,
			auth,
			host: config.rpc.host,
			port: config.rpc.port,
			credentials: transport.credentials,
			log
		});
	} catch (err) {
		clearInterval(timer);
		await client.close();
		throw err;
	}

	let closing: Promise<void> | null = null;
	return {
		service,
		client,
		port: server.port,
		tls: transport.tls,
		stopRequested,
		close: (): Promise<void> => {
			if (!closing) {
				closing = (async (): Promise<void> => {
					clearInterval(timer);
					await server.close();
					await client.close();
				})();
			}
			return closing;
		}
	};
}
