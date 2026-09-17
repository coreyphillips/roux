/**
 * A REAL LND node gets JIT inbound liquidity from a REAL beignet LSP,
 * through roux.
 *
 * Needs the beignet interop docker stack (the `lnd` container, REST on
 * 8091, macaroon read with `docker exec`); the whole suite skips cleanly
 * without it. The beignet LSP runs in this process and listens on every
 * interface so the container can dial it at host.docker.internal.
 *
 * What is proven: LND dials the LSP on roux's request, roux drives
 * the quote and the intent over LND's own connection (LND's custom-message
 * REST API), the LSP's intent ledger names LND's identity as the wallet it
 * will open to, the grant is in hop mode with the fee in the hint, and
 * LND's AddInvoice accepts that hint and encodes it into a BOLT 11 invoice
 * a payer would route through the intercept scid.
 */

import { expect } from 'chai';
import { execSync } from 'child_process';
import https from 'https';
import { crypto as lnCrypto, invoice, node as lnNode } from 'beignet/lightning';
import { BeignetClient, LndPeerLink } from '../../src';
import { freePort, sha } from '../helpers';

const LND_REST_PORT = Number(process.env.LND_REST_PORT ?? 8091);
const LND_HOST = process.env.LND_REST_HOST ?? '127.0.0.1';
/** How the LND container reaches this process. */
const HOST_FROM_DOCKER = process.env.LND_DIAL_HOST ?? 'host.docker.internal';

function loadMacaroon(): string | null {
	try {
		return execSync(
			'docker exec lnd cat /root/.lnd/data/chain/bitcoin/regtest/admin.macaroon',
			{ encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] }
		).toString('hex');
	} catch {
		return null;
	}
}

