/**
 * Who may call roux-boltzd, the way boltzd decides it, so boltzcli and any
 * gRPC client built for boltzd authenticate unchanged.
 *
 * boltzcli reads `<datadir>/macaroons/admin.macaroon` and sends its bytes
 * hex-encoded in the `macaroon` metadata header (or a password in
 * `authorization`), and uses TLS only when `<datadir>/tls.cert` exists.
 * boltzd verifies a macaroon against a root key in its SQLite database,
 * which roux does not read; it compares the presented bytes with the
 * admin and readonly macaroon files instead. Those files are bearer
 * credentials either way. A tenant macaroon baked by boltzd matches
 * neither and is refused.
 *
 * Missing macaroon files are minted: well-formed v2 macaroons (boltz's
 * location, a random identifier, an HMAC signature under a random root
 * key the process forgets), so tools that parse a macaroon still can. A
 * missing TLS pair is not generated: on a loopback address the daemon
 * serves plaintext, as boltzcli expects when there is no tls.cert.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as grpc from '@grpc/grpc-js';

/** boltzd's read-only methods; everything else needs the admin macaroon. */
export const READ_METHODS = new Set([
	'GetInfo',
	'GetServiceInfo',
	'GetPairInfo',
	'GetPairs',
	'GetSwapQuote',
	'ListSwaps',
	'GetStats',
	'GetSwapInfo',
	'GetSwapInfoStream',
	'GetWalletSendFee',
	'WalletReceive',
	'GetWallets',
	'ListWalletTransactions',
	'GetWallet',
	'VerifyWalletPassword',
	'ListTenants',
	'GetTenant',
	'GetSwapMnemonic'
]);

export interface IRpcAuthOptions {
	/** `[RPC] noMacaroons`: anyone who reaches the port is admin. */
	noMacaroons?: boolean;
	/** `[RPC] password`: takes precedence over macaroons, as in boltzd. */
	password?: string;
	adminMacaroonPath: string;
	readonlyMacaroonPath: string;
}

export type Permission = 'admin' | 'read';

export class RpcAuth {
	private admin: Buffer | null = null;
	private readonly: Buffer | null = null;

	constructor(private readonly options: IRpcAuthOptions) {}

	/** Load the macaroon files, minting any that are missing. */
	init(): { minted: string[] } {
		const minted: string[] = [];
		if (this.options.password || this.options.noMacaroons) return { minted };
		this.admin = loadOrMint(this.options.adminMacaroonPath, minted);
		this.readonly = loadOrMint(this.options.readonlyMacaroonPath, minted);
		return { minted };
	}

	/** The permission a call carries, or null when it carries none. */
	permission(metadata: grpc.Metadata): Permission | null {
		if (this.options.password) {
			const given = single(metadata, 'authorization');
			return given !== null &&
				timingSafeEqualStrings(given, this.options.password)
				? 'admin'
				: null;
		}
		if (this.options.noMacaroons) return 'admin';
		const hex = single(metadata, 'macaroon');
		if (hex === null || !/^([0-9a-fA-F]{2})+$/.test(hex)) return null;
		const presented = Buffer.from(hex, 'hex');
		if (this.admin && timingSafeEqualBuffers(presented, this.admin))
			return 'admin';
		if (this.readonly && timingSafeEqualBuffers(presented, this.readonly))
			return 'read';
		return null;
	}

	/** null when allowed; otherwise the status to fail the call with. */
	check(
		method: string,
		metadata: grpc.Metadata
	): { code: grpc.status; details: string } | null {
		const permission = this.permission(metadata);
		if (permission === null) {
			return {
				code: grpc.status.UNAUTHENTICATED,
				details: this.options.password
					? 'invalid password'
					: 'invalid or missing macaroon'
			};
		}
		if (permission === 'read' && !READ_METHODS.has(method)) {
			return {
				code: grpc.status.PERMISSION_DENIED,
				details: `${method} needs the admin macaroon`
			};
		}
		return null;
	}
}

function single(metadata: grpc.Metadata, key: string): string | null {
	const values = metadata.get(key);
	if (values.length !== 1) return null;
	const value = values[0];
	return typeof value === 'string' ? value : value.toString('utf8');
}

