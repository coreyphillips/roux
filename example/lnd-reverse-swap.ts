/**
 * LND: move Lightning balance to LND's own on-chain wallet through a
 * beignet reverse swap, with nothing leaving LND but a payment.
 *
 *   LND_REST=127.0.0.1:8080 LND_MACAROON=<admin macaroon hex> \
 *   BEIGNET_PROVIDER=<pubkey@host:port> BITCOIN_RPC=127.0.0.1:8332 \
 *   BITCOIN_RPC_USER=u BITCOIN_RPC_PASS=p AMOUNT_SATS=100000 \
 *   NETWORK=mainnet npm run example:lnd-reverse-swap
 *
 * What happens:
 *   1. roux asks the provider for a quote, then opens the swap: it holds
 *      a fresh preimage and claim key, the provider answers with a hold
 *      invoice for sha256(preimage), its refund key and height, and the
 *      contract address. roux rebuilds the contract itself and refuses
 *      any ack whose script, invoice or amounts disagree.
 *   2. The record (terms, preimage, claim key, LND's claim address) is
 *      written to FileStorage BEFORE LND is asked to pay. Treat that file
 *      as a wallet file.
 *   3. LND pays the hold invoice; the provider funds the contract on chain.
 *   4. After one confirmation (never earlier: the claim reveals the
 *      preimage) roux claims the contract to LND's address through
 *      Bitcoin Core. The provider settles the hold from the mempool claim,
 *      and LND's payment completes with the preimage roux chose.
 *
 * RESUME=1 re-checks every unresolved swap in the file instead of opening a
 * new one (after a crash, or to keep claiming a swap that is still funding).
 */

import * as os from 'os';
import * as path from 'path';
import {
	BeignetClient,
	BitcoinCoreChain,
	FileStorage,
	LndPayer,
	LndPeerLink,
	consoleLog
} from '../src';

async function main(): Promise<void> {
	const [lndHost, lndPort] = (process.env.LND_REST ?? '127.0.0.1:8080').split(
		':'
	);
	const [rpcHost, rpcPort] = (
		process.env.BITCOIN_RPC ?? '127.0.0.1:8332'
	).split(':');
	const network =
		(process.env.NETWORK as 'mainnet' | 'regtest' | 'signet' | 'testnet') ??
		'mainnet';
	const macaroonHex = process.env.LND_MACAROON;
	const providerUri = process.env.BEIGNET_PROVIDER;
	if (!macaroonHex || !providerUri) {
		throw new Error('LND_MACAROON and BEIGNET_PROVIDER are required');
	}
	const log = consoleLog('lnd-reverse-swap');
	const lnd = {
		host: lndHost,
		port: Number(lndPort),
		macaroonHex,
		rejectUnauthorized: false,
		log
	};
	const link = new LndPeerLink(lnd);
	const payer = new LndPayer({ ...lnd, network });
	const chain = new BitcoinCoreChain({
		host: rpcHost,
		port: Number(rpcPort),
		user: process.env.BITCOIN_RPC_USER ?? '',
		pass: process.env.BITCOIN_RPC_PASS ?? '',
		wallet: process.env.BITCOIN_RPC_WALLET,
		log
	});
	const client = new BeignetClient({
		link,
		network,
		storage: new FileStorage(path.join(os.homedir(), '.roux', 'swaps.json')),
		swaps: { payer, chain },
		log
	});
	const provider = await client.connect(providerUri);

	if (process.env.RESUME === '1') {
		const report = await client.swaps.reverse.resume({ run: true });
		console.log(
			`resumed ${report.resumed.length}, awaiting payment ${report.needsPayment.length}, terminal ${report.terminal}`
		);
		for (const swap of report.resumed) console.log(await swap.run());
		await client.close();
		return;
	}

	const amountSat = BigInt(process.env.AMOUNT_SATS ?? '100000');
	const quote = await client.swaps.quote(provider.pubkeyHex, {
		direction: 'reverse',
		amountSat
	});
	console.log('quote', quote);
	if (!quote.accepted || !quote.withinPolicy)
		throw new Error(`provider declined: ${quote.reason ?? 'outside policy'}`);

	const swap = await client.swaps.reverse.create(provider.pubkeyHex, {
		amountSat
	});
	console.log(
		'swap',
		swap.swapIdHex,
		'contract',
		swap.record().htlcAddress,
		'refund height',
		swap.record().refundHeight
	);
	const final = await swap.run();
	console.log('done', final.state, 'claim', final.claim?.confirmedTxidHex);
	payer.close();
	await client.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
