/**
 * The host-side adapters against fakes of what they talk to: LndPayer over
 * a fake LND REST (streaming send, payments list, new address), ClnPayer
 * over a fake clnrest, BitcoinCoreChain over a fake JSON-RPC (the txindex
 * fallback, gettxout, already-known broadcasts), ElectrumChain over a fake
 * IChainBackend with and without listunspent, and the record store through
 * FileStorage.
 */

import { expect } from 'chai';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import * as bitcoin from 'bitcoinjs-lib';
import type { chain as beignetChain } from 'beignet/lightning';
import { crypto as bcrypto } from 'beignet/lightning';
import {
	BitcoinCoreChain,
	ClnPayer,
	ElectrumChain,
	FileStorage,
	LndPayer,
	ReverseSwapStore
} from '../../src';
import { IReverseSwapRecord } from '../../src/swaps/types';
import { freePort } from '../helpers';

type Handler = (
	method: string,
	url: string,
	body: unknown,
	res: http.ServerResponse
) => void;

async function fakeServer(handler: Handler): Promise<{
	port: number;
	close(): Promise<void>;
	calls: Array<{ method: string; url: string; body: unknown }>;
}> {
	const calls: Array<{ method: string; url: string; body: unknown }> = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			const body = raw ? JSON.parse(raw) : undefined;
			calls.push({ method: req.method!, url: req.url!, body });
			handler(req.method!, req.url!, body, res);
		});
	});
	const port = await freePort();
	await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
	return {
		port,
		calls,
		close: () => new Promise<void>((r) => server.close(() => r()))
	};
}

function json(res: http.ServerResponse, o: unknown, status = 200): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(o));
}

const PREIMAGE = crypto.randomBytes(32);
const HASH = crypto.createHash('sha256').update(PREIMAGE).digest();

describe('LndPayer', function () {
	it('pays through the synchronous send, tracks by hash, hands out an address', async function () {
		const lnd = await fakeServer((method, url, body, res) => {
			if (method === 'POST' && url === '/v1/channels/transactions') {
				expect(
					(body as { fee_limit: { fixed: string } }).fee_limit.fixed
				).to.equal('123');
				// The hold keeps the call open; lnd answers base64 here.
				setTimeout(
					() =>
						json(res, {
							payment_error: '',
							payment_preimage: PREIMAGE.toString('base64')
						}),
					30
				);
				return;
			}
			if (
				method === 'GET' &&
				url.startsWith('/v1/payments?include_incomplete=true&reversed=true')
			) {
				return json(res, {
					payments: [
						{ payment_hash: 'aa'.repeat(32), status: 'IN_FLIGHT' },
						{
							payment_hash: 'bb'.repeat(32),
							status: 'FAILED',
							failure_reason: 'FAILURE_REASON_NO_ROUTE'
						}
					]
				});
			}
			if (
				method === 'GET' &&
				url === '/v1/newaddress?type=WITNESS_PUBKEY_HASH'
			) {
				return json(res, {
					address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'
				});
			}
			json(res, { message: 'not found' }, 404);
		});
		const payer = new LndPayer({
			host: '127.0.0.1',
			port: lnd.port,
			macaroonHex: 'ab',
			https: false,
			network: 'regtest'
		});
		const paid = await payer.payInvoice('lnbcrt1fake', {
			maxFeeSat: 123n,
			timeoutSeconds: 60
		});
		expect(paid.status).to.equal('succeeded');
		expect(paid.preimage).to.deep.equal(PREIMAGE);
		expect(
			(await payer.trackPayment(Buffer.from('aa'.repeat(32), 'hex'))).status
		).to.equal('pending');
		const failed = await payer.trackPayment(
			Buffer.from('bb'.repeat(32), 'hex')
		);
		expect(failed.status).to.equal('failed');
		expect(failed.failureReason).to.equal('FAILURE_REASON_NO_ROUTE');
		expect(
			(await payer.trackPayment(Buffer.from('cc'.repeat(32), 'hex'))).status
		).to.equal('unknown');
		const script = await payer.newDestinationScript();
		expect(script[0]).to.equal(0);
		expect(script).to.have.length(22);
		payer.close();
		await lnd.close();
	});

	it('pages backwards through the payment list until the hash appears', async function () {
		const offsets: string[] = [];
		const lnd = await fakeServer((method, url, _body, res) => {
			if (method === 'GET' && url.startsWith('/v1/payments?')) {
				const offset = new URL(url, 'http://x').searchParams.get(
					'index_offset'
				)!;
				offsets.push(offset);
				if (offset === '4294967295') {
					return json(res, {
						payments: [
							{
								payment_hash: 'cc'.repeat(32),
								status: 'IN_FLIGHT',
								payment_index: '150'
							}
						],
						first_index_offset: '150',
						last_index_offset: '150'
					});
				}
				return json(res, {
					payments: [
						{
							payment_hash: HASH.toString('hex'),
							status: 'SUCCEEDED',
							payment_preimage: PREIMAGE.toString('hex'),
							payment_index: '149'
						}
					],
					first_index_offset: '149',
					last_index_offset: '149'
				});
			}
			json(res, {}, 404);
		});
		const payer = new LndPayer({
			host: '127.0.0.1',
			port: lnd.port,
			macaroonHex: 'ab',
			https: false,
			network: 'regtest'
		});
		const status = await payer.trackPayment(HASH);
		expect(status.status).to.equal('succeeded');
		expect(status.preimage!.equals(PREIMAGE)).to.equal(true);
		expect(offsets).to.deep.equal(['4294967295', '150']);
		await lnd.close();
	});

	it('a payment_error is a failed payment', async function () {
		const lnd = await fakeServer((method, url, _body, res) => {
			if (method === 'POST' && url === '/v1/channels/transactions') {
				return json(res, {
					payment_error: 'invoice expired',
					payment_preimage: ''
				});
			}
			json(res, {}, 404);
		});
		const payer = new LndPayer({
			host: '127.0.0.1',
			port: lnd.port,
			macaroonHex: 'ab',
			https: false,
			network: 'regtest'
		});
		const paid = await payer.payInvoice('lnbcrt1fake', {
			maxFeeSat: 1n,
			timeoutSeconds: 1
		});
		expect(paid.status).to.equal('failed');
		expect(paid.failureReason).to.equal('invoice expired');
		await lnd.close();
	});
});