function timingSafeEqualBuffers(a: Buffer, b: Buffer): boolean {
	// Compare digests so neither the length nor the content leaks by timing.
	const da = crypto.createHash('sha256').update(a).digest();
	const db = crypto.createHash('sha256').update(b).digest();
	return crypto.timingSafeEqual(da, db);
}

function timingSafeEqualStrings(a: string, b: string): boolean {
	return timingSafeEqualBuffers(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function loadOrMint(file: string, minted: string[]): Buffer {
	try {
		return fs.readFileSync(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
	const macaroon = mintMacaroon();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, macaroon, { mode: 0o600 });
	minted.push(file);
	return macaroon;
}

// ─────────────── macaroon v2 binary format ───────────────

function varint(n: number): Buffer {
	const out: number[] = [];
	while (n >= 0x80) {
		out.push((n & 0x7f) | 0x80);
		n = Math.floor(n / 128);
	}
	out.push(n);
	return Buffer.from(out);
}

function field(type: number, data: Buffer): Buffer {
	return Buffer.concat([varint(type), varint(data.length), data]);
}

const EOS = Buffer.from([0]);

function hmac(key: Buffer, data: Buffer): Buffer {
	return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * A caveat-free v2 macaroon: version 2, location, identifier, end of the
 * header, end of the (empty) caveat list, signature. The signature follows
 * libmacaroons (HMAC of the identifier under a key derived from the root),
 * though only the bytes are ever compared.
 */
export function mintMacaroon(location = 'boltz'): Buffer {
	const rootKey = crypto.randomBytes(32);
	const id = Buffer.concat([
		Buffer.from('roux-boltzd:'),
		crypto.randomBytes(24)
	]);
	const derived = hmac(Buffer.from('macaroons-key-generator'), rootKey);
	const signature = hmac(derived, id);
	return Buffer.concat([
		Buffer.from([2]),
		field(1, Buffer.from(location)),
		field(2, id),
		EOS,
		EOS,
		field(6, signature)
	]);
}

// ─────────────── transport ───────────────

export interface ITlsOptions {
	certPath: string;
	keyPath: string;
	/** `[RPC] noTls`. */
	noTls?: boolean;
	host: string;
}

export function isLoopback(host: string): boolean {
	return (
		host === 'localhost' ||
		host === '::1' ||
		host === '[::1]' ||
		/^127\.\d+\.\d+\.\d+$/.test(host)
	);
}

/**
 * TLS from boltzd's pair when both files exist; plaintext when told to,
 * or on a loopback address with no pair (a warning says so). A
 * non-loopback address with no pair is refused rather than exposed.
 */
export function serverCredentials(opts: ITlsOptions): {
	credentials: grpc.ServerCredentials;
	tls: boolean;
	warning?: string;
} {
	if (opts.noTls) {
		return { credentials: grpc.ServerCredentials.createInsecure(), tls: false };
	}
	const haveCert = fs.existsSync(opts.certPath);
	const haveKey = fs.existsSync(opts.keyPath);
	if (haveCert && haveKey) {
		const cert = fs.readFileSync(opts.certPath);
		const warning = certificateWarning(cert, opts.certPath);
		return {
			credentials: grpc.ServerCredentials.createSsl(null, [
				{ cert_chain: cert, private_key: fs.readFileSync(opts.keyPath) }
			]),
			tls: true,
			warning
		};
	}
	if (haveCert !== haveKey) {
		throw new Error(
			`found only one of ${opts.certPath} and ${opts.keyPath}; provide both (tlsCert, tlsKey) or set noTls`
		);
	}
	if (!isLoopback(opts.host)) {
		throw new Error(
			`no TLS certificate at ${opts.certPath}: roux-boltzd does not generate one, and will not serve ${opts.host} in plaintext. Provide tlsCert and tlsKey, or set noTls`
		);
	}
	return {
		credentials: grpc.ServerCredentials.createInsecure(),
		tls: false,
		warning: `no TLS certificate at ${opts.certPath}: serving plaintext on ${opts.host} (boltzcli connects without TLS when that file is absent)`
	};
}

function certificateWarning(cert: Buffer, file: string): string | undefined {
	try {
		const x509 = new crypto.X509Certificate(cert);
		if (Date.parse(x509.validTo) < Date.now()) {
			return `TLS certificate ${file} expired ${x509.validTo}; clients will refuse it`;
		}
	} catch {
		return `TLS certificate ${file} does not parse`;
	}
	return undefined;
}
