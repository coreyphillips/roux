/**
 * LND: move an on-chain coin from LND's wallet into LND's own Lightning
 * balance through a beignet submarine swap.
 *
 *   LND_REST=127.0.0.1:8080 LND_MACAROON=<admin macaroon hex> \
 *   BEIGNET_PROVIDER=<pubkey@host:port> BITCOIN_RPC=127.0.0.1:8332 \
 *   BITCOIN_RPC_USER=u BITCOIN_RPC_PASS=p AMOUNT_SATS=100000 \
 *   NETWORK=mainnet npm run example:lnd-submarine-swap
 *
 * What happens:
 *   1. roux asks the provider for a quote, has LND mint an invoice for
 *      the amount minus the fee, and opens the swap: the provider answers
 *      with its claim key, the refund height and the contract address.
 *      roux rebuilds the contract from LND's refund key and the
 *      provider's claim key and refuses any ack whose script, amounts or
 *      window disagree, or whose window cannot hold the invoice's final
 *      CLTV.
 *   2. The record (terms, refund key, LND's refund address) is written to
 *      FileStorage BEFORE anything is funded. Treat that file as a wallet
 *      file.
 *   3. LND pays the contract address from its on-chain wallet (sendcoins);
 *      the funding attempt is persisted before LND is asked.
 *   4. Once the funding has the provider's confirmations, the provider
 *      pays LND's invoice and claims the contract with the preimage.
 *      roux ends SETTLED. Unpaid past the refund height, roux refunds
 *      LND, never while LND still holds the provider's HTLC.
 *
 * RESUME=1 re-checks every unresolved swap in the file instead of opening a
 * new one (after a crash, or to keep following a swap that is still funding).
 * INVOICE=<bolt11> supplies an LND invoice of your own for exactly the quoted
 * amount instead of minting one.
 */

import * as os from 'os';
import * as path from 'path';
import {
	BeignetClient,
	BitcoinCoreChain,
	FileStorage,
	LndFunder,
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
	const log = consoleLog('lnd-submarine-swap');
	const lnd = {
		host: lndHost,
		port: Number(lndPort),
		macaroonHex,
		rejectUnauthorized: false,
		log
	};
	const link = new LndPeerLink(lnd);
	const payer = new LndPayer({ ...lnd, network });
	const funder = new LndFunder({ ...lnd, network });
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
		for (const swap of report.fundingUnknown) {
			console.log(
				`swap ${swap.swapIdHex}: a funding was requested and its reply lost; check LND's wallet, then attachFunding(txid) or fund({ force: true })`
			);
		}
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
		'invoice',
		swap.record().invoiceAmountMsat,
		'msat, refund height',
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
	payer.close();
	await client.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
