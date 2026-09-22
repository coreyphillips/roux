/**
 * roux-boltzd's configuration: boltzd's own `boltz.toml` in boltzd's data
 * directory, so an operator switching over keeps the file, the port, the
 * TLS pair and the macaroons, plus a `[Roux]` section for what boltzd
 * never needed. Keys match case-insensitively, as boltzd's TOML decoder
 * matches them; CLI flags use boltzd's names and win over the file.
 *
 * From boltzd's file: `network`, `node`, `[RPC]` (host, port, tlsCert,
 * tlsKey, noTls, noMacaroons, adminMacaroonPath, readOnlyMacaroonPath,
 * password), `[LND]` (host, datadir, macaroon, certificate) and
 * `[LIGHTNING] routingFeeLimitPpm`. boltzd talks to LND over gRPC and to
 * CLN over gRPC with client certificates; roux uses LND's REST port with
 * the same macaroon and certificate, and CLN's clnrest with a rune:
 *
 *   [Roux]
 *   provider = "02abc...@provider.example:9735"  # the beignet provider
 *   store = "~/.boltz/roux-swaps.json"            # default: in the datadir
 *
 *   [Roux.LND]          # only what differs from [LND]
 *   restPort = 8080
 *
 *   [Roux.CLN]
 *   host = "127.0.0.1"
 *   port = 3010
 *   rune = "..."        # or runeFile = "~/.lightning/roux.rune"
 *
 *   [Roux.Bitcoind]     # chain source for claims and refunds
 *   host = "127.0.0.1"
 *   port = 8332
 *   cookie = "~/.bitcoin/.cookie"   # or user / pass
 *
 *   [Roux.Policy]       # SWAP_DEFAULT_POLICY overrides (numbers)
 *   minFundingConfirmations = 2
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { RouxNetwork } from '../types';
import { ISwapClientPolicy, SWAP_DEFAULT_POLICY } from '../swaps/types';

// smol-toml's type declarations are ESM-only; its CommonJS build is what
// require() loads here.
const { parse: parseToml } = require('smol-toml') as {
	parse(toml: string): Record<string, unknown>;
};

export interface IBoltzDaemonConfig {
	dataDir: string;
	configFile: string;
	network: RouxNetwork;
	node: 'lnd' | 'cln';
	rpc: {
		host: string;
		port: number;
		tlsCertPath: string;
		tlsKeyPath: string;
		noTls: boolean;
		noMacaroons: boolean;
		adminMacaroonPath: string;
		readonlyMacaroonPath: string;
		password?: string;
	};
	lnd?: {
		host: string;
		restPort: number;
		macaroonPath: string;
		certificatePath?: string;
	};
	cln?: {
		host: string;
		port: number;
		rune: string;
		caPath?: string;
	};
	bitcoind: {
		host: string;
		port: number;
		user: string;
		pass: string;
		wallet?: string;
	};
	/** `pubkey@host:port` of the beignet provider. */
	provider: string;
	storePath: string;
	routingFeeLimitPpm?: number;
	policy: Partial<ISwapClientPolicy>;
}

export const BOLTZ_DAEMON_USAGE = `roux-boltzd: boltz-client's gRPC API, served by roux against a beignet provider

Usage: roux-boltzd [options]

  -d, --datadir <dir>          boltzd's data directory (default ~/.boltz)
  -c, --configfile <file>      config file (default <datadir>/boltz.toml)
      --network <name>         mainnet, testnet, signet or regtest
      --node <lnd|cln>         which node the swaps use
      --rpc.host <host>        gRPC host (default 127.0.0.1)
  -p, --rpc.port <port>        gRPC port (default 9002)
      --rpc.tlscert <file>     TLS certificate (default <datadir>/tls.cert)
      --rpc.tlskey <file>      TLS key (default <datadir>/tls.key)
      --rpc.no-tls             serve plaintext
      --rpc.no-macaroons       no authentication
      --rpc.password <pw>      password authentication instead of macaroons
      --roux.provider <uri>    beignet provider, pubkey@host:port
      --roux.store <file>      swap store (default <datadir>/roux-swaps.json)
  -h, --help                   this text
  -v, --version                print the version
`;

type Table = Record<string, unknown>;

/** Lower-case every key, recursively, for boltzd's case-insensitive match. */
function lowerKeys(value: unknown): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
	const out: Table = {};
	for (const [k, v] of Object.entries(value as Table))
		out[k.toLowerCase()] = lowerKeys(v);
	return out;
}

function table(parent: Table, ...keys: string[]): Table {
	let current: unknown = parent;
	for (const key of keys) {
		current = (current as Table | undefined)?.[key.toLowerCase()];
	}
	return current && typeof current === 'object' ? (current as Table) : {};
}

function str(t: Table, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const v = t[key.toLowerCase()];
		if (typeof v === 'string' && v !== '') return v;
	}
	return undefined;
}