function lndRequest<T>(
	macaroon: string,
	method: string,
	path: string,
	body?: unknown
): Promise<T> {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const req = https.request(
			{
				hostname: LND_HOST,
				port: LND_REST_PORT,
				path,
				method,
				rejectUnauthorized: false,
				headers: {
					'Grpc-Metadata-macaroon': macaroon,
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
		req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
		if (data) req.write(data);
		req.end();
	});
}

type NodeConfig = ConstructorParameters<typeof lnNode.LightningNode>[0];

function makeBasepoints(seed: Buffer): NodeConfig['channelBasepoints'] {
	const key = (i: number): Buffer => sha(seed, Buffer.from([i]));
	return {
		fundingPubkey: lnCrypto.getPublicKey(key(0)),
		revocationBasepoint: lnCrypto.getPublicKey(key(1)),
		paymentBasepoint: lnCrypto.getPublicKey(key(2)),
		delayedPaymentBasepoint: lnCrypto.getPublicKey(key(3)),
		htlcBasepoint: lnCrypto.getPublicKey(key(4)),
		firstPerCommitmentPoint: Buffer.alloc(33)
	};
}

describe('JIT inbound liquidity for a real LND node (docker)', function () {
	this.timeout(120_000);

	let macaroon: string | null = null;
	let lsp: lnNode.LightningNode | null = null;
	let port = 0;

	before(async function () {
		macaroon = loadMacaroon();
		if (!macaroon) {
			console.log('    [skip] docker lnd not available');
			this.skip();
			return;
		}
		try {
			await lndRequest(macaroon, 'GET', '/v1/getinfo');
		} catch {
			console.log('    [skip] lnd REST not reachable on', LND_REST_PORT);
			this.skip();
			return;
		}
		// A fresh LSP identity per run, so a stale peer entry in LND cannot
		// answer for it.
		const seed = sha(`roux-lnd-live-${Date.now()}`);
		lsp = new lnNode.LightningNode({
			nodePrivateKey: sha(seed, 'identity'),
			channelBasepoints: makeBasepoints(seed),
			perCommitmentSeed: sha(seed, 'per-commitment'),
			fundingPrivkey: sha(seed, Buffer.from([0])),
			htlcBasepointSecret: sha(seed, Buffer.from([4])),
			network: invoice.Network.REGTEST,
			enableNetworking: true,
			jitReceive: {
				enabled: true,
				flatFeeSat: 250n,
				feePpm: 2_000,
				maxClientFundingSats: 5_000_000n
			}
		});
		lsp.on('error', () => {});
		lsp.on('node:error', () => {});
		port = await freePort();
		await lsp.listen(port, '0.0.0.0');
	});

	after(() => {
		lsp?.destroy();
	});

	it('registers an intent over LND and gets an invoice hint LND encodes', async () => {
		const link = new LndPeerLink({
			host: LND_HOST,
			port: LND_REST_PORT,
			macaroonHex: macaroon!,
			rejectUnauthorized: false,
			peerRefreshMs: 2_000
		});
		const client = new BeignetClient({ link, network: 'regtest' });
		const lspPubkey = lsp!.getNodeId();
		try {
			await client.connect(`${lspPubkey}@${HOST_FROM_DOCKER}:${port}`);
			expect(client.isConnected(lspPubkey)).to.equal(true);
			// The LSP sees LND's identity on the connection, not roux's.
			const lndInfo = await lndRequest<{ identity_pubkey: string }>(
				macaroon!,
				'GET',
				'/v1/getinfo'
			);
			expect(client.nodeIdHex()).to.equal(lndInfo.identity_pubkey);
			expect(lsp!.listPeers().map((p) => p.pubkey)).to.include(
				lndInfo.identity_pubkey
			);

			const quote = await client.jit.quote(lspPubkey, {
				maxAmountSat: 200_000,
				timeoutMs: 30_000
			});
			expect(quote.accepted, quote.reason).to.equal(true);
			expect(quote.flatFeeSat).to.equal(250n);
			expect(quote.feePpm).to.equal(2_000);

			// LND cannot settle a skimmed HTLC, so the default asks for hop mode.
			const grant = await client.jit.authorize(lspPubkey, {
				maxAmountSat: 200_000,
				expectedTotalSat: 200_000,
				timeoutMs: 30_000
			});
			expect(grant.feeMode).to.equal('hop');
			expect(grant.routeHint.feeBaseMsat).to.equal(250_000);
			expect(grant.routeHint.feeProportionalMillionths).to.equal(2_000);
			const intent = lsp!
				.getJitReceiveManager()!
				.listIntents()
				.find((i) => i.interceptScidHex === grant.interceptScidHex);
			expect(intent, 'the LSP did not record the intent').to.not.equal(
				undefined
			);
			expect(intent!.walletPubkeyHex).to.equal(lndInfo.identity_pubkey);
			expect(intent!.feeMode).to.equal('hop');

			// LND encodes the hint into a real invoice.
			const created = await lndRequest<{ payment_request: string }>(
				macaroon!,
				'POST',
				'/v1/invoices',
				{
					value: '200000',
					memo: 'roux jit',
					route_hints: [{ hop_hints: [grant.lndHopHint()] }],
					cltv_expiry: String(grant.minFinalCltvExpiry)
				}
			);
			const decoded = invoice.decode(created.payment_request);
			expect(decoded.amountMsat).to.equal(200_000_000n);
			const hint = decoded.routingHints
				?.flat()
				.find(
					(h) => h.shortChannelId.toString('hex') === grant.interceptScidHex
				);
			expect(hint, 'the intercept scid is not in the invoice').to.not.equal(
				undefined
			);
			expect(hint!.pubkey.toString('hex')).to.equal(lspPubkey);
			expect(hint!.feeBaseMsat).to.equal(250_000);
			expect(hint!.feeProportionalMillionths).to.equal(2_000);
			expect(hint!.cltvExpiryDelta).to.equal(grant.routeHint.cltvExpiryDelta);
			expect(decoded.minFinalCltvExpiry).to.equal(grant.minFinalCltvExpiry);
		} finally {
			await client.close();
		}
	});
});