describe('ClnPayer', function () {
	it('pays through pay, tracks through listpays, hands out a bech32 address', async function () {
		const cln = await fakeServer((method, url, body, res) => {
			expect(method).to.equal('POST');
			if (url === '/v1/pay') {
				expect((body as { maxfee: string }).maxfee).to.equal('50000msat');
				return json(res, {
					payment_hash: HASH.toString('hex'),
					status: 'complete',
					payment_preimage: PREIMAGE.toString('hex')
				});
			}
			if (url === '/v1/listpays') {
				const hash = (body as { payment_hash: string }).payment_hash;
				if (hash === 'aa'.repeat(32))
					return json(res, {
						pays: [{ payment_hash: hash, status: 'pending' }]
					});
				if (hash === 'bb'.repeat(32))
					return json(res, {
						pays: [{ payment_hash: hash, status: 'failed' }]
					});
				return json(res, { pays: [] });
			}
			if (url === '/v1/newaddr') {
				return json(res, {
					bech32: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'
				});
			}
			json(res, { message: 'no' }, 404);
		});
		const payer = new ClnPayer({
			host: '127.0.0.1',
			port: cln.port,
			rune: 'r',
			https: false,
			network: 'regtest'
		});
		const paid = await payer.payInvoice('lnbcrt1fake', {
			maxFeeSat: 50n,
			timeoutSeconds: 60
		});
		expect(paid.status).to.equal('succeeded');
		expect(paid.preimage).to.deep.equal(PREIMAGE);
		expect(
			(await payer.trackPayment(Buffer.from('aa'.repeat(32), 'hex'))).status
		).to.equal('pending');
		expect(
			(await payer.trackPayment(Buffer.from('bb'.repeat(32), 'hex'))).status
		).to.equal('failed');
		expect(
			(await payer.trackPayment(Buffer.from('cc'.repeat(32), 'hex'))).status
		).to.equal('unknown');
		expect(await payer.newDestinationScript()).to.have.length(22);
		await cln.close();
	});

	it('a dropped connection during pay is unknown, not failed: listpays decides', async function () {
		const cln = await fakeServer((_m, url, _b, res) => {
			if (url === '/v1/pay') {
				res.destroy();
				return;
			}
			json(res, {
				pays: [{ payment_hash: 'ab'.repeat(32), status: 'pending' }]
			});
		});
		const payer = new ClnPayer({
			host: '127.0.0.1',
			port: cln.port,
			rune: 'r',
			https: false,
			network: 'regtest'
		});
		const paid = await payer.payInvoice('lnbcrt1fake', {
			maxFeeSat: 50n,
			timeoutSeconds: 60
		});
		expect(paid.status).to.equal('unknown');
		const tracked = await payer.trackPayment(
			Buffer.from('ab'.repeat(32), 'hex')
		);
		expect(tracked.status).to.equal('pending');
		await cln.close();
	});

	it('an HTTP failure of pay reports failed with the reason, for listpays to settle', async function () {
		const cln = await fakeServer((_m, _u, _b, res) =>
			json(res, { code: -1, message: 'Invoice expired' }, 500)
		);
		const payer = new ClnPayer({
			host: '127.0.0.1',
			port: cln.port,
			rune: 'r',
			https: false,
			network: 'regtest'
		});
		const paid = await payer.payInvoice('lnbcrt1fake', {
			maxFeeSat: 50n,
			timeoutSeconds: 60
		});
		expect(paid.status).to.equal('failed');
		expect(paid.failureReason).to.match(/Invoice expired/);
		await cln.close();
	});
});

