/**
 * ISwapLightningPayer over Core Lightning's clnrest.
 *
 * `pay` blocks until the payment resolves, and a hold invoice resolves when
 * the swap does, so the request is sent with a day-long timeout; if the
 * socket still drops, `trackPayment` (listpays) answers. Rune needs pay,
 * listpays and newaddr, plus invoice, listinvoices and listpeerchannels for
 * submarine swaps (the last one to see an HTLC parked on an unpaid
 * invoice; CLN 23.02 or later).
 */

import { RouxLog, RouxNetwork, noopLog } from '../types';
import { HttpError, IHttpEndpoint, requestJson } from '../link/http';
import crypto from 'crypto';
import { toOutputScript } from './verify';
import {
	ISwapCreateInvoiceParams,
	ISwapCreatedInvoice,
	ISwapInvoiceStatus,
	ISwapLightningPayer,
	ISwapPaymentStatus
} from './types';

export interface IClnPayerOptions {
	host: string;
	/** clnrest port (default 3010). */
	port?: number;
	rune: string;
	network: RouxNetwork;
	https?: boolean;
	ca?: IHttpEndpoint['ca'];
	rejectUnauthorized?: boolean;
	log?: RouxLog;
}

interface IClnPay {
	payment_hash: string;
	status: string;
	preimage?: string;
	payment_preimage?: string;
}

function mapStatus(p: IClnPay): ISwapPaymentStatus {
	const preimageHex = p.payment_preimage ?? p.preimage;
	if (p.status === 'complete') {
		return {
			status: 'succeeded',
			preimage: preimageHex ? Buffer.from(preimageHex, 'hex') : undefined
		};
	}
	if (p.status === 'failed') return { status: 'failed' };
	return { status: 'pending' };
}

const HOLD_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** The message of a CLN RPC error (`{code, message}` body), else null. */
function clnRpcError(err: unknown): string | null {
	if (!(err instanceof HttpError)) return null;
	try {
		const body = JSON.parse(err.body) as { code?: unknown; message?: unknown };
		if (typeof body.code === 'number' && typeof body.message === 'string') {
			return body.message;
		}
	} catch {
		/* not a JSON body */
	}
	return null;
}

export class ClnPayer implements ISwapLightningPayer {
	private readonly ep: IHttpEndpoint;
	private readonly log: RouxLog;

	constructor(private readonly options: IClnPayerOptions) {
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

	private rpc<T>(
		method: string,
		params: Record<string, unknown>,
		timeoutMs?: number
	): Promise<T> {
		const ep = timeoutMs === undefined ? this.ep : { ...this.ep, timeoutMs };
		return requestJson<T>(ep, 'POST', `/v1/${method}`, params);
	}

	async payInvoice(
		bolt11: string,
		opts: { maxFeeSat: bigint; timeoutSeconds: number }
	): Promise<ISwapPaymentStatus> {
		try {
			const res = await this.rpc<IClnPay>(
				'pay',
				{
					bolt11,
					maxfee: `${(opts.maxFeeSat * 1000n).toString()}msat`,
					retry_for: opts.timeoutSeconds
				},
				HOLD_REQUEST_TIMEOUT_MS
			);
			return mapStatus(res);
		} catch (err) {
			// Only CLN's own verdict fails the payment: an RPC error body
			// with a code is one. A dropped connection or a timeout is not:
			// the HTLC may be in flight, and listpays decides on the next
			// tick.
			const verdict = clnRpcError(err);
			if (verdict) {
				this.log('cln_pay_error', { error: verdict });
				return { status: 'failed', failureReason: verdict };
			}
			this.log('cln_pay_unresolved', {
				error: err instanceof Error ? err.message : String(err)
			});
			return { status: 'unknown' };
		}
	}

	async trackPayment(paymentHash: Buffer): Promise<ISwapPaymentStatus> {
		const hashHex = paymentHash.toString('hex');
		const res = await this.rpc<{ pays: IClnPay[] }>('listpays', {
			payment_hash: hashHex
		});
		const found = res.pays.find((p) => p.payment_hash === hashHex);
		return found ? mapStatus(found) : { status: 'unknown' };
	}

	async newDestinationScript(): Promise<Buffer> {
		const res = await this.rpc<{ bech32: string }>('newaddr', {
			addresstype: 'bech32'
		});
		return toOutputScript(res.bech32, this.options.network);
	}

	/** `invoice`: a regular invoice under a fresh label. */
	async createInvoice(
		params: ISwapCreateInvoiceParams
	): Promise<ISwapCreatedInvoice> {
		const res = await this.rpc<{ bolt11: string; payment_hash: string }>(
			'invoice',
			{
				amount_msat: params.amountMsat.toString(),
				label: `roux-swap-${crypto.randomBytes(8).toString('hex')}`,
				description: params.description,
				expiry: params.expirySeconds,
				cltv: params.minFinalCltvExpiry
			}
		);
		return {
			bolt11: res.bolt11,
			paymentHash: Buffer.from(res.payment_hash, 'hex')
		};
	}

	/**
	 * `listinvoices` by hash; an unpaid invoice with an incoming HTLC for
	 * the hash in `listpeerchannels` is one the payer is holding.
	 */
	async lookupInvoice(paymentHash: Buffer): Promise<ISwapInvoiceStatus> {
		const hashHex = paymentHash.toString('hex');
		const res = await this.rpc<{
			invoices: Array<{
				payment_hash: string;
				status: string;
				payment_preimage?: string;
			}>;
		}>('listinvoices', { payment_hash: hashHex });
		const inv = res.invoices.find((i) => i.payment_hash === hashHex);
		if (!inv) return { state: 'unknown' };
		if (inv.status === 'paid') {
			return {
				state: 'settled',
				preimage: inv.payment_preimage
					? Buffer.from(inv.payment_preimage, 'hex')
					: undefined,
				htlcsInFlight: 0
			};
		}
		if (inv.status === 'expired') return { state: 'expired', htlcsInFlight: 0 };
		let inFlight = 0;
		try {
			const channels = await this.rpc<{
				channels: Array<{
					htlcs?: Array<{ direction: string; payment_hash: string }>;
				}>;
			}>('listpeerchannels', {});
			for (const ch of channels.channels) {
				for (const h of ch.htlcs ?? []) {
					if (h.direction === 'in' && h.payment_hash === hashHex) inFlight++;
				}
			}
		} catch (err) {
			// Without listpeerchannels the gate cannot see a parked HTLC:
			// say so loudly rather than pretend the invoice is idle.
			this.log('cln_listpeerchannels_failed', {
				error: err instanceof Error ? err.message : String(err)
			});
			throw err;
		}
		return inFlight > 0
			? { state: 'accepted', htlcsInFlight: inFlight }
			: { state: 'open', htlcsInFlight: 0 };
	}
}
