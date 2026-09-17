/**
 * ISwapFunder over Core Lightning's clnrest: `withdraw` pays the contract
 * address from CLN's on-chain wallet. CLN records no label, so a reply lost
 * to a crash is found again by scanning `listtransactions` for an output
 * paying the address. Rune needs withdraw and listtransactions.
 */

import * as bitcoin from 'bitcoinjs-lib';
import { RouxLog, RouxNetwork, noopLog } from '../types';
import { IHttpEndpoint, requestJson } from '../link/http';
import { ISwapFunder } from './types';

export interface IClnFunderOptions {
	host: string;
	/** clnrest port (default 3010). */
	port?: number;
	rune: string;
	network: RouxNetwork;
	https?: boolean;
	ca?: IHttpEndpoint['ca'];
	rejectUnauthorized?: boolean;
	/** Confirmations the coins spent need (default 1). */
	minConf?: number;
	log?: RouxLog;
}

export class ClnFunder implements ISwapFunder {
	private readonly ep: IHttpEndpoint;
	private readonly log: RouxLog;

	constructor(private readonly options: IClnFunderOptions) {
		this.ep = {
			host: options.host,
			port: options.port ?? 3010,
			https: options.https,
			ca: options.ca,
			rejectUnauthorized: options.rejectUnauthorized,
			headers: { Rune: options.rune }
		};
		this.log = options.log ?? noopLog;
	}

	private rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
		return requestJson<T>(this.ep, 'POST', `/v1/${method}`, params);
	}

	async fund(
		address: string,
		amountSat: bigint,
		opts: { label: string; feeRateSatPerVb?: number }
	): Promise<{ txidHex: string; rawHex?: string }> {
		const params: Record<string, unknown> = {
			destination: address,
			satoshi: `${amountSat.toString()}sat`,
			minconf: this.options.minConf ?? 1
		};
		if (opts.feeRateSatPerVb !== undefined) {
			// CLN takes sat per kilo-vbyte (perkb) or per kilo-weight (perkw).
			params.feerate = `${Math.max(
				1000,
				Math.ceil(opts.feeRateSatPerVb * 1000)
			)}perkb`;
		}
		const res = await this.rpc<{ tx: string; txid: string }>(
			'withdraw',
			params
		);
		this.log('cln_funding_sent', { txid: res.txid, label: opts.label });
		return { txidHex: res.txid, rawHex: res.tx };
	}

	async findFunding(
		address: string
	): Promise<{ txidHex: string; vout: number } | null> {
		const net =
			this.options.network === 'mainnet'
				? bitcoin.networks.bitcoin
				: this.options.network === 'regtest'
				? bitcoin.networks.regtest
				: bitcoin.networks.testnet;
		const script = bitcoin.address.toOutputScript(address, net).toString('hex');
		const res = await this.rpc<{
			transactions: Array<{
				hash: string;
				outputs?: Array<{ index: number; scriptPubKey: string }>;
			}>;
		}>('listtransactions', {});
		for (const tx of res.transactions) {
			const out = (tx.outputs ?? []).find((o) => o.scriptPubKey === script);
			if (out) return { txidHex: tx.hash, vout: out.index };
		}
		return null;
	}
}
