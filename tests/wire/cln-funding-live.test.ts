/* eslint-disable @typescript-eslint/triple-slash-reference -- Source imports need beignet's ambient module declarations. */
/// <reference lib="dom" />
/// <reference path="../../node_modules/beignet/types/untyped-modules/index.d.ts" />
/**
 * CLN wallet -> roux -> real beignet receiver -> real beignet liquidity peer.
 * The complete channel funding is broadcast and confirmed on Bitcoin Core
 * regtest. No channel negotiation, witness delivery or balance is stubbed.
 *
 * REQUIRE_CLN_FUNDING_LIVE=1 makes absent infrastructure or coins fail the run.
 * Retains node databases and payer records, including after a failed assertion.
 * Never releases a coin merely because the test exits after signing.
 */
import { expect } from 'chai';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import * as bitcoin from 'bitcoinjs-lib';
import { LightningNode } from '../../node_modules/beignet/src/lightning/node/lightning-node';
import { Network } from '../../node_modules/beignet/src/lightning/invoice/types';
import {
	ChannelState,
	REGTEST_CHAIN_HASH
} from '../../node_modules/beignet/src/lightning/channel/types';
import type { IChainBackend } from '../../node_modules/beignet/src/lightning/chain/chain-watcher';
import {
	deriveLightningKeysFromMnemonic,
	LnCoinType
} from '../../node_modules/beignet/src/lightning/keys/wallet-keys';
import { SqliteStorage } from '../../node_modules/beignet/src/lightning/storage/sqlite-storage';
import {
	BeignetClient,
	ClnWallet,
	FileStorage,
	NoisePeerLink
} from '../../src';
import { freePort, waitFor } from '../helpers';

const AMOUNT = 100_000n;
const FEE_CEILING = 10_000n;
const MNEMONIC =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const REQUIRED = process.env.REQUIRE_CLN_FUNDING_LIVE === '1';

function bitcoinRpc<T>(method: string, params: unknown[] = []): Promise<T> {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
		const req = http.request(
			{
				hostname: process.env.BITCOIN_RPC_HOST ?? '127.0.0.1',
				port: Number(process.env.BITCOIN_RPC_PORT ?? 43782),
				path: `/wallet/${encodeURIComponent(
					process.env.BITCOIN_RPC_WALLET ?? 'default'
				)}`,
				method: 'POST',
				auth: `${process.env.BITCOIN_RPC_USER ?? 'polaruser'}:${
					process.env.BITCOIN_RPC_PASS ?? 'polarpass'
				}`,
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body)
				}
			},
			(res) => {
				let text = '';
				res.on('data', (chunk: Buffer) => {
					text += chunk.toString();
				});
				res.on('end', () => {
					try {
						const decoded = JSON.parse(text) as {
							result: T;
							error?: { message: string };
						};
						if (decoded.error)
							reject(new Error(`${method}: ${decoded.error.message}`));
						else resolve(decoded.result);
					} catch (error) {
						reject(error);
					}
				});
			}
		);
		req.setTimeout(15_000, () =>
			req.destroy(new Error(`${method}: RPC timeout`))
		);
		req.on('error', reject);
		req.end(body);
	});
}

function scriptHash(script: Buffer): string {
	return crypto
		.createHash('sha256')
		.update(script)
		.digest()
		.reverse()
		.toString('hex');
}

interface ICoreTransaction {
	hex: string;
	confirmations?: number;
}

/**
 * Indexes the transactions this test funds or broadcasts. Every transaction,
 * height, UTXO and spend comes from Core; this adapter only supplies Electrum's
 * script-hash lookup and subscription interface over that limited index.
 */
class TestChainBackend implements IChainBackend {
	private readonly transactions = new Map<string, bitcoin.Transaction>();
	private readonly headers = new Set<(height: number) => void>();
	private readonly scriptListeners = new Set<() => void>();
	readonly broadcasts = new Set<string>();

	async subscribeToHeaders(
		onNewBlock: (height: number) => void
	): Promise<void> {
		this.headers.add(onNewBlock);
		onNewBlock(await bitcoinRpc<number>('getblockcount'));
	}

	async subscribeToScriptHash(
		_hash: string,
		onChange: () => void
	): Promise<void> {
		this.scriptListeners.add(onChange);
	}

	async getTransaction(txid: string): Promise<Buffer> {
		const raw = await bitcoinRpc<string>('getrawtransaction', [txid]);
		const tx = bitcoin.Transaction.fromHex(raw);
		expect(tx.getId()).to.equal(txid);
		this.transactions.set(txid, tx);
		return Buffer.from(raw, 'hex');
	}

