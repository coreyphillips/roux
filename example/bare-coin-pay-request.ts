/**
 * Pay a beignet wallet's direct-funding request from a bare coin.
 *
 *   REQUEST='bitcoin:bcrt1...?bgnq=...' UTXO=<txid>:<vout>:<sats>:<address> \
 *     KEY=<32-byte hex private key> CHANGE=<address> ESPLORA=http://127.0.0.1:3002 \
 *     npm run example:pay
 *
 * The coin becomes an input of the receiver's channel funding transaction.
 * Nothing is signed until the negotiated transaction has been verified
 * against the request's attestation, and the payment record is durable
 * before the witness leaves, so re-running this command replays the
 * outcome rather than paying twice.
 */

import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import {
	BeignetClient,
	FileStorage,
	KeyedUtxoWallet,
	NoisePeerLink,
	consoleLog
} from '../src';

/** GET a hex transaction from an Esplora-style endpoint. */
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
	const network = (process.env.NETWORK as 'mainnet' | 'regtest') ?? 'regtest';
	const [txid, vout, sats, address] = (process.env.UTXO ?? '').split(':');
	const esplora = process.env.ESPLORA ?? 'http://127.0.0.1:3002';

	const wallet = new KeyedUtxoWallet({
		network,
		coins: [
			{
				txid,
				vout: Number(vout),
				valueSat: BigInt(sats),
				address,
				height: 1,
				privateKey: Buffer.from(process.env.KEY ?? '', 'hex')
			}
		],
		changeAddress: process.env.CHANGE ?? address,
		getTransaction: (id): Promise<Buffer> =>
			fetchHex(`${esplora}/tx/${id}/hex`),
		blockHeight: () => Number(process.env.TIP ?? 0)
	});

	const client = new BeignetClient({
		link: new NoisePeerLink({ network, log: consoleLog('noise-link') }),
		network,
		wallet,
		storage: new FileStorage(path.join(os.homedir(), '.roux', 'payments.json')),
		log: consoleLog('roux')
	});
	try {
		const request = process.env.REQUEST ?? '';
		const info = client.directFunding.inspect(request);
		console.log('request', {
			receiver: info.receiverNodeIdHex,
			amountSat: info.amountSat?.toString() ?? '(payer chooses)',
			expires: new Date(info.expiresAt).toISOString(),
			lanes: info.transports,
			reachable: info.reachable
		});
		const result = await client.directFunding.pay(request, {
			amountSat: info.amountSat ?? BigInt(process.env.AMOUNT ?? 0),
			maxTotalFeeSat: 1_000
		});
		console.log('paid', {
			status: result.status,
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