describe('BitcoinCoreChain', function () {
	const tx = new bitcoin.Transaction();
	tx.version = 2;
	tx.addInput(crypto.randomBytes(32), 0);
	tx.addOutput(
		bitcoin.payments.p2wpkh({
			pubkey: bcrypto.getPublicKey(crypto.randomBytes(32))
		}).output!,
		5_000
	);
	const txid = tx.getId();

	async function core(): Promise<{
		chain: BitcoinCoreChain;
		calls: Array<{ method: string; params: unknown[] }>;
		close(): Promise<void>;
	}> {
		const calls: Array<{ method: string; params: unknown[] }> = [];
		const server = await fakeServer((method, url, body, res) => {
			expect(url).to.equal('/wallet/w');
			const { method: m, params } = body as {
				method: string;
				params: unknown[];
			};
			calls.push({ method: m, params });
			const reply = (result: unknown): void =>
				json(res, { result, error: null, id: 1 });
			const error = (code: number, message: string): void =>
				json(res, { result: null, error: { code, message }, id: 1 });
			switch (m) {
				case 'getblockcount':
					return reply(1234);
				case 'getrawtransaction':
					if (params[0] !== txid)
						return error(-5, 'No such mempool or blockchain transaction');
					if (
						params.length === 1 &&
						!(calls.filter((c) => c.method === 'getrawtransaction').length > 1)
					) {
						return error(-5, 'No such mempool transaction. Use -txindex');
					}
					if (params[1] === true) return reply({ txid, confirmations: 3 });
					return reply(tx.toHex());
				case 'getblockhash':
					return reply('00'.repeat(32));
				case 'gettxout':
					if (params[1] === 0)
						return reply({
							value: 0.00005,
							confirmations: 3,
							scriptPubKey: { hex: tx.outs[0].script.toString('hex') }
						});
					return reply(null);
				case 'sendrawtransaction':
					return error(-27, 'Transaction already in block chain');
				case 'estimatesmartfee':
					return reply({ feerate: 0.00002 });
				case 'getrawmempool':
					return reply([]);
				default:
					return error(-32601, 'Method not found');
			}
		});
		return {
			chain: new BitcoinCoreChain({
				host: '127.0.0.1',
				port: server.port,
				user: 'u',
				pass: 'p',
				wallet: 'w'
			}),
			calls,
			close: server.close
		};
	}

	it('reads height, falls back to the block for a transaction without txindex, and maps gettxout', async function () {
		const c = await core();
		expect(await c.chain.currentHeight()).to.equal(1234);
		expect(await c.chain.getTransaction('ff'.repeat(32), 5)).to.equal(null);
		const raw = await c.chain.getTransaction(txid, 1200);
		expect(raw!.toString('hex')).to.equal(tx.toHex());
		expect(c.calls.filter((x) => x.method === 'getblockhash')).to.have.length(
			1
		);
		const out = await c.chain.getOutput(txid, 0);
		expect(out!.valueSat).to.equal(5_000n);
		expect(out!.confirmations).to.equal(3);
		expect(out!.height).to.equal(1232);
		expect(await c.chain.getOutput(txid, 1)).to.equal(null);
		expect(await c.chain.confirmations(txid)).to.equal(3);
		expect(await c.chain.confirmations('ff'.repeat(32))).to.equal(null);
		expect(await c.chain.estimateFeeRateSatPerVb(2)).to.equal(2);
		// Already-known is a success: the same bytes are already out.
		expect(await c.chain.broadcast(tx.toHex())).to.equal(txid);
		await c.close();
	});

	it('finds a mined claim without txindex by carrying the block it was scanned in', async function () {
		// A spend of the funding, mined in block 1290 on a node without
		// txindex: getrawtransaction answers only when told the block.
		const funding = new bitcoin.Transaction();
		funding.version = 2;
		funding.addInput(crypto.randomBytes(32), 0);
		funding.addOutput(tx.outs[0].script, 7_000);
		const claim = new bitcoin.Transaction();
		claim.version = 2;
		claim.addInput(funding.getHash(), 0);
		claim.addOutput(tx.outs[0].script, 6_000);
		const blockHash = 'ab'.repeat(32);
		const calls: string[] = [];
		const server = await fakeServer((_method, _url, body, res) => {
			const { method: m, params } = body as {
				method: string;
				params: unknown[];
			};
			calls.push(m + (params[2] !== undefined ? '+block' : ''));
			const reply = (result: unknown): void =>
				json(res, { result, error: null, id: 1 });
			const error = (code: number, message: string): void =>
				json(res, { result: null, error: { code, message }, id: 1 });
			switch (m) {
				case 'getblockcount':
					return reply(1300);
				case 'getrawmempool':
					return reply([]);
				case 'getblockhash':
					return reply(params[0] === 1290 ? blockHash : '00'.repeat(32));
				case 'getblock':
					if (params[0] !== blockHash) return reply({ tx: [] });
					return reply(
						params[1] === 2
							? {
									tx: [
										{
											txid: claim.getId(),
											vin: [{ txid: funding.getId(), vout: 0 }]
										}
									]
							  }
							: { tx: [claim.getId()] }
					);
				case 'getrawtransaction':
					if (params[0] !== claim.getId())
						return error(-5, 'No such transaction');
					if (params[2] !== blockHash)
						return error(-5, 'No such mempool transaction. Use -txindex');
					return reply(
						params[1] === true
							? { txid: claim.getId(), confirmations: 1 }
							: claim.toHex()
					);
				default:
					return error(-32601, 'Method not found');
			}
		});
		const chain = new BitcoinCoreChain({
			host: '127.0.0.1',
			port: server.port,
			user: 'u',
			pass: 'p',
			wallet: 'w'
		});
		// Found by the scan: its block is remembered for the depth lookup.
		expect(await chain.findSpender(funding.getId(), 0)).to.equal(claim.getId());
		expect(await chain.confirmations(claim.getId())).to.equal(1);
		expect(calls.filter((c) => c === 'getrawtransaction+block')).to.have.length(
			1
		);
		expect(
			(await chain.getTransaction(claim.getId()))!.equals(claim.toBuffer())
		).to.equal(true);
		// A fresh adapter (after a restart) with the persisted broadcast
		// height reaches a block far outside the recent window.
		const far = new BitcoinCoreChain({
			host: '127.0.0.1',
			port: server.port,
			user: 'u',
			pass: 'p',
			wallet: 'w',
			spenderScanDepth: 5
		});
		expect(await far.confirmations(claim.getId())).to.equal(null);
		expect(await far.confirmations(claim.getId(), 1290)).to.equal(1);
		// A fresh adapter (after a restart) locates the block itself.
		const fresh = new BitcoinCoreChain({
			host: '127.0.0.1',
			port: server.port,
			user: 'u',
			pass: 'p',
			wallet: 'w'
		});
		expect(await fresh.confirmations(claim.getId())).to.equal(1);
		await server.close();
	});
});

