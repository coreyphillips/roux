import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	BeignetClient,
	FileStorage,
	NoisePeerLink,
	formatNodeUri,
	parseNodeUri
} from '../../src';

const PK = '02' + '11'.repeat(32);

describe('node URIs', () => {
	it('parses TCP, bracketed IPv6 and WebSocket forms', () => {
		expect(parseNodeUri(`${PK}@lsp.example:9735`)).to.deep.equal({
			pubkeyHex: PK,
			host: 'lsp.example',
			port: 9735
		});
		expect(parseNodeUri(`${PK.toUpperCase()}@[::1]:9736`)).to.deep.equal({
			pubkeyHex: PK,
			host: '::1',
			port: 9736
		});
		expect(parseNodeUri(`${PK}@wss://lsp.example:443`)).to.deep.equal({
			pubkeyHex: PK,
			host: 'lsp.example',
			port: 443,
			webSocketUrl: 'wss://lsp.example:443'
		});
		expect(() => parseNodeUri('nope')).to.throw(/missing @/);
		expect(() => parseNodeUri(`${PK}@host`)).to.throw(/port/);
		expect(formatNodeUri(PK, '::1', 1)).to.equal(`${PK}@[::1]:1`);
	});
});

describe('BeignetClient', () => {
	it('needs a wallet before it will pay a direct-funding request', async () => {
		const link = new NoisePeerLink({ network: 'regtest' });
		const client = new BeignetClient({ link, network: 'regtest' });
		expect(() => client.directFunding).to.throw(/needs a `wallet`/);
		expect(client.nodeIdHex()).to.match(/^0[23][0-9a-f]{64}$/);
		expect(client.isConnected(PK)).to.equal(false);
		await client.close();
	});

	it('refuses a link key of the wrong size', () => {
		expect(
			() =>
				new NoisePeerLink({ network: 'regtest', privateKey: Buffer.alloc(31) })
		).to.throw(/32 bytes/);
	});
});

describe('FileStorage', () => {
	it('persists atomically with owner-only permissions', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roux-'));
		const file = path.join(dir, 'nested', 'roux.json');
		const a = new FileStorage(file);
		expect(a.loadWalletData('k')).to.equal(null);
		a.saveWalletData('k', 'v1');
		a.saveWalletData('j', 'v2');
		const b = new FileStorage(file);
		expect(b.loadWalletData('k')).to.equal('v1');
		expect(b.loadWalletData('j')).to.equal('v2');
		expect(fs.statSync(file).mode & 0o777).to.equal(0o600);
		expect(fs.readdirSync(path.dirname(file))).to.deep.equal(['roux.json']);
		fs.rmSync(dir, { recursive: true });
	});
});
