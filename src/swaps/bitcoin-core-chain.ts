/**
 * ISwapChain over Bitcoin Core's JSON-RPC. Core has no address index, so
 * this source answers by txid and outpoint (`getrawtransaction`, `gettxout`)
 * and the swap learns the funding txid from the provider's status reply,
 * then verifies the bytes itself. A node without txindex still serves a
 * transaction in the mempool, and a confirmed one given its block, which is
 * why `getTransaction` takes a height hint.
 */

import * as http from 'http';
import * as https from 'https';
import { RouxLog, noopLog } from '../types';
import { ISwapChain, ISwapChainOutput } from './types';

export interface IBitcoinCoreChainOptions {
	host: string;
	port: number;
	user: string;
	pass: string;
	/** Wallet name, when the node runs several (`/wallet/<name>`). */
	wallet?: string;
	https?: boolean;
	timeoutMs?: number;
	/** Blocks scanned back when a spender is looked for (default 50). */
	spenderScanDepth?: number;
	log?: RouxLog;
}

interface IRpcError {
	code: number;
	message: string;
}

export class BitcoinCoreRpcError extends Error {
	constructor(
		readonly method: string,
		readonly code: number,
		message: string
	) {
		super(`${method}: ${message} (${code})`);
		this.name = 'BitcoinCoreRpcError';
	}
}

export class BitcoinCoreChain implements ISwapChain {
	private readonly log: RouxLog;
	/**
	 * Block hashes of transactions met while scanning blocks. Without
	 * txindex, Core answers about a mined transaction only when told its
	 * block, so the scan that found a claim keeps the context its
	 * confirmation lookup needs.
	 */
	private readonly blockOf = new Map<string, string>();

	constructor(private readonly options: IBitcoinCoreChainOptions) {
		this.log = options.log ?? noopLog;
	}

