/**
 * ISwapFunder over LND's REST API: `POST /v1/transactions` (sendcoins) pays
 * the contract address from LND's on-chain wallet, with the swap's label
 * recorded on the transaction so a reply lost to a crash can be found
 * again through `GET /v1/transactions`. Needs onchain:write and
 * onchain:read.
 */

import { RouxLog, RouxNetwork, noopLog } from '../types';
import { IHttpEndpoint, requestJson } from '../link/http';
import { ISwapFunder } from './types';

export interface ILndFunderOptions {
	host: string;
	/** REST port (default 8080). */
	port?: number;
	macaroonHex: string;
	network: RouxNetwork;
	https?: boolean;
	ca?: IHttpEndpoint['ca'];
	rejectUnauthorized?: boolean;
	/** Confirmations the coins spent need (default 1: never build on unconfirmed change). */
	minConfs?: number;
	log?: RouxLog;
}

interface ILndTransaction {
	tx_hash: string;
	label?: string;
	output_details?: Array<{ address?: string; output_index?: string | number }>;
}

export class LndFunder implements ISwapFunder {
	private readonly ep: IHttpEndpoint;
	private readonly log: RouxLog;

	constructor(private readonly options: ILndFunderOptions) {
		this.ep = {
			host: options.host,
			port: options.port ?? 8080,
			https: options.https,
			ca: options.ca,
			rejectUnauthorized: options.rejectUnauthorized,
			headers: { 'Grpc-Metadata-macaroon': options.macaroonHex }
		};
		this.log = options.log ?? noopLog;
	}

	async fund(
		address: string,
		amountSat: bigint,
		opts: { label: string; feeRateSatPerVb?: number }
	): Promise<{ txidHex: string }> {
		const body: Record<string, unknown> = {
			addr: address,
			amount: amountSat.toString(),
			label: opts.label,
			min_confs: this.options.minConfs ?? 1,
			spend_unconfirmed: false
		};
		if (opts.feeRateSatPerVb !== undefined) {
			body.sat_per_vbyte = String(Math.max(1, Math.ceil(opts.feeRateSatPerVb)));
		}
		const res = await requestJson<{ txid: string }>(
			this.ep,
			'POST',
			'/v1/transactions',
			body
		);
		this.log('lnd_funding_sent', { txid: res.txid, label: opts.label });
		return { txidHex: res.txid };
	}

	async findFunding(
		address: string,
		label: string
	): Promise<{ txidHex: string; vout: number } | null> {
		const res = await requestJson<{ transactions: ILndTransaction[] }>(
			this.ep,
			'GET',
			'/v1/transactions?start_height=0&end_height=-1'
		);
		for (const tx of res.transactions) {
			const details = tx.output_details ?? [];
			const byAddress = details.find((d) => d.address === address);
			if (tx.label === label || byAddress) {
				const vout = Number(byAddress?.output_index ?? 0);
				return { txidHex: tx.tx_hash, vout: Number.isFinite(vout) ? vout : 0 };
			}
		}
		return null;
	}
}
