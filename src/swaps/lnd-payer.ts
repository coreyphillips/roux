/**
 * ISwapLightningPayer over LND's REST API.
 *
 * `payInvoice` is the synchronous legacy send, which blocks for as long as
 * the hold does, which is the point (the swap's whole life is inside that
 * payment). `trackPayment` reads `GET /v1/payments?include_incomplete=true`
 * and matches the hash, which needs no encoding games with LND's path
 * params.
 *
 * Needs a macaroon with offchain:read, offchain:write and address:write,
 * plus invoices:read and invoices:write for submarine swaps (the admin
 * macaroon has them).
 */

import { RouxLog, RouxNetwork, noopLog } from '../types';
import { HttpError, IHttpEndpoint, requestJson } from '../link/http';

const PAYMENT_PAGE = 100;
/** Seeking backwards from past the end lands on the newest payments. */
const LND_MAX_PAYMENT_INDEX = 4294967295;

/** A hold invoice keeps the call open for as long as the swap runs. */
const HOLD_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;
import { toOutputScript } from './verify';
import {
	ISwapCreateInvoiceParams,
	ISwapCreatedInvoice,
	ISwapInvoiceStatus,
	ISwapLightningPayer,
	ISwapPaymentStatus
} from './types';

export interface ILndPayerOptions {
	host: string;
	/** REST port (default 8080). */
	port?: number;
	macaroonHex: string;
	network: RouxNetwork;
	https?: boolean;
	ca?: IHttpEndpoint['ca'];
	rejectUnauthorized?: boolean;
	log?: RouxLog;
}

interface ILndPayment {
	payment_hash: string;
	status: string;
	payment_preimage?: string;
	failure_reason?: string;
}

function mapStatus(p: ILndPayment): ISwapPaymentStatus {
	if (p.status === 'SUCCEEDED') {
		return {
			status: 'succeeded',
			preimage: p.payment_preimage
				? Buffer.from(p.payment_preimage, 'hex')
				: undefined
		};
	}
	if (p.status === 'FAILED') {
		return { status: 'failed', failureReason: p.failure_reason };
	}
	return { status: 'pending' };
}

export class LndPayer implements ISwapLightningPayer {
	private readonly ep: IHttpEndpoint;
	private readonly log: RouxLog;

