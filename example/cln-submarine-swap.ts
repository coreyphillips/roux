/**
 * CLN: move an on-chain coin from CLN's wallet into CLN's own Lightning
 * balance through a beignet submarine swap. The CLN twin of
 * lnd-submarine-swap.ts; see that file for what happens.
 *
 *   CLN_REST=127.0.0.1:3010 CLN_RUNE=<rune> BEIGNET_PROVIDER=<pubkey@host:port> \
 *   BITCOIN_RPC=127.0.0.1:8332 BITCOIN_RPC_USER=u BITCOIN_RPC_PASS=p \
 *   AMOUNT_SATS=100000 NETWORK=mainnet npm run example:cln-submarine-swap
 *
 * The rune needs getinfo, listpeers, connect, sendcustommsg, invoice,
 * listinvoices, listpeerchannels, withdraw, listtransactions and newaddr.
 * RESUME=1 and INVOICE=<bolt11> work as in the LND example.
 */

import * as os from 'os';
import * as path from 'path';
import {
	BeignetClient,
	BitcoinCoreChain,
	ClnFunder,
	ClnPayer,
	ClnPeerLink,
	FileStorage,
	consoleLog
} from '../src';

async function main(): Promise<void> {
	const [clnHost, clnPort] = (process.env.CLN_REST ?? '127.0.0.1:3010').split(
		':'
	);
	const [rpcHost, rpcPort] = (
		process.env.BITCOIN_RPC ?? '127.0.0.1:8332'
	).split(':');
	const network =
		(process.env.NETWORK as 'mainnet' | 'regtest' | 'signet' | 'testnet') ??
		'mainnet';
	const rune = process.env.CLN_RUNE;
	const providerUri = process.env.BEIGNET_PROVIDER;
	if (!rune || !providerUri) {
		throw new Error('CLN_RUNE and BEIGNET_PROVIDER are required');
	}
	const log = consoleLog('cln-submarine-swap');
	const cln = {
		host: clnHost,
		port: Number(clnPort),
		rune,
		rejectUnauthorized: false,
		log
	};
	const link = new ClnPeerLink(cln);
	const payer = new ClnPayer({ ...cln, network });
	const funder = new ClnFunder({ ...cln, network });
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
		swaps: { payer, funder, chain },
		log
	});
	const provider = await client.connect(providerUri);

	if (process.env.RESUME === '1') {
		const report = await client.swaps.submarine.resume({ run: true });
		console.log(
			`resumed ${report.resumed.length}, awaiting funding ${report.needsFunding.length}, funding unknown ${report.fundingUnknown.length}, terminal ${report.terminal}`
		);
		for (const swap of report.resumed)
			console.log(await swap.run({ fund: false }));
		await client.close();
		return;
	}

	const amountSat = BigInt(process.env.AMOUNT_SATS ?? '100000');
	const quote = await client.swaps.quote(provider.pubkeyHex, {
		direction: 'submarine',
		amountSat
	});
	console.log('quote', quote);
	if (!quote.accepted || !quote.withinPolicy)
		throw new Error(`provider declined: ${quote.reason ?? 'outside policy'}`);

	const swap = await client.swaps.submarine.create(provider.pubkeyHex, {
		amountSat,
		invoice: process.env.INVOICE
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
	console.log(
		'done',
		final.state,
		final.state === 'SETTLED'
			? `preimage ${final.invoice?.preimageHex}`
			: `refund ${final.refund?.confirmedTxidHex ?? 'pending'}`
	);
	await client.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
