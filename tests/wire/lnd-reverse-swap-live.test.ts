/**
 * A real LND swaps Lightning balance to its own on-chain wallet through a
 * beignet provider, driven entirely by roux: LndPeerLink carries the
 * swap protocol over LND's own connection, LndPayer pays the hold invoice,
 * BitcoinCoreChain watches the contract and broadcasts the claim, and the
 * provider (a beignet node from source, funded by Core's wallet) settles
 * the hold the moment the claim hits the mempool. Asserted on both sides:
 * roux ends CLAIMED, LND's payment SUCCEEDED with our preimage, and the
 * claim output confirms to LND's address.
 *
 * Opt-in: REQUIRE_SWAP_LIVE=1 with the docker stack up (bitcoind 43782,
 * LND REST on LND_REST_PORT, default 8091 here). Otherwise it skips.
 */

import { expect } from 'chai';
import * as bitcoin from 'bitcoinjs-lib';
import {
	BeignetClient,
	BitcoinCoreChain,
	LndPayer,
	LndPeerLink,
	MemoryStorage
} from '../../src';
import {
	HOST_FROM_DOCKER,
	ILiveProvider,
	LND_P2P_HOST,
	LND_P2P_PORT,
	LND_REST_HOST,
	LND_REST_PORT,
	REQUIRED,
	bitcoinRpc,
	cleanupLnd,
	describeSwap,
	fundLndWallet,
	lndClient,
	loadLndMacaroon,
	mineAndTick,
	mineBlocks,
	providerSwap,
	sleep,
	startProvider,
	until,
	waitForLndChannels,
	waitForLndRoute,
	waitForLndSync
} from '../swap-live-harness';

