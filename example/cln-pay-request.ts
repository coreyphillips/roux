/**
 * Core Lightning: pay a beignet wallet's direct-funding request from CLN's
 * own on-chain wallet, with no key leaving CLN.
 *
 *   CLN_REST=127.0.0.1:3010 CLN_RUNE=<rune> REQUEST='bitcoin:bc1...?bgnq=...' \
 *   NETWORK=mainnet ESPLORA=https://... npm run example:cln-pay
 *
 * CLN's only coin-key signing call is signpsbt, so the ownership proof is
 * the probe-transaction form: CLN signs a transaction spending the coin
 * that can never be broadcast (its second input spends an outpoint with no
 * preimage), and the receiver verifies that signature exactly as it will
 * later verify the funding witness. The receiver needs a beignet with that
 * proof form; an older one declines the offer and nothing is spent.
 *
 * The rune needs getinfo, listfunds, listtransactions, newaddr,
 * reserveinputs, unreserveinputs and signpsbt. ESPLORA (or any raw-tx
 * source) is used only for transactions CLN's wallet has not seen, i.e. the
 * LSP's inputs in the negotiated funding.
 */

import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import {
	BeignetClient,
	ClnWallet,
	FileStorage,
	NoisePeerLink,
	consoleLog
} from '../src';

function fetchHex(url: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const get = url.startsWith('https:') ? https.get : http.get;
		get(url, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => {
				if ((res.statusCode ?? 0) !== 200) {
					reject(new Error(`${url}: HTTP ${res.statusCode}`));
					return;
				}
				resolve(
					Buffer.from(Buffer.concat(chunks).toString('utf8').trim(), 'hex')
				);
			});
		}).on('error', reject);
	});
}

async function main(): Promise<void> {
	const [host, port] = (process.env.CLN_REST ?? '127.0.0.1:3010').split(':');
	const network =
		(process.env.NETWORK as 'mainnet' | 'regtest' | 'signet' | 'testnet') ??
		'regtest';
	const esplora = process.env.ESPLORA ?? 'http://127.0.0.1:3002';
	const wallet = new ClnWallet({
		host,
		port: Number(port),
		rune: process.env.CLN_RUNE ?? '',
		rejectUnauthorized: false,
		network,
		getTransaction: (txid): Promise<Buffer> =>
			fetchHex(`${esplora}/tx/${txid}/hex`),
		log: consoleLog('cln-wallet')
	});
	const client = new BeignetClient({
		network,
		link: new NoisePeerLink({ network, log: consoleLog('noise-link') }),
		wallet,
		storage: new FileStorage(
			path.join(os.homedir(), '.roux', 'cln-payments.json')
		),
		log: consoleLog('roux')
	});
	try {
		const request = process.env.REQUEST ?? '';
		const info = client.directFunding.inspect(request);
		console.log('request', {
			receiver: info.receiverNodeIdHex,
			amountSat: info.amountSat?.toString() ?? '(payer chooses)',
			lanes: info.transports,
			reachable: info.reachable
		});
		const result = await client.directFunding.pay(request, {
			amountSat: info.amountSat ?? BigInt(process.env.AMOUNT_SATS ?? 0),
			maxTotalFeeSat: Number(process.env.MAX_FEE_SATS ?? 1_000)
		});
		console.log('paid', {
			status: result.status,
			spent: `${result.spentTxid}:${result.spentVout}`,
			fundingTxid: result.fundingTxid,
			attested: result.attested,
			receipt: result.receiptPreimageHex,
			caveat: result.caveat
		});
	} finally {
		await client.close();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
