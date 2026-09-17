/**
 * LND: register JIT inbound liquidity and create an invoice.
 *
 *   LND_REST=127.0.0.1:8080 LND_MACAROON=<admin macaroon hex> \
 *   BEIGNET_LSP=<pubkey@host:port> NETWORK=mainnet AMOUNT_SATS=100000 \
 *     npm run example:lnd-jit
 *
 * What happens:
 *   1. roux asks LND (over its REST API) to connect to the beignet LSP,
 *      so the LSP sees LND's own identity on the wire.
 *   2. roux prices the receive (quote) and registers the intent
 *      (authorize) through LND's custom-message API. LND cannot settle an
 *      HTLC short of the onion amount, so the intent asks for hop mode: the
 *      LSP's opening fee comes back inside the route hint, as a routing fee
 *      the SENDER pays.
 *   3. roux calls LND's AddInvoice with that hint and the final CLTV the
 *      LSP needs, and prints the BOLT 11 invoice.
 *   4. When someone pays it, the LSP holds the HTLC, opens a zero-conf
 *      channel to this LND node, and forwards the full amount through it.
 *      LND must accept a zero-conf channel from the LSP: run lnd with
 *      `--protocol.option-scid-alias --protocol.zero-conf` and a
 *      ChannelAcceptor that explicitly accepts zero-conf from the trusted
 *      LSP. This script does not install the acceptor or pay the invoice;
 *      see example/README.md and LND's channel-acceptor documentation.
 *
 * Needs a macaroon with peers:write, info:read, offchain:write (custom
 * messages) and invoices:write.
 */

import https from 'https';
import http from 'http';
import { BeignetClient, LndPeerLink, consoleLog } from '../src';

interface ILndRest {
	host: string;
	port: number;
	macaroon: string;
	tls: boolean;
}

/** One LND REST call, the way LndPeerLink makes its own. */
function lnd<T>(
	rest: ILndRest,
	method: string,
	path: string,
	body?: unknown
): Promise<T> {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const req = (rest.tls ? https : http).request(
			{
				hostname: rest.host,
				port: rest.port,
				path,
				method,
				rejectUnauthorized: false,
				headers: {
					'Grpc-Metadata-macaroon': rest.macaroon,
					'Content-Type': 'application/json',
					...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
				}
			},
			(res) => {
				let text = '';
				res.on('data', (c) => (text += c));
				res.on('end', () => {
					if ((res.statusCode ?? 0) >= 400) {
						reject(
							new Error(`${method} ${path}: HTTP ${res.statusCode} ${text}`)
						);
						return;
					}
					resolve(JSON.parse(text) as T);
				});
			}
		);
		req.on('error', reject);
		if (data) req.write(data);
		req.end();
	});
}

async function main(): Promise<void> {
	const [host, port] = (process.env.LND_REST ?? '127.0.0.1:8080').split(':');
	const rest: ILndRest = {
		host,
		port: Number(port),
		macaroon: process.env.LND_MACAROON ?? '',
		tls: process.env.LND_TLS !== 'false'
	};
	const amountSats = Number(process.env.AMOUNT_SATS ?? 100_000);
	const network =
		(process.env.NETWORK as 'mainnet' | 'regtest' | 'signet' | 'testnet') ??
		'regtest';

	const client = new BeignetClient({
		network,
		link: new LndPeerLink({
			host: rest.host,
			port: rest.port,
			macaroonHex: rest.macaroon,
			https: rest.tls,
			rejectUnauthorized: false,
			log: consoleLog('lnd-link')
		}),
		log: consoleLog('roux')
	});
	try {
		// 1. LND dials the LSP.
		const lsp = await client.connect(process.env.BEIGNET_LSP ?? '');
		console.log(
			'LND is',
			client.nodeIdHex(),
			'connected to LSP',
			lsp.pubkeyHex
		);

		// 2. Price, then register.
		const quote = await client.jit.quote(lsp.pubkeyHex, {
			maxAmountSat: amountSats
		});
		console.log('quote', {
			accepted: quote.accepted,
			flatFeeSat: quote.flatFeeSat.toString(),
			feePpm: quote.feePpm,
			openingFeeSats: quote.feeSats.toString(),
			lspWouldFrontSats: quote.fundingSats.toString(),
			reason: quote.reason
		});
		if (!quote.accepted) return;
		const grant = await client.jit.authorize(lsp.pubkeyHex, {
			maxAmountSat: amountSats,
			expectedTotalSat: amountSats
			// acceptsSkimmedFee stays false: LND needs hop mode.
		});
		console.log('grant', {
			feeMode: grant.feeMode,
			interceptScid: grant.clnShortChannelId(),
			senderPaysSats: grant.openingFeeSats(amountSats).toString()
		});

		// 3. The invoice, on LND.
		const created = await lnd<{ payment_request: string; r_hash: string }>(
			rest,
			'POST',
			'/v1/invoices',
			{
				value: String(amountSats),
				memo: 'inbound via beignet JIT',
				route_hints: [{ hop_hints: [grant.lndHopHint()] }],
				cltv_expiry: String(grant.minFinalCltvExpiry)
			}
		);
		console.log('invoice', created.payment_request);
		console.log(
			'payment hash',
			Buffer.from(created.r_hash, 'base64').toString('hex')
		);
	} finally {
		await client.close();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