function num(t: Table, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const v = t[key.toLowerCase()];
		if (typeof v === 'number') return v;
		if (typeof v === 'bigint') return Number(v);
		if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
	}
	return undefined;
}

function bool(t: Table, key: string): boolean | undefined {
	const v = t[key.toLowerCase()];
	return typeof v === 'boolean' ? v : undefined;
}

export function expandHome(p: string, home: string = os.homedir()): string {
	if (p === '~') return home;
	if (p.startsWith('~/')) return path.join(home, p.slice(2));
	return p;
}

/** Parse argv into boltzd-style flags: `--a.b value`, `--a.b=value`, `--flag`. */
export function parseFlags(argv: string[]): Record<string, string | true> {
	const aliases: Record<string, string> = {
		d: 'datadir',
		c: 'configfile',
		p: 'rpc.port',
		h: 'help',
		v: 'version'
	};
	const booleans = new Set([
		'rpc.no-tls',
		'rpc.no-macaroons',
		'help',
		'version'
	]);
	const flags: Record<string, string | true> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const match = /^--?([^=]+)(?:=(.*))?$/.exec(arg);
		if (!match) throw new Error(`unexpected argument: ${arg}`);
		const name = aliases[match[1]] ?? match[1].toLowerCase();
		if (match[2] !== undefined) flags[name] = match[2];
		else if (booleans.has(name)) flags[name] = true;
		else if (i + 1 < argv.length) flags[name] = argv[++i];
		else throw new Error(`--${name} needs a value`);
	}
	return flags;
}

/** [Roux.Policy] keys, matched case-insensitively to the policy's own names. */
const POLICY_KEYS = new Map(
	(Object.keys(SWAP_DEFAULT_POLICY) as Array<keyof ISwapClientPolicy>).map(
		(name) => [name.toLowerCase(), name]
	)
);

const NETWORKS: RouxNetwork[] = ['mainnet', 'testnet', 'signet', 'regtest'];

const BITCOIND_PORTS: Record<RouxNetwork, number> = {
	mainnet: 8332,
	testnet: 18332,
	signet: 38332,
	regtest: 18443
};

const BITCOIND_COOKIE_DIRS: Record<RouxNetwork, string> = {
	mainnet: '',
	testnet: 'testnet3',
	signet: 'signet',
	regtest: 'regtest'
};

function defaultDataDir(home: string): string {
	// boltzcli's rule: the legacy ~/.boltz-lnd when it exists, ~/.boltz otherwise.
	const legacy = path.join(home, '.boltz-lnd');
	return fs.existsSync(legacy) ? legacy : path.join(home, '.boltz');
}

/**
 * Resolve the daemon's configuration from argv and the TOML file. Paths are
 * resolved but not read, except the rune file and the bitcoind cookie,
 * which hold values rather than name files the daemon opens later.
 */
