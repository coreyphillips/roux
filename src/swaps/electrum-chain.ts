/**
 * ISwapChain over any beignet IChainBackend (an ElectrumBackend a host
 * built with its own Electrum client, or a backend of its own). This
 * adapter never constructs an Electrum client, so roux pulls in no
 * Electrum dependency; it only speaks the backend's script-hash shape.
 */

import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import type { chain } from 'beignet/lightning';
import { ISwapChain, ISwapChainOutput, ISwapFundingCandidate } from './types';

function scriptHash(script: Buffer): string {
	return crypto
		.createHash('sha256')
		.update(script)
		.digest()
		.reverse()
		.toString('hex');
}

export class ElectrumChain implements ISwapChain {
	private tip = 0;
	private subscribed: Promise<void> | null = null;

	constructor(private readonly backend: chain.IChainBackend) {}

	private async ensureTip(): Promise<void> {
		if (!this.subscribed) {
			this.subscribed = this.backend.subscribeToHeaders((height) => {
				if (height > this.tip) this.tip = height;
			});
		}
		await this.subscribed;
	}

	async currentHeight(): Promise<number> {
		await this.ensureTip();
		return this.tip;
	}

	async getTransaction(txidHex: string): Promise<Buffer | null> {
		try {
			const raw = await this.backend.getTransaction(txidHex);
			if (bitcoin.Transaction.fromBuffer(raw).getId() !== txidHex) return null;
			return raw;
		} catch {
			return null;
		}
	}

	async getOutput(
		txidHex: string,
		vout: number
	): Promise<ISwapChainOutput | null> {
		const raw = await this.getTransaction(txidHex);
		if (!raw) return null;
		const tx = bitcoin.Transaction.fromBuffer(raw);
		const out = tx.outs[vout];
		if (!out) return null;
		const hash = scriptHash(out.script);
		const tip = await this.currentHeight();
		if (this.backend.listUnspent) {
			const coins = await this.backend.listUnspent(hash);
			const coin = coins.find(
				(c) => c.txid === txidHex && c.outputIndex === vout
			);
			if (!coin) return null;
			return {
				valueSat: BigInt(coin.valueSat),
				script: out.script,
				confirmations: coin.height > 0 ? tip - coin.height + 1 : 0,
				height: coin.height
			};
		}
		const history = await this.backend.getScriptHashHistory(hash);
		const own = history.find((h) => h.txid === txidHex);
		if (!own) return null;
		const fundingHash = tx.getHash();
		for (const entry of history) {
			if (entry.txid === txidHex) continue;
			const spender = await this.getTransaction(entry.txid);
			if (!spender) continue;
			const spends = bitcoin.Transaction.fromBuffer(spender).ins.some(
				(i) => i.hash.equals(fundingHash) && i.index === vout
			);
			if (spends) return null;
		}
		return {
			valueSat: BigInt(out.value),
			script: out.script,
			confirmations: own.height > 0 ? tip - own.height + 1 : 0,
			height: own.height
		};
	}

	async findOutputs(outputScript: Buffer): Promise<ISwapFundingCandidate[]> {
		const hash = scriptHash(outputScript);
		if (this.backend.listUnspent) {
			const coins = await this.backend.listUnspent(hash);
			return coins.map((c) => ({
				txidHex: c.txid,
				vout: c.outputIndex,
				valueSat: BigInt(c.valueSat),
				height: c.height
			}));
		}
		const out: ISwapFundingCandidate[] = [];
		for (const entry of await this.backend.getScriptHashHistory(hash)) {
			const raw = await this.getTransaction(entry.txid);
			if (!raw) continue;
			bitcoin.Transaction.fromBuffer(raw).outs.forEach((o, vout) => {
				if (o.script.equals(outputScript)) {
					out.push({
						txidHex: entry.txid,
						vout,
						valueSat: BigInt(o.value),
						height: entry.height
					});
				}
			});
		}
		return out;
	}

	async findSpender(
		txidHex: string,
		vout: number,
		outputScript: Buffer
	): Promise<string | null> {
		const hash = scriptHash(outputScript);
		const fundingHash = Buffer.from(txidHex, 'hex').reverse();
		for (const entry of await this.backend.getScriptHashHistory(hash)) {
			if (entry.txid === txidHex) continue;
			const raw = await this.getTransaction(entry.txid);
			if (!raw) continue;
			const spends = bitcoin.Transaction.fromBuffer(raw).ins.some(
				(i) => i.hash.equals(fundingHash) && i.index === vout
			);
			if (spends) return entry.txid;
		}
		return null;
	}

	async confirmations(txidHex: string): Promise<number | null> {
		const raw = await this.getTransaction(txidHex);
		if (!raw) return null;
		const tx = bitcoin.Transaction.fromBuffer(raw);
		const tip = await this.currentHeight();
		for (const out of tx.outs) {
			const history = await this.backend.getScriptHashHistory(
				scriptHash(out.script)
			);
			const own = history.find((h) => h.txid === txidHex);
			if (own) return own.height > 0 ? tip - own.height + 1 : 0;
		}
		return null;
	}

	async broadcast(rawHex: string): Promise<string> {
		return this.backend.broadcastTransaction(rawHex);
	}
}
