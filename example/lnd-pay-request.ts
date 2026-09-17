/**
 * LND: pay a beignet wallet's direct-funding request from LND's own
 * on-chain wallet, with no key leaving LND.
 *
 *   LND_REST=127.0.0.1:8080 LND_MACAROON=<admin macaroon hex> \
 *   REQUEST='bitcoin:bc1...?bgnq=...' NETWORK=mainnet npm run example:lnd-pay
 *
 * What happens:
 *   1. roux snapshots LND's confirmed coins, their keys and derivation
 *      paths (ListUnspent, ListAddresses), and leases the one it offers so
 *      LND's own coin selection cannot take it (LeaseOutput).
 *   2. It dials the receiver (or the receiver's LSP relay) with a fresh
 *      ephemeral identity and makes the offer. The ownership proof is LND's
 *      SignMessageWithAddr over the offer statement, which the receiver
 *      verifies as a Bitcoin signed message (beignet PR #735; a receiver on
 *      an older beignet declines the offer, nothing is spent).
 *   3. The receiver negotiates the channel funding transaction with its LSP
 *      and attests the funding output with its node key. roux verifies
 *      the attestation, the change back to LND, and the fee ceiling, then
 *      has LND sign the one input through SignPsbt (P2WPKH and P2TR both).
 *   4. The receiver broadcasts and returns the receipt preimage.
 *
 * Needs a macaroon with onchain:read/write, address:read/write,
 * message:write and info:read (the admin macaroon has them all).
 */

import * as os from 'os';
import * as path from 'path';
import {
	BeignetClient,
	FileStorage,
	LndWallet,
	NoisePeerLink,
	consoleLog
} from '../src';

async function main(): Promise<void> {
	const [host, port] = (process.env.LND_REST ?? '127.0.0.1:8080').split(':');
	const network =
		(process.env.NETWORK as 'mainnet' | 'regtest' | 'signet' | 'testnet') ??
		'regtest';
	const wallet = new LndWallet({
		host,
		port: Number(port),
		macaroonHex: process.env.LND_MACAROON ?? '',
		https: process.env.LND_TLS !== 'false',
		rejectUnauthorized: false,
		network,
		log: consoleLog('lnd-wallet')
	});
	const client = new BeignetClient({
		network,
		link: new NoisePeerLink({ network, log: consoleLog('noise-link') }),
		wallet,
		// Durable payment records: a retry after a crash replays the outcome
		// rather than offering a second coin.
		storage: new FileStorage(
			path.join(os.homedir(), '.roux', 'lnd-payments.json')
		),
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
		await wallet.refresh();
		console.log(
			'LND coins offered',
			wallet
				.listSpendable()
				.map((c) => `${c.txidHex}:${c.vout} ${c.valueSat} sat`)
		);
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