export function loadBoltzDaemonConfig(
	argv: string[],
	home: string = os.homedir()
): IBoltzDaemonConfig {
	const flags = parseFlags(argv);
	const flag = (name: string): string | undefined => {
		const v = flags[name];
		return typeof v === 'string' ? v : undefined;
	};
	const dataDir = expandHome(flag('datadir') ?? defaultDataDir(home), home);
	const configFile = expandHome(
		flag('configfile') ?? path.join(dataDir, 'boltz.toml'),
		home
	);
	let raw: Table = {};
	if (fs.existsSync(configFile)) {
		raw = lowerKeys(parseToml(fs.readFileSync(configFile, 'utf8'))) as Table;
	} else if (flag('configfile')) {
		throw new Error(`config file ${configFile} does not exist`);
	}
	const x = (p: string): string => expandHome(p, home);

	const networkName = (
		flag('network') ??
		str(raw, 'network') ??
		'mainnet'
	).toLowerCase();
	if (!NETWORKS.includes(networkName as RouxNetwork)) {
		throw new Error(`unknown network ${networkName}: ${NETWORKS.join(', ')}`);
	}
	const network = networkName as RouxNetwork;

	const rpcT = table(raw, 'rpc');
	const macaroonDir = path.join(dataDir, 'macaroons');
	const rpc: IBoltzDaemonConfig['rpc'] = {
		host: flag('rpc.host') ?? str(rpcT, 'host') ?? '127.0.0.1',
		port: Number(flag('rpc.port') ?? num(rpcT, 'port') ?? 9002),
		tlsCertPath: x(
			flag('rpc.tlscert') ??
				str(rpcT, 'tlsCert', 'tlsCertPath') ??
				path.join(dataDir, 'tls.cert')
		),
		tlsKeyPath: x(
			flag('rpc.tlskey') ??
				str(rpcT, 'tlsKey', 'tlsKeyPath') ??
				path.join(dataDir, 'tls.key')
		),
		noTls: flags['rpc.no-tls'] === true || bool(rpcT, 'noTls') === true,
		noMacaroons:
			flags['rpc.no-macaroons'] === true || bool(rpcT, 'noMacaroons') === true,
		adminMacaroonPath: x(
			str(rpcT, 'adminMacaroonPath') ?? path.join(macaroonDir, 'admin.macaroon')
		),
		readonlyMacaroonPath: x(
			str(rpcT, 'readOnlyMacaroonPath', 'readonlyMacaroonPath') ??
				path.join(macaroonDir, 'readonly.macaroon')
		),
		password: flag('rpc.password') ?? str(rpcT, 'password')
	};
	if (!Number.isInteger(rpc.port) || rpc.port < 0 || rpc.port > 65535) {
		throw new Error(`invalid rpc port ${rpc.port}`);
	}

	const roux = table(raw, 'roux');
	const provider = flag('roux.provider') ?? str(roux, 'provider');
	if (!provider) {
		throw new Error(
			'no beignet provider: set [Roux] provider = "pubkey@host:port" in boltz.toml or pass --roux.provider'
		);
	}

	const rouxCln = table(raw, 'roux', 'cln');
	const nodeName = (
		flag('node') ??
		str(raw, 'node') ??
		(str(rouxCln, 'rune', 'runeFile') ? 'cln' : 'lnd')
	).toLowerCase();
	if (nodeName !== 'lnd' && nodeName !== 'cln') {
		throw new Error(`node must be lnd or cln, not ${nodeName}`);
	}
	const node = nodeName as 'lnd' | 'cln';

	let lnd: IBoltzDaemonConfig['lnd'];
	let cln: IBoltzDaemonConfig['cln'];
	if (node === 'lnd') {
		const lndT = table(raw, 'lnd');
		const rouxLnd = table(raw, 'roux', 'lnd');
		const lndDir = x(str(lndT, 'datadir') ?? '~/.lnd');
		lnd = {
			host: str(rouxLnd, 'restHost') ?? str(lndT, 'host') ?? '127.0.0.1',
			restPort: num(rouxLnd, 'restPort') ?? 8080,
			macaroonPath: x(
				str(lndT, 'macaroon') ??
					path.join(
						lndDir,
						'data',
						'chain',
						'bitcoin',
						network,
						'admin.macaroon'
					)
			),
			certificatePath: x(
				str(lndT, 'certificate') ?? path.join(lndDir, 'tls.cert')
			)
		};
	} else {
		let rune = str(rouxCln, 'rune');
		const runeFile = str(rouxCln, 'runeFile');
		if (!rune && runeFile) rune = fs.readFileSync(x(runeFile), 'utf8').trim();
		if (!rune) {
			throw new Error('CLN needs [Roux.CLN] rune (or runeFile) for clnrest');
		}
		const ca = str(rouxCln, 'ca');
		cln = {
			host:
				str(rouxCln, 'host') ?? str(table(raw, 'cln'), 'host') ?? '127.0.0.1',
			port: num(rouxCln, 'port') ?? 3010,
			rune,
			caPath: ca ? x(ca) : undefined
		};
	}

	const btc = table(raw, 'roux', 'bitcoind');
	let user = str(btc, 'user');
	let pass = str(btc, 'pass', 'password');
	if (!user || !pass) {
		const cookie = x(
			str(btc, 'cookie') ??
				path.join(home, '.bitcoin', BITCOIND_COOKIE_DIRS[network], '.cookie')
		);
		try {
			const [u, ...rest] = fs.readFileSync(cookie, 'utf8').trim().split(':');
			user = u;
			pass = rest.join(':');
		} catch (err) {
			throw new Error(
				`no bitcoind credentials: set [Roux.Bitcoind] user and pass, or a readable cookie (${cookie}: ${
					(err as Error).message
				})`
			);
		}
	}
	const bitcoind: IBoltzDaemonConfig['bitcoind'] = {
		host: str(btc, 'host') ?? '127.0.0.1',
		port: num(btc, 'port') ?? BITCOIND_PORTS[network],
		user,
		pass,
		wallet: str(btc, 'wallet')
	};

	const policy: Partial<ISwapClientPolicy> = {};
	for (const [key, value] of Object.entries(table(raw, 'roux', 'policy'))) {
		const name = POLICY_KEYS.get(key);
		if (!name) throw new Error(`unknown [Roux.Policy] key ${key}`);
		const v = typeof value === 'bigint' ? Number(value) : value;
		if (typeof v !== 'number')
			throw new Error(`[Roux.Policy] ${key} must be a number`);
		(policy as Record<string, unknown>)[name] =
			typeof SWAP_DEFAULT_POLICY[name] === 'bigint' ? BigInt(v) : v;
	}

	return {
		dataDir,
		configFile,
		network,
		node,
		rpc,
		lnd,
		cln,
		bitcoind,
		provider,
		storePath: x(
			flag('roux.store') ??
				str(roux, 'store') ??
				path.join(dataDir, 'roux-swaps.json')
		),
		routingFeeLimitPpm: num(table(raw, 'lightning'), 'routingFeeLimitPpm'),
		policy
	};
}