describe('ElectrumChain', function () {
	function backend(withUnspent: boolean): {
		backend: beignetChain.IChainBackend;
		funding: bitcoin.Transaction;
		spend: bitcoin.Transaction;
		history: Map<string, Array<{ txid: string; height: number }>>;
	} {
		const script = bitcoin.payments.p2wpkh({
			pubkey: bcrypto.getPublicKey(crypto.randomBytes(32))
		}).output!;
		const funding = new bitcoin.Transaction();
		funding.version = 2;
		funding.addInput(crypto.randomBytes(32), 0);
		funding.addOutput(script, 40_000);
		const spend = new bitcoin.Transaction();
		spend.version = 2;
		spend.addInput(funding.getHash(), 0);
		spend.addOutput(script, 39_000);
		const hash = crypto
			.createHash('sha256')
			.update(script)
			.digest()
			.reverse()
			.toString('hex');
		const history = new Map([[hash, [{ txid: funding.getId(), height: 500 }]]]);
		const txs = new Map([
			[funding.getId(), funding.toBuffer()],
			[spend.getId(), spend.toBuffer()]
		]);
		const b: beignetChain.IChainBackend = {
			subscribeToHeaders: async (cb) => cb(510),
			subscribeToScriptHash: async () => undefined,
			getScriptHashHistory: async (h) => history.get(h) ?? [],
			getTransaction: async (id) => {
				const raw = txs.get(id);
				if (!raw) throw new Error('unknown');
				return raw;
			},
			broadcastTransaction: async (hex) =>
				bitcoin.Transaction.fromHex(hex).getId(),
			...(withUnspent
				? {
						listUnspent: async (h) =>
							h === hash &&
							!history.get(hash)!.some((e) => e.txid === spend.getId())
								? [
										{
											txid: funding.getId(),
											outputIndex: 0,
											valueSat: 40_000,
											height: 500
										}
								  ]
								: []
				  }
				: {})
		};
		return { backend: b, funding, spend, history };
	}

	for (const withUnspent of [true, false]) {
		it(`answers height, outputs, spends and confirmations ${
			withUnspent ? 'with' : 'without'
		} listunspent`, async function () {
			const { backend: b, funding, spend, history } = backend(withUnspent);
			const chain = new ElectrumChain(b);
			expect(await chain.currentHeight()).to.equal(510);
			expect(
				(await chain.getTransaction(funding.getId()))!.toString('hex')
			).to.equal(funding.toHex());
			expect(await chain.getTransaction('ff'.repeat(32))).to.equal(null);
			const out = await chain.getOutput(funding.getId(), 0);
			expect(out!.valueSat).to.equal(40_000n);
			expect(out!.confirmations).to.equal(11);
			expect(await chain.confirmations(funding.getId())).to.equal(11);
			const found = await chain.findOutputs(funding.outs[0].script);
			expect(found[0].txidHex).to.equal(funding.getId());
			// Spent: gone from the unspent view, and the spender is named.
			history
				.get([...history.keys()][0])!
				.push({ txid: spend.getId(), height: 0 });
			expect(await chain.getOutput(funding.getId(), 0)).to.equal(null);
			expect(
				await chain.findSpender(funding.getId(), 0, funding.outs[0].script)
			).to.equal(spend.getId());
			expect(await chain.broadcast(spend.toHex())).to.equal(spend.getId());
		});
	}
});

