/**
 * roux-boltzd's configuration and authentication: boltzd's own boltz.toml
 * (keys in any case, both spellings of the TLS keys, the LND datadir
 * defaults) plus the [Roux] section, flags over the file, the bitcoind
 * cookie; macaroons compared byte for byte, the read-only one kept to read
 * methods, password auth, minting, and TLS refused off loopback.
 */

import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as grpc from '@grpc/grpc-js';
import {
	RpcAuth,
	lndMacaroonHex,
	loadBoltzDaemonConfig,
	mintMacaroon,
	serverCredentials
} from '../../src/boltz';

const PROVIDER = `02${'ab'.repeat(32)}@127.0.0.1:9735`;

function home(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'roux-boltzd-'));
}

function write(file: string, content: string | Buffer): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function metadata(pairs: Record<string, string>): grpc.Metadata {
	const md = new grpc.Metadata();
	for (const [k, v] of Object.entries(pairs)) md.set(k, v);
	return md;
}

describe('roux-boltzd config', function () {
	it("reads boltzd's boltz.toml, case-insensitively, with the [Roux] section", function () {
		const h = home();
		write(
			path.join(h, '.boltz', 'boltz.toml'),
			`
network = "regtest"
node = "LND"

[LIGHTNING]
routingFeeLimitPpm = 2500

[LND]
host = "10.0.0.5"
datadir = "~/.lnd"

[RPC]
host = "127.0.0.1"
port = 9102
tlsCert = "~/certs/boltz.cert"
noMacaroons = false

[Roux]
provider = "${PROVIDER}"

[Roux.LND]
restPort = 8081

[Roux.Bitcoind]
port = 18443
user = "rpc"
pass = "secret"

[Roux.Policy]
minFundingConfirmations = 2
maxClaimFeeSat = 5000
`
		);
		const c = loadBoltzDaemonConfig([], h);
		expect(c.dataDir).to.equal(path.join(h, '.boltz'));
		expect(c.network).to.equal('regtest');
		expect(c.node).to.equal('lnd');
		expect(c.rpc.port).to.equal(9102);
		expect(c.rpc.tlsCertPath).to.equal(path.join(h, 'certs', 'boltz.cert'));
		expect(c.rpc.tlsKeyPath).to.equal(path.join(h, '.boltz', 'tls.key'));
		expect(c.rpc.adminMacaroonPath).to.equal(
			path.join(h, '.boltz', 'macaroons', 'admin.macaroon')
		);
		expect(c.lnd).to.deep.equal({
			host: '10.0.0.5',
			restPort: 8081,
			macaroon: path.join(
				h,
				'.lnd',
				'data',
				'chain',
				'bitcoin',
				'regtest',
				'admin.macaroon'
			),
			certificatePath: path.join(h, '.lnd', 'tls.cert')
		});
		expect(c.bitcoind).to.include({ port: 18443, user: 'rpc', pass: 'secret' });
		expect(c.provider).to.equal(PROVIDER);
		expect(c.storePath).to.equal(path.join(h, '.boltz', 'roux-swaps.json'));
		expect(c.routingFeeLimitPpm).to.equal(2500);
		expect(c.policy).to.deep.equal({
			minFundingConfirmations: 2,
			maxClaimFeeSat: 5000n
		});
	});

	it('lets flags win, reads the bitcoind cookie, and configures CLN from a rune file', function () {
		const h = home();
		const dir = path.join(h, 'boltzdata');
		write(
			path.join(dir, 'boltz.toml'),
			`
network = "mainnet"
[rpc]
tlscertpath = "/x/cert"
[roux]
provider = "${PROVIDER}"
[roux.cln]
runeFile = "~/rune.txt"
port = 3011
`
		);
		write(path.join(h, 'rune.txt'), 'the-rune\n');
		write(path.join(h, '.bitcoin', 'signet', '.cookie'), '__cookie__:pa:ss');
		const c = loadBoltzDaemonConfig(
			[
				'-d',
				dir,
				'--network',
				'signet',
				'--rpc.port=9999',
				'--rpc.no-tls',
				'--roux.store',
				'~/elsewhere.json'
			],
			h
		);
		expect(c.network).to.equal('signet');
		expect(c.node).to.equal('cln');
		expect(c.cln).to.deep.equal({
			host: '127.0.0.1',
			port: 3011,
			rune: 'the-rune',
			caPath: undefined
		});
		expect(c.rpc.port).to.equal(9999);
		expect(c.rpc.noTls).to.equal(true);
		expect(c.rpc.tlsCertPath).to.equal('/x/cert');
		expect(c.bitcoind).to.include({
			port: 38332,
			user: '__cookie__',
			pass: 'pa:ss'
		});
		expect(c.storePath).to.equal(path.join(h, 'elsewhere.json'));
	});

	it('refuses a config with no provider, an unknown network or an unknown policy key', function () {
		const h = home();
		const file = path.join(h, '.boltz', 'boltz.toml');
		write(file, '[Roux.Bitcoind]\nuser = "u"\npass = "p"\n');
		expect(() => loadBoltzDaemonConfig([], h)).to.throw(/no beignet provider/);
		expect(() =>
			loadBoltzDaemonConfig(
				['--roux.provider', PROVIDER, '--network', 'liquid'],
				h
			)
		).to.throw(/unknown network/);
		write(
			file,
			`[Roux]\nprovider = "${PROVIDER}"\n[Roux.Bitcoind]\nuser = "u"\npass = "p"\n[Roux.Policy]\nnope = 1\n`
		);
		expect(() => loadBoltzDaemonConfig([], h)).to.throw(
			/unknown \[Roux.Policy\] key/
		);
	});
});