	constructor(private readonly options: ILndPayerOptions) {
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

	/**
	 * The legacy synchronous send (`POST /v1/channels/transactions`), on
	 * purpose: it blocks until the HTLC settles or fails, which for a hold
	 * invoice is the swap's whole life, and it routes over a direct channel
	 * that lnd 0.20's SendPaymentV2 over REST refused with
	 * FAILURE_REASON_INSUFFICIENT_BALANCE in the live fixture.
	 */
	async payInvoice(
		bolt11: string,
		opts: { maxFeeSat: bigint; timeoutSeconds: number }
	): Promise<ISwapPaymentStatus> {
		const ep = { ...this.ep, timeoutMs: HOLD_REQUEST_TIMEOUT_MS };
		const res = await requestJson<{
			payment_error?: string;
			payment_preimage?: string;
		}>(ep, 'POST', '/v1/channels/transactions', {
			payment_request: bolt11,
			fee_limit: { fixed: opts.maxFeeSat.toString() },
			allow_self_payment: false
		});
		if (res.payment_error) {
			this.log('lnd_pay_error', { error: res.payment_error });
			return { status: 'failed', failureReason: res.payment_error };
		}
		// v1 answers the preimage base64 encoded; v1 listpayments hex.
		const preimage = res.payment_preimage
			? Buffer.from(res.payment_preimage, 'base64')
			: undefined;
		return { status: 'succeeded', preimage };
	}

	/**
	 * `/v1/payments` is paged (100 by default) and ordered oldest first, so
	 * a busy node would hide a recent payment behind its history. Seek
	 * backwards from the newest page until the hash turns up or the first
	 * payment is reached.
	 */
	async trackPayment(paymentHash: Buffer): Promise<ISwapPaymentStatus> {
		const hashHex = paymentHash.toString('hex');
		let indexOffset = LND_MAX_PAYMENT_INDEX;
		for (;;) {
			const res = await requestJson<{
				payments: ILndPayment[];
				first_index_offset?: string;
			}>(
				this.ep,
				'GET',
				`/v1/payments?include_incomplete=true&reversed=true` +
					`&max_payments=${PAYMENT_PAGE}&index_offset=${indexOffset}`
			);
			const found = res.payments.find((p) => p.payment_hash === hashHex);
			if (found) return mapStatus(found);
			const first = Number(res.first_index_offset ?? 0);
			if (res.payments.length === 0 || !(first > 1)) {
				return { status: 'unknown' };
			}
			indexOffset = first;
		}
	}

	async newDestinationScript(): Promise<Buffer> {
		const res = await requestJson<{ address: string }>(
			this.ep,
			'GET',
			'/v1/newaddress?type=WITNESS_PUBKEY_HASH'
		);
		return toOutputScript(res.address, this.options.network);
	}

	/** `POST /v1/invoices`: a regular invoice this node settles on arrival. */
	async createInvoice(
		params: ISwapCreateInvoiceParams
	): Promise<ISwapCreatedInvoice> {
		const res = await requestJson<{
			r_hash: string;
			payment_request: string;
		}>(this.ep, 'POST', '/v1/invoices', {
			value_msat: params.amountMsat.toString(),
			memo: params.description,
			expiry: String(params.expirySeconds),
			cltv_expiry: String(params.minFinalCltvExpiry),
			private: false
		});
		return {
			bolt11: res.payment_request,
			paymentHash: Buffer.from(res.r_hash, 'base64')
		};
	}

	/**
	 * `GET /v1/invoice/{hash}`. LND parks a partial MPP set on an OPEN
	 * invoice with its htlcs ACCEPTED: that counts as an HTLC in flight.
	 */
	async lookupInvoice(paymentHash: Buffer): Promise<ISwapInvoiceStatus> {
		let inv: {
			state?: string;
			settled?: boolean;
			r_preimage?: string;
			creation_date?: string;
			expiry?: string;
			htlcs?: Array<{ state?: string }>;
		};
		try {
			inv = await requestJson(
				this.ep,
				'GET',
				`/v1/invoice/${paymentHash.toString('hex')}`
			);
		} catch (err) {
			if (
				err instanceof HttpError &&
				(err.status === 404 || /unable to locate/i.test(err.body))
			) {
				return { state: 'unknown' };
			}
			throw err;
		}
		const inFlight = (inv.htlcs ?? []).filter(
			(h) => h.state === 'ACCEPTED'
		).length;
		if (inv.state === 'SETTLED' || inv.settled) {
			const preimage =
				inv.r_preimage &&
				Buffer.from(inv.r_preimage, 'base64').some((b) => b !== 0)
					? Buffer.from(inv.r_preimage, 'base64')
					: undefined;
			return { state: 'settled', preimage, htlcsInFlight: 0 };
		}
		if (inv.state === 'CANCELED')
			return { state: 'cancelled', htlcsInFlight: 0 };
		if (inv.state === 'ACCEPTED' || inFlight > 0) {
			return { state: 'accepted', htlcsInFlight: Math.max(1, inFlight) };
		}
		const created = Number(inv.creation_date ?? 0);
		const expiry = Number(inv.expiry ?? 0);
		if (created > 0 && expiry > 0 && (created + expiry) * 1000 <= Date.now()) {
			return { state: 'expired', htlcsInFlight: 0 };
		}
		return { state: 'open', htlcsInFlight: 0 };
	}

	/** Nothing to release: the payment call is a plain request. */
	close(): void {
		/* no long-lived streams */
	}
}
