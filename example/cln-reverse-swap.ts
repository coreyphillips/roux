/**
 * Core Lightning: move Lightning balance to CLN's own on-chain wallet
 * through a beignet reverse swap. See lnd-reverse-swap.ts for the flow;
 * here ClnPeerLink carries the protocol over CLN's connection (needs the
 * `ws` package for clnrest's notifications) and ClnPayer pays through
 * clnrest's `pay`, which blocks until the swap resolves.
 *
 *   CLN_REST=127.0.0.1:3010 CLN_RUNE=<rune> BEIGNET_PROVIDER=<pubkey@host:port> \
 *   BITCOIN_RPC=127.0.0.1:8332 BITCOIN_RPC_USER=u BITCOIN_RPC_PASS=p \
 *   AMOUNT_SATS=100000 NETWORK=mainnet npm run example:cln-reverse-swap
 *
 * The rune needs getinfo, listpeers, connect, sendcustommsg, pay, listpays
 * and newaddr.
 */

import * as os from 'os';
import * as path from 'path';
import {
	BeignetClient,
	BitcoinCoreChain,
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
	if (!rune || !providerUri)
		throw new Error('CLN_RUNE and BEIGNET_PROVIDER are required');
	const log = consoleLog('cln-reverse-swap');
	const cln = {
		host: clnHost,
		port: Number(clnPort),
		rune,
		rejectUnauthorized: false,
		log
	};
	const client = new BeignetClient({
		link: new ClnPeerLink(cln),
		network,
		storage: new FileStorage(path.join(os.homedir(), '.roux', 'swaps.json')),
		swaps: {
			payer: new ClnPayer({ ...cln, network }),
			chain: new BitcoinCoreChain({
				host: rpcHost,
				port: Number(rpcPort),
				user: process.env.BITCOIN_RPC_USER ?? '',
				pass: process.env.BITCOIN_RPC_PASS ?? '',
				wallet: process.env.BITCOIN_RPC_WALLET,
				log
			})
		},
		log
	});
	const provider = await client.connect(providerUri);
	if (process.env.RESUME === '1') {
		const report = await client.swaps.reverse.resume({ run: true });
		for (const swap of report.resumed) console.log(await swap.run());
		await client.close();
		return;
	}
	const amountSat = BigInt(process.env.AMOUNT_SATS ?? '100000');
	const quote = await client.swaps.quote(provider.pubkeyHex, {
		direction: 'reverse',
		amountSat
	});
	if (!quote.accepted || !quote.withinPolicy)
		throw new Error(`provider declined: ${quote.reason ?? 'outside policy'}`);
	const swap = await client.swaps.reverse.create(provider.pubkeyHex, {
		amountSat
	});
	console.log('swap', swap.swapIdHex, 'contract', swap.record().htlcAddress);
	console.log('done', await swap.run());
	await client.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
