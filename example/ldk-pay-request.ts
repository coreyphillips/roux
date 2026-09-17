/**
 * LDK (rust-lightning + BDK): pay a beignet wallet's direct-funding request
 * from the application's on-chain wallet.
 *
 *   REQUEST='bitcoin:bc1...?bgnq=...' COINS=coins.json CHANGE=<address> \
 *   ESPLORA=http://127.0.0.1:3002 TIP=<current height> \
 *   NETWORK=regtest npm run example:ldk-pay
 *
 * Paying needs no Lightning identity at all: roux dials the receiver (or
 * its LSP relay) with a fresh ephemeral key and the payer engine runs in
 * this process. What it needs from the application is the coin and the
 * ability to sign it, which BDK has. The simplest hand-over, used here, is
 * for the app to export the coin with its private key:
 *
 *   // coins.json contains txid, vout, valueSat, script, confirmed height,
 *   // and privateKey (32-byte hex) for each eligible coin.
 *
 * Derive the key through the wallet's complete descriptor path, including
 * its keychain and index. A child index alone is insufficient. The adapter
 * verifies that the supplied key controls the coin's output script.
 *
 * This example reads private keys from a file and keeps them in this
 * process. The file remains on disk after the payment. Use a dedicated
 * test wallet to try it. An application that keeps keys in Rust must
 * implement the full IDfSenderWallet over an authenticated local bridge:
 * coin discovery, signing, reservation/release, change, transaction lookup
 * and confirmation reconciliation. That signing bridge is not supplied.
 * The originating wallet must reserve exported coins until resolution;
 * KeyedUtxoWallet only freezes its own in-memory coin selection.
 *
 * Coin kinds: P2WPKH (BIP 84) and P2TR key path (BIP 86, pass the INTERNAL
 * key). Only one coin is spent per request.
 */

import * as fs from 'fs';
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

interface IExportedCoin {
	txid: string;
	vout: number;
	valueSat: number;
	script: string;
	height?: number;
	privateKey: string;
}

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
	const esplora = process.env.ESPLORA ?? 'http://127.0.0.1:3002';
	const coins = JSON.parse(
		fs.readFileSync(process.env.COINS ?? 'coins.json', 'utf8')
	) as IExportedCoin[];

	const wallet = new KeyedUtxoWallet({
		network,
		coins: coins.map((c) => ({
			txid: c.txid,
			vout: c.vout,
			valueSat: BigInt(c.valueSat),
			script: Buffer.from(c.script, 'hex'),
			height: c.height ?? 0,
			privateKey: Buffer.from(c.privateKey, 'hex')
		})),
		changeAddress: process.env.CHANGE ?? '',
		getTransaction: (txid): Promise<Buffer> =>
			fetchHex(`${esplora}/tx/${txid}/hex`),
		blockHeight: () => Number(process.env.TIP ?? 0)
	});

	const client = new BeignetClient({
		network,
		link: new NoisePeerLink({ network, log: consoleLog('noise-link') }),
		wallet,
		// Durable payment records: a retry after a crash replays the outcome
		// instead of offering a second coin.
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
			amountSat: info.amountSat ?? BigInt(process.env.AMOUNT_SATS ?? 0),
			maxTotalFeeSat: Number(process.env.MAX_FEE_SATS ?? 1_000)
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