describe('LND reverse swap through roux (docker)', function () {
	this.timeout(600_000);
	let provider: ILiveProvider | null = null;
	let link: LndPeerLink | null = null;
	let payer: LndPayer | null = null;

	before(async function () {
		this.timeout(180_000);
		if (!REQUIRED) {
			this.skip();
			return;
		}
		const macaroon = loadLndMacaroon();
		const lnd = await lndClient();
		if (!macaroon || !lnd) throw new Error('docker lnd is not reachable');
		await waitForLndSync(lnd);
		await cleanupLnd(lnd);
		const lndPubkey = (await lnd.getInfo()).identity_pubkey;

		// A fresh key per run: the provider keeps no database between runs,
		// and a reused key would meet LND's stale channels to its last life.
		provider = await startProvider(`roux-swap-provider-lnd-${Date.now()}`);
		await fundLndWallet(lnd, 110);
		await provider.node.connectPeer(lndPubkey, LND_P2P_HOST, LND_P2P_PORT);
		await sleep(2_000);
		await lnd.openChannelSync(provider.node.getNodeId(), 1_000_000, 0);
		await mineBlocks(6);
		await sleep(3_000);
		const channels = provider.node.getChannelManager().listChannels();
		expect(channels.length, 'provider has the LND channel').to.be.greaterThan(
			0
		);
		provider.node.handleFundingConfirmed(channels[0].getChannelId()!);
		await waitForLndChannels(lnd, 1, 30_000);
		await waitForLndRoute(macaroon, provider.node.getNodeId(), 100_600);
		await provider.tick();

		link = new LndPeerLink({
			host: LND_REST_HOST,
			port: LND_REST_PORT,
			macaroonHex: macaroon,
			rejectUnauthorized: false
		});
		payer = new LndPayer({
			host: LND_REST_HOST,
			port: LND_REST_PORT,
			macaroonHex: macaroon,
			rejectUnauthorized: false,
			network: 'regtest'
		});
	});

	after(async function () {
		payer?.close();
		await link?.close();
		provider?.stop();
	});

	it('pays, waits for the funding, claims to LND, and LND settles on our preimage', async function () {
		const p = provider!;
		const chain = new BitcoinCoreChain({
			host: '127.0.0.1',
			port: 43782,
			user: 'polaruser',
			pass: 'polarpass',
			wallet: 'default'
		});
		const clientLogs: string[] = [];
		const client = new BeignetClient({
			link: link!,
			network: 'regtest',
			storage: new MemoryStorage(),
			swaps: {
				payer: payer!,
				chain,
				policy: {
					statusPollMs: 2_000,
					chainPollMs: 2_000,
					minRefundDeltaBlocks: 20
				}
			},
			log: (action, data) =>
				clientLogs.push(
					`${action} ${JSON.stringify(data, (_k, v) =>
						typeof v === 'bigint' ? v.toString() : v
					)}`
				)
		});
		await client.connect(`${p.node.getNodeId()}@${HOST_FROM_DOCKER}:${p.port}`);
		const quote = await client.swaps.quote(p.node.getNodeId(), {
			direction: 'reverse',
			amountSat: 100_000
		});
		expect(quote.accepted).to.equal(true);
		expect(quote.withinPolicy).to.equal(true);

		const swap = await client.swaps.reverse.create(p.node.getNodeId(), {
			amountSat: 100_000
		});
		const record = swap.record();
		expect(record.state).to.equal('CREATED');
		p.chain.watch(
			Buffer.from(record.htlcOutputScriptHex, 'hex'),
			record.createdHeight
		);
		const done = swap.run();

		// The provider funds once LND's HTLC is held; one block confirms it.
		try {
			await until('provider funded', async () => {
				const row = providerSwap(p, record.swapIdHex);
				return row?.state === 'FUNDING_BROADCAST' || row?.state === 'FUNDED';
			});
		} catch (err) {
			const status = await payer!.trackPayment(
				Buffer.from(record.paymentHashHex, 'hex')
			);
			const lndNow = await lndClient();
			const channels = lndNow
				? (await lndNow.listChannels()).channels.map((c) => ({
						peer: c.remote_pubkey.slice(0, 12),
						active: c.active,
						local: c.local_balance
				  }))
				: [];
			clientLogs.push(`channels ${JSON.stringify(channels)}`);
			throw new Error(
				`${String(err)}; lnd payment ${JSON.stringify(
					status
				)}; client logs ${clientLogs.join(' | ')}; provider ${describeSwap(
					p,
					record.swapIdHex
				)}`
			);
		}
		await mineAndTick(p, 1);
		await until(
			'roux sees the funding confirmed',
			async () => swap.record().funding !== undefined && swap.state !== 'PAYING'
		);
		swap.poke();
		await until(
			'claim broadcast',
			async () => swap.state === 'CLAIM_BROADCAST' || swap.state === 'CLAIMED'
		);
		// The provider settles from the mempool claim.
		await p.tick();
		await until(
			'provider settled',
			async () => providerSwap(p, record.swapIdHex)?.state === 'SETTLED'
		);
		await mineAndTick(p, 1);
		swap.poke();
		const final = await done;
		expect(final.state).to.equal('CLAIMED');
		expect(final.payment!.status).to.equal('succeeded');
		expect(final.payment!.preimageHex).to.equal(record.preimageHex);
		expect(providerSwap(p, record.swapIdHex)!.preimageHex).to.equal(
			record.preimageHex
		);

		const claimTxid = final.claim!.confirmedTxidHex!;
		const claim = (await bitcoinRpc('getrawtransaction', [
			claimTxid,
			true
		])) as {
			confirmations?: number;
			vout: Array<{ scriptPubKey: { hex: string } }>;
		};
		expect(claim.confirmations ?? 0).to.be.at.least(1);
		expect(claim.vout[0].scriptPubKey.hex).to.equal(
			record.destinationScriptHex
		);
		expect(
			bitcoin.address.fromOutputScript(
				Buffer.from(record.destinationScriptHex, 'hex'),
				bitcoin.networks.regtest
			)
		).to.match(/^bcrt1q/);
		const status = await payer!.trackPayment(
			Buffer.from(record.paymentHashHex, 'hex')
		);
		expect(status.status).to.equal('succeeded');
		await client.close();
	});
});