	async broadcastTransaction(hex: string): Promise<string> {
		const tx = bitcoin.Transaction.fromHex(hex);
		const txid = tx.getId();
		try {
			await bitcoinRpc<string>('sendrawtransaction', [hex]);
		} catch (error) {
			// Both real channel peers can publish the same transaction. An RPC
			// error is only harmless when Core already has these exact bytes.
			const known = await bitcoinRpc<string>('getrawtransaction', [txid]).catch(
				() => null
			);
			if (known !== hex) throw error;
		}
		this.transactions.set(txid, tx);
		this.broadcasts.add(txid);
		return txid;
	}

	async getScriptHashHistory(
		hash: string
	): Promise<Array<{ txid: string; height: number }>> {
		const tip = await bitcoinRpc<number>('getblockcount');
		const history: Array<{ txid: string; height: number }> = [];
		for (const [txid, tx] of [...this.transactions]) {
			const pays = tx.outs.some((out) => scriptHash(out.script) === hash);
			const spends = tx.ins.some((input) => {
				const prev = this.transactions.get(
					Buffer.from(input.hash).reverse().toString('hex')
				);
				return (
					prev?.outs[input.index] !== undefined &&
					scriptHash(prev.outs[input.index].script) === hash
				);
			});
			if (!pays && !spends) continue;
			const result = await bitcoinRpc<ICoreTransaction>('getrawtransaction', [
				txid,
				true
			]);
			history.push({
				txid,
				height: result.confirmations ? tip - result.confirmations + 1 : 0
			});
		}
		return history;
	}

	async listUnspent(hash: string): Promise<
		Array<{
			txid: string;
			outputIndex: number;
			valueSat: number;
			height: number;
		}>
	> {
		const tip = await bitcoinRpc<number>('getblockcount');
		const coins: Array<{
			txid: string;
			outputIndex: number;
			valueSat: number;
			height: number;
		}> = [];
		for (const [txid, tx] of [...this.transactions]) {
			for (let outputIndex = 0; outputIndex < tx.outs.length; outputIndex++) {
				const output = tx.outs[outputIndex];
				if (scriptHash(output.script) !== hash) continue;
				const unspent = await bitcoinRpc<{
					confirmations: number;
					scriptPubKey: { hex: string };
				} | null>('gettxout', [txid, outputIndex, true]);
				if (!unspent) continue;
				expect(unspent.scriptPubKey.hex).to.equal(
					output.script.toString('hex')
				);
				coins.push({
					txid,
					outputIndex,
					valueSat: output.value,
					height: unspent.confirmations ? tip - unspent.confirmations + 1 : 0
				});
			}
		}
		return coins;
	}

	async notify(): Promise<void> {
		const tip = await bitcoinRpc<number>('getblockcount');
		for (const cb of this.headers) cb(tip);
		for (const cb of this.scriptListeners) cb();
	}
}