	rpc<T>(method: string, params: unknown[] = []): Promise<T> {
		const o = this.options;
		return new Promise<T>((resolve, reject) => {
			const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
			const req = (o.https ? https : http).request(
				{
					hostname: o.host,
					port: o.port,
					path: o.wallet ? `/wallet/${encodeURIComponent(o.wallet)}` : '/',
					method: 'POST',
					auth: `${o.user}:${o.pass}`,
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
								error?: IRpcError;
							};
							if (decoded.error) {
								reject(
									new BitcoinCoreRpcError(
										method,
										decoded.error.code,
										decoded.error.message
									)
								);
							} else {
								resolve(decoded.result);
							}
						} catch (err) {
							reject(err);
						}
					});
				}
			);
			req.setTimeout(o.timeoutMs ?? 15_000, () =>
				req.destroy(new Error(`${method}: RPC timeout`))
			);
			req.on('error', reject);
			req.end(body);
		});
	}

	async currentHeight(): Promise<number> {
		return this.rpc<number>('getblockcount');
	}

	async getTransaction(
		txidHex: string,
		heightHint?: number
	): Promise<Buffer | null> {
		try {
			return Buffer.from(
				await this.rpc<string>('getrawtransaction', [txidHex]),
				'hex'
			);
		} catch (err) {
			const known = this.blockOf.get(txidHex);
			if (!known && (heightHint === undefined || heightHint <= 0)) return null;
			try {
				const blockHash =
					known ?? (await this.rpc<string>('getblockhash', [heightHint!]));
				return Buffer.from(
					await this.rpc<string>('getrawtransaction', [
						txidHex,
						false,
						blockHash
					]),
					'hex'
				);
			} catch {
				this.log('core_tx_unavailable', { txid: txidHex, error: String(err) });
				return null;
			}
		}
	}

	async getOutput(
		txidHex: string,
		vout: number
	): Promise<ISwapChainOutput | null> {
		const out = await this.rpc<{
			value: number;
			confirmations: number;
			scriptPubKey: { hex: string };
		} | null>('gettxout', [txidHex, vout, true]);
		if (!out) return null;
		const tip = await this.currentHeight();
		return {
			valueSat: BigInt(Math.round(out.value * 1e8)),
			script: Buffer.from(out.scriptPubKey.hex, 'hex'),
			confirmations: out.confirmations,
			height: out.confirmations > 0 ? tip - out.confirmations + 1 : 0
		};
	}

	async confirmations(
		txidHex: string,
		heightHint?: number
	): Promise<number | null> {
		try {
			const info = await this.rpc<{ confirmations?: number }>(
				'getrawtransaction',
				[txidHex, true]
			);
			return info.confirmations ?? 0;
		} catch {
			/* not in the mempool, and no txindex: try by block */
		}
		const blockHash =
			this.blockOf.get(txidHex) ??
			(await this.locateBlock(txidHex, heightHint));
		if (!blockHash) return null;
		try {
			const info = await this.rpc<{ confirmations?: number }>(
				'getrawtransaction',
				[txidHex, true, blockHash]
			);
			return info.confirmations ?? 0;
		} catch {
			return null;
		}
	}

	/**
	 * Find the block holding a transaction and remember it. With a height
	 * hint (where the caller last knew the transaction: its broadcast or
	 * confirmation height) the scan walks forward from just below the hint,
	 * since a transaction is mined at or after the height it was sent; the
	 * hint survives a restart in the swap record, the cache does not.
	 * Without a hint the last N blocks are scanned.
	 */
	private async locateBlock(
		txidHex: string,
		heightHint?: number
	): Promise<string | null> {
		try {
			const tip = await this.currentHeight();
			const depth = this.options.spenderScanDepth ?? 50;
			const heights: number[] = [];
			if (heightHint !== undefined && heightHint > 0) {
				const from = Math.max(1, heightHint - 2);
				for (let h = from; h <= Math.min(tip, from + depth); h++) {
					heights.push(h);
				}
			}
			for (let h = tip; h > Math.max(0, tip - depth); h--) {
				if (!heights.includes(h)) heights.push(h);
			}
			for (const h of heights) {
				const hash = await this.rpc<string>('getblockhash', [h]);
				const block = await this.rpc<{ tx: string[] }>('getblock', [hash, 1]);
				if (block.tx.includes(txidHex)) {
					this.blockOf.set(txidHex, hash);
					return hash;
				}
			}
		} catch (err) {
			this.log('core_block_scan_failed', { txid: txidHex, error: String(err) });
		}
		return null;
	}

	/** Scan the mempool and the last N blocks for an input spending the outpoint. */
	async findSpender(txidHex: string, vout: number): Promise<string | null> {
		interface ITx {
			txid: string;
			vin: Array<{ txid?: string; vout?: number }>;
		}
		const spends = (tx: ITx): boolean =>
			tx.vin.some((i) => i.txid === txidHex && i.vout === vout);
		const mempool = await this.rpc<string[]>('getrawmempool');
		for (const id of mempool) {
			try {
				const tx = await this.rpc<ITx>('getrawtransaction', [id, true]);
				if (spends(tx)) return tx.txid;
			} catch {
				/* evicted between the two calls */
			}
		}
		const tip = await this.currentHeight();
		const depth = this.options.spenderScanDepth ?? 50;
		for (let h = tip; h > Math.max(0, tip - depth); h--) {
			const hash = await this.rpc<string>('getblockhash', [h]);
			const block = await this.rpc<{ tx: ITx[] }>('getblock', [hash, 2]);
			const hit = block.tx.find(spends);
			if (hit) {
				this.blockOf.set(hit.txid, hash);
				return hit.txid;
			}
		}
		return null;
	}

	async broadcast(rawHex: string): Promise<string> {
		try {
			return await this.rpc<string>('sendrawtransaction', [rawHex]);
		} catch (err) {
			// Already known to the node: the same bytes are already out.
			const msg = err instanceof Error ? err.message : String(err);
			if (/already|txn-already-known|already in block chain/i.test(msg)) {
				const { Transaction } = await import('bitcoinjs-lib');
				return Transaction.fromHex(rawHex).getId();
			}
			throw err;
		}
	}

	async estimateFeeRateSatPerVb(targetBlocks: number): Promise<number | null> {
		try {
			const res = await this.rpc<{ feerate?: number }>('estimatesmartfee', [
				targetBlocks
			]);
			if (!res.feerate || res.feerate <= 0) return null;
			return res.feerate * 1e5;
		} catch {
			return null;
		}
	}
}