describe('roux-boltzd LND macaroon', function () {
	it('takes hex or a path, as boltzd does, and keeps the credential out of errors', function () {
		const h = home();
		const macaroon = mintMacaroon();
		const hex = macaroon.toString('hex');
		write(path.join(h, 'admin.macaroon'), macaroon);
		expect(lndMacaroonHex(path.join(h, 'admin.macaroon'))).to.equal(hex);
		// An existing boltzd config can hold the credential inline.
		expect(lndMacaroonHex(hex.toUpperCase())).to.equal(hex);
		expect(lndMacaroonHex(` ${hex}\n`)).to.equal(hex);
		// Nothing that looks like a credential is ever quoted back.
		let leaked = '';
		try {
			lndMacaroonHex(`${hex}a`);
		} catch (err) {
			leaked = (err as Error).message;
		}
		expect(leaked).to.match(/odd number of characters/);
		expect(leaked).to.not.contain(hex.slice(0, 32));
		const missing = path.join(h, 'nope.macaroon');
		expect(() => lndMacaroonHex(missing)).to.throw(/nope.macaroon: ENOENT/);
	});

	it('is read from the config, hex or path alike', function () {
		const h = home();
		const hex = mintMacaroon().toString('hex');
		write(
			path.join(h, '.boltz', 'boltz.toml'),
			`network = "regtest"\n[LND]\nmacaroon = "${hex}"\n[Roux]\nprovider = "${PROVIDER}"\n[Roux.Bitcoind]\nuser = "u"\npass = "p"\n`
		);
		expect(loadBoltzDaemonConfig([], h).lnd!.macaroon).to.equal(hex);
	});
});