describe('CLN pays into a real beignet channel and receives chain confirmation (docker)', function () {
	this.timeout(180_000);
	let wallet: ClnWallet;

	before(async function () {
		if (!REQUIRED) {
			this.skip();
			return;
		}
		let rune: string;
		try {
			const json = execFileSync(
				'docker',
				[
					'exec',
					process.env.CLN_CONTAINER ?? 'cln',
					'lightning-cli',
					'--network=regtest',
					'createrune'
				],
				{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
			);
			rune = (JSON.parse(json) as { rune: string }).rune;
			const info = await bitcoinRpc<{ chain: string }>('getblockchaininfo');
			expect(info.chain, 'Funding test requires regtest').to.equal('regtest');
			wallet = new ClnWallet({
				host: process.env.CLN_REST_HOST ?? '127.0.0.1',
				port: Number(process.env.CLN_REST_PORT ?? 3010),
				rune,
				rejectUnauthorized: false,
				network: 'regtest',
				getTransaction: async (txid): Promise<Buffer> =>
					Buffer.from(
						await bitcoinRpc<string>('getrawtransaction', [txid]),
						'hex'
					)
			});
			await wallet.refresh();
		} catch (error) {
			if (REQUIRED) throw error;
			console.log(`    [skip] CLN/Core unavailable: ${String(error)}`);
			this.skip();
		}
	});

	for (const kind of ['p2wpkh', 'p2tr'] as const) {
		it(`${kind}: broadcasts funding, confirms both channels NORMAL and credits the receiver`, async function () {
			await wallet.refresh();
			const chosen = wallet
				.listSpendable()
				.find(
					(coin) =>
						coin.script[0] === (kind === 'p2tr' ? 0x51 : 0) &&
						coin.valueSat > AMOUNT + FEE_CEILING
				);
			if (!chosen) {
				if (REQUIRED)
					throw new Error(
						`CLN needs a confirmed unreserved ${kind} coin above ${
							AMOUNT + FEE_CEILING
						} sat`
					);
				this.skip();
				return;
			}
			const directory = fs.mkdtempSync(
				path.join(os.tmpdir(), `roux-cln-funding-${kind}-`)
			);
			const receiverSeed = `receiver-${directory}`;
			const liquiditySeed = `liquidity-${directory}`;
			fs.writeFileSync(
				path.join(directory, 'regtest-recovery.json'),
				JSON.stringify(
					{
						mnemonic: MNEMONIC,
						receiverSeed,
						liquiditySeed,
						chosenOutpoint: `${chosen.txidHex}:${chosen.vout}`
					},
					null,
					2
				),
				{ mode: 0o600 }
			);
			console.log(`    retained regtest state: ${directory}`);
			const backend = new TestChainBackend();
			await backend.getTransaction(chosen.txidHex);
			const receiverStorage = new SqliteStorage(
				path.join(directory, 'receiver.sqlite')
			);
			const liquidityStorage = new SqliteStorage(
				path.join(directory, 'liquidity.sqlite')
			);
			receiverStorage.open();
			liquidityStorage.open();
			const liquidityKeys = deriveLightningKeysFromMnemonic(
				MNEMONIC,
				liquiditySeed,
				LnCoinType.REGTEST
			);
			const receiverKeys = deriveLightningKeysFromMnemonic(
				MNEMONIC,
				receiverSeed,
				LnCoinType.REGTEST
			);
			const liquidity = new LightningNode({
				...liquidityKeys,
				network: Network.REGTEST,
				enableNetworking: true,
				autoReconnect: false,
				localFeatures: LightningNode.defaultFeatures(),
				chainHashes: [REGTEST_CHAIN_HASH],
				preferAnchors: true,
				chainBackend: backend,
				storage: liquidityStorage
			});
			const receiver = new LightningNode({
				...receiverKeys,
				network: Network.REGTEST,
				enableNetworking: true,
				autoReconnect: false,
				localFeatures: LightningNode.defaultFeatures(),
				chainHashes: [REGTEST_CHAIN_HASH],
				preferAnchors: true,
				chainBackend: backend,
				storage: receiverStorage,
				directFunding: {
					directPeer: true,
					onion: false,
					relay: false,
					policy: {
						liquidityPeer: liquidity.getNodeId(),
						allowZeroConf: false,
						allowSplice: false
					}
				}
			});
			const errors: string[] = [];
			for (const [label, node] of [
				['receiver', receiver],
				['liquidity', liquidity]
			] as const) {
				node.on('error', (error: unknown) => {
					errors.push(`${label}: ${String(error)}`);
				});
				node.on('node:error', (error: { code?: string; message?: string }) => {
					errors.push(`${label}: ${error.code}: ${error.message}`);
				});
			}
			receiver.on('direct-funding:offer:declined', (data: unknown) => {
				errors.push(`offer declined: ${JSON.stringify(data)}`);
			});
			receiver.on('direct-funding:offer:failed', (data: unknown) => {
				errors.push(`offer failed: ${JSON.stringify(data)}`);
			});
			const narrowed = Object.create(wallet) as ClnWallet;
			narrowed.listSpendable = (): ReturnType<ClnWallet['listSpendable']> =>
				wallet
					.listSpendable()
					.filter(
						(coin) =>
							coin.txidHex === chosen.txidHex && coin.vout === chosen.vout
					);
			const client = new BeignetClient({
				link: new NoisePeerLink({ network: 'regtest' }),
				network: 'regtest',
				wallet: narrowed,
				storage: new FileStorage(path.join(directory, 'payer.json')),
				sender: {
					offerResendDelaysMs: [],
					offerTimeoutMs: 60_000,
					receiptTimeoutMs: 10_000
				}
			});
			try {
				const liquidityPort = await freePort();
				const receiverPort = await freePort();
				await liquidity.listen(liquidityPort, '127.0.0.1');
				await receiver.listen(receiverPort, '127.0.0.1');
				await receiver.connectPeer(
					liquidity.getNodeId(),
					'127.0.0.1',
					liquidityPort
				);
				await receiver.startDirectFunding();
				await backend.notify();
				const minted = receiver.mintDirectFundingRequest({
					host: '127.0.0.1',
					port: receiverPort,
					amountSat: AMOUNT
				});
				expect(receiver.getBalance().localBalanceMsat).to.equal(0n);
				const result = await client.directFunding.pay(minted.request, {
					maxTotalFeeSat: FEE_CEILING
				});
				expect(result.attested, JSON.stringify(errors)).to.equal(true);
				expect(result.spentTxid).to.equal(chosen.txidHex);
				expect(result.spentVout).to.equal(chosen.vout);
				expect(result.receiptPreimageHex, JSON.stringify(errors)).to.equal(
					minted.record.preimageHex
				);
				expect(result.fundingTxid).to.be.a('string');
				const fundingTxid = result.fundingTxid!;
				await waitFor(
					() => backend.broadcasts.has(fundingTxid),
					`Core broadcast of ${fundingTxid}: ${errors.join('; ')}`,
					30_000
				);
				const raw = await bitcoinRpc<ICoreTransaction>('getrawtransaction', [
					fundingTxid,
					true
				]);
				const fundingTx = bitcoin.Transaction.fromHex(raw.hex);
				expect(fundingTx.getId()).to.equal(fundingTxid);
				expect(
					fundingTx.ins.some(
						(input) =>
							Buffer.from(input.hash).reverse().toString('hex') ===
								chosen.txidHex && input.index === chosen.vout
					)
				).to.equal(true);
				expect(fundingTx.hasWitnesses()).to.equal(true);
				expect(
					await bitcoinRpc('gettxout', [chosen.txidHex, chosen.vout, true])
				).to.equal(null);
				const miningAddress = await bitcoinRpc<string>('getnewaddress', [
					'roux-live-confirmation',
					'bech32'
				]);
				await bitcoinRpc('generatetoaddress', [6, miningAddress]);
				const confirmed = await bitcoinRpc<ICoreTransaction>(
					'getrawtransaction',
					[fundingTxid, true]
				);
				expect(confirmed.confirmations).to.be.gte(6);
				await backend.notify();
				await waitFor(
					() =>
						receiver
							.listChannels()
							.some((channel) => channel.state === ChannelState.NORMAL) &&
						liquidity
							.listChannels()
							.some((channel) => channel.state === ChannelState.NORMAL),
					`both real channels NORMAL: ${errors.join('; ')}`,
					30_000
				);
				const received = receiver
					.listChannels()
					.find((channel) => channel.state === ChannelState.NORMAL)!;
				const supplied = liquidity
					.listChannels()
					.find((channel) => channel.state === ChannelState.NORMAL)!;
				expect(received.fundingTxid).to.equal(fundingTxid);
				expect(supplied.fundingTxid).to.equal(fundingTxid);
				expect(received.fundingSatoshis).to.equal(AMOUNT);
				expect(received.localBalanceMsat).to.equal(AMOUNT * 1000n);
				expect(receiver.getBalance().localBalanceMsat).to.equal(AMOUNT * 1000n);
				expect(supplied.remoteBalanceMsat).to.equal(received.localBalanceMsat);
				expect(fundingTx.outs[received.fundingOutputIndex!].value).to.equal(
					Number(AMOUNT)
				);
				// Core has confirmed the funding, but CLN's wallet scanner may
				// still be processing those blocks. Reconcile fresh CLN snapshots
				// until it independently sees the same confirmation.
				const reconciliationDeadline = Date.now() + 60_000;
				while (Date.now() < reconciliationDeadline) {
					await client.directFunding.reconcile();
					if (
						client.directFunding
							.payments()
							.find((payment) => payment.offerId === result.offerId)?.status ===
						'CONFIRMED'
					) {
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 1_000));
				}
				expect(
					client.directFunding
						.payments()
						.find((payment) => payment.offerId === result.offerId)?.status,
					`CLN tip ${narrowed.blockHeight()}, funding ${JSON.stringify(
						narrowed.txStatus(fundingTxid)
					)}`
				).to.equal('CONFIRMED');
			} catch (error) {
				console.error(
					`    diagnostics: ${errors.join('; ')}; retained state ${directory}`
				);
				throw error;
			} finally {
				try {
					await client.close();
				} finally {
					receiver.destroy();
					liquidity.destroy();
				}
				// Core decides whether a signed coin is spent. Pending signatures
				// and CLN reservations survive any test failure for reconciliation.
			}
		});
	}
});