describe('ReverseSwapStore', function () {
	it('round-trips through FileStorage and survives a corrupt document', function () {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roux-swaps-'));
		const file = path.join(dir, 'swaps.json');
		const store = new ReverseSwapStore(new FileStorage(file));
		const record: IReverseSwapRecord = {
			version: 1,
			swapIdHex: 'ab'.repeat(16),
			providerNodeIdHex: '02' + '11'.repeat(32),
			network: 'regtest',
			createdAt: 1,
			createdHeight: 1000,
			paymentHashHex: HASH.toString('hex'),
			preimageHex: PREIMAGE.toString('hex'),
			claimPrivkeyHex: '01'.repeat(32),
			claimPubkeyHex: '02' + '22'.repeat(32),
			refundPubkeyHex: '02' + '33'.repeat(32),
			refundHeight: 1144,
			htlcAddress: 'bcrt1q',
			htlcOutputScriptHex: '0020' + '44'.repeat(32),
			onchainAmountSat: '100000',
			invoiceAmountMsat: '101500000',
			totalFeeSat: '1500',
			bolt11: 'lnbcrt1',
			invoiceExpiresAt: 2,
			providerFundingConfirmations: 1,
			destinationScriptHex: '0014' + '55'.repeat(20),
			state: 'CREATED',
			updatedAt: 1
		};
		store.upsert(record);
		const again = new ReverseSwapStore(new FileStorage(file));
		expect(again.restore()).to.have.length(1);
		expect(again.get(record.swapIdHex)!.preimageHex).to.equal(
			record.preimageHex
		);
		expect(again.has(record.paymentHashHex)).to.equal(true);
		expect((fs.statSync(file).mode & 0o777).toString(8)).to.equal('600');
		fs.writeFileSync(file, '{not json');
		const corrupt = new ReverseSwapStore(new FileStorage(file));
		expect(() => corrupt.restore()).to.throw();
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