describe('roux-boltzd auth', function () {
	it("accepts boltzd's admin and readonly macaroons byte for byte, read-only for read methods", function () {
		const h = home();
		const admin = mintMacaroon();
		const readonly = mintMacaroon();
		write(path.join(h, 'admin.macaroon'), admin);
		write(path.join(h, 'readonly.macaroon'), readonly);
		const auth = new RpcAuth({
			adminMacaroonPath: path.join(h, 'admin.macaroon'),
			readonlyMacaroonPath: path.join(h, 'readonly.macaroon')
		});
		expect(auth.init().minted).to.deep.equal([]);
		const asAdmin = metadata({ macaroon: admin.toString('hex') });
		const asReader = metadata({ macaroon: readonly.toString('hex') });
		expect(auth.check('CreateSwap', asAdmin)).to.equal(null);
		expect(auth.check('GetSwapInfo', asReader)).to.equal(null);
		expect(auth.check('GetSwapInfoStream', asReader)).to.equal(null);
		expect(auth.check('CreateSwap', asReader)!.code).to.equal(
			grpc.status.PERMISSION_DENIED
		);
		expect(auth.check('Stop', asReader)!.code).to.equal(
			grpc.status.PERMISSION_DENIED
		);
		expect(auth.check('GetInfo', new grpc.Metadata())!.code).to.equal(
			grpc.status.UNAUTHENTICATED
		);
		expect(
			auth.check(
				'GetInfo',
				metadata({ macaroon: mintMacaroon().toString('hex') })
			)!.code
		).to.equal(grpc.status.UNAUTHENTICATED);
		expect(
			auth.check('GetInfo', metadata({ macaroon: 'not-hex' }))!.code
		).to.equal(grpc.status.UNAUTHENTICATED);
	});

	it('mints missing macaroons as v2 macaroons, 0600, and honours password and noMacaroons', function () {
		const h = home();
		const auth = new RpcAuth({
			adminMacaroonPath: path.join(h, 'm', 'admin.macaroon'),
			readonlyMacaroonPath: path.join(h, 'm', 'readonly.macaroon')
		});
		expect(auth.init().minted).to.have.length(2);
		const admin = fs.readFileSync(path.join(h, 'm', 'admin.macaroon'));
		expect(admin[0]).to.equal(2);
		expect(admin.subarray(3, 8).toString()).to.equal('boltz');
		expect(
			fs.statSync(path.join(h, 'm', 'admin.macaroon')).mode & 0o777
		).to.equal(0o600);
		expect(
			auth.check('CreateSwap', metadata({ macaroon: admin.toString('hex') }))
		).to.equal(null);

		const password = new RpcAuth({
			password: 'hunter2',
			adminMacaroonPath: '/nonexistent/a',
			readonlyMacaroonPath: '/nonexistent/r'
		});
		expect(password.init().minted).to.deep.equal([]);
		expect(
			password.check('CreateSwap', metadata({ authorization: 'hunter2' }))
		).to.equal(null);
		expect(
			password.check('CreateSwap', metadata({ authorization: 'hunter3' }))!.code
		).to.equal(grpc.status.UNAUTHENTICATED);

		const open = new RpcAuth({
			noMacaroons: true,
			adminMacaroonPath: '/nonexistent/a',
			readonlyMacaroonPath: '/nonexistent/r'
		});
		open.init();
		expect(open.check('Stop', new grpc.Metadata())).to.equal(null);
	});

	it('serves plaintext only on loopback without a TLS pair, and refuses half a pair', function () {
		const h = home();
		const certPath = path.join(h, 'tls.cert');
		const keyPath = path.join(h, 'tls.key');
		const local = serverCredentials({ certPath, keyPath, host: '127.0.0.1' });
		expect(local.tls).to.equal(false);
		expect(local.warning).to.match(/plaintext/);
		expect(() =>
			serverCredentials({ certPath, keyPath, host: '0.0.0.0' })
		).to.throw(/will not serve 0.0.0.0 in plaintext/);
		expect(
			serverCredentials({ certPath, keyPath, host: '0.0.0.0', noTls: true }).tls
		).to.equal(false);
		write(certPath, 'x');
		expect(() =>
			serverCredentials({ certPath, keyPath, host: '127.0.0.1' })
		).to.throw(/only one of/);
	});
});
