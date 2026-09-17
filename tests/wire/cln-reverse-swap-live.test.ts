/**
 * The Core Lightning twin of lnd-reverse-swap-live.test.ts: ClnPeerLink
 * carries the protocol over CLN's connection, ClnPayer pays the hold
 * invoice, BitcoinCoreChain watches and claims, and the beignet provider
 * settles. Needs the `ws` package for clnrest's notification stream.
 *
 * Opt-in: REQUIRE_SWAP_LIVE=1 with the docker stack up (clnrest on 3010).
 */

import { expect } from 'chai';
import {
	BeignetClient,
	BitcoinCoreChain,
	ClnPayer,
	ClnPeerLink,
	MemoryStorage
} from '../../src';
import {
	HOST_FROM_DOCKER,
	ILiveProvider,
	REQUIRED,
	bitcoinRpc,
	dockerExec,
	mineAndTick,
	mineBlocks,
	providerSwap,
	sleep,
	startProvider,
	until
} from '../swap-live-harness';
import {
	CLN_P2P_HOST,
	CLN_P2P_PORT,
	createClnClient,
	fundClnWallet,
	isClnAvailable,
	waitForClnPeerChannelNormal,
	waitForClnSync
} from '../../node_modules/beignet/tests/lightning/interop/cln-helpers';

const CLN_REST_PORT = Number(process.env.CLN_REST_PORT ?? 3010);

describe('CLN reverse swap through roux (docker)', function () {
	this.timeout(600_000);
	let provider: ILiveProvider | null = null;
	let link: ClnPeerLink | null = null;

	before(async function () {
		this.timeout(180_000);
		if (!REQUIRED) {
			this.skip();
			return;
		}
		if (!(await isClnAvailable()))
			throw new Error('docker cln is not reachable');
		const rune = dockerExec(
			'docker exec cln lightning-cli --network=regtest createrune'
		)?.match(/"rune":\s*"([^"]+)"/)?.[1];
		if (!rune) throw new Error('could not mint a rune');
		const cln = await createClnClient();
		if (!cln) throw new Error('clnrest is not reachable');
		await waitForClnSync(cln);
		const clnPubkey = (await cln.getInfo()).id;

		provider = await startProvider('roux-swap-provider-cln');
		await fundClnWallet(cln);
		await provider.node.connectPeer(clnPubkey, CLN_P2P_HOST, CLN_P2P_PORT);
		await sleep(2_000);
		await cln.fundChannel(provider.node.getNodeId(), 1_000_000);
		await mineBlocks(6);
		await sleep(3_000);
		const channels = provider.node.getChannelManager().listChannels();
		expect(channels.length, 'provider has the CLN channel').to.be.greaterThan(
			0
		);
		provider.node.handleFundingConfirmed(channels[0].getChannelId()!);
		await waitForClnPeerChannelNormal(cln, provider.node.getNodeId());
		await provider.tick();

		link = new ClnPeerLink({
			host: '127.0.0.1',
			port: CLN_REST_PORT,
			rune,
			rejectUnauthorized: false
		});
	});

	after(async function () {
		await link?.close();
		provider?.stop();
	});

	it('pays, waits for the funding, claims to CLN, and CLN settles on our preimage', async function () {
		const p = provider!;
		const rune = (link as unknown as { options: { rune: string } }).options
			.rune;
		const payer = new ClnPayer({
			host: '127.0.0.1',
			port: CLN_REST_PORT,
			rune,
			rejectUnauthorized: false,
			network: 'regtest'
		});
		const chain = new BitcoinCoreChain({
			host: '127.0.0.1',
			port: 43782,
			user: 'polaruser',
			pass: 'polarpass',
			wallet: 'default'
		});
		const client = new BeignetClient({
			link: link!,
			network: 'regtest',
			storage: new MemoryStorage(),
			swaps: {
				payer,
				chain,
				policy: {
					statusPollMs: 2_000,
					chainPollMs: 2_000,
					minRefundDeltaBlocks: 20
				}
			}
		});
		await client.connect(`${p.node.getNodeId()}@${HOST_FROM_DOCKER}:${p.port}`);
		const swap = await client.swaps.reverse.create(p.node.getNodeId(), {
			amountSat: 80_000
		});
		const record = swap.record();
		p.chain.watch(
			Buffer.from(record.htlcOutputScriptHex, 'hex'),
			record.createdHeight
		);
		const done = swap.run();

		await until('provider funded', async () => {
			const row = providerSwap(p, record.swapIdHex);
			return row?.state === 'FUNDING_BROADCAST' || row?.state === 'FUNDED';
		});
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

		const claim = (await bitcoinRpc('getrawtransaction', [
			final.claim!.confirmedTxidHex!,
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
			(await payer.trackPayment(Buffer.from(record.paymentHashHex, 'hex')))
				.status
		).to.equal('succeeded');
		await client.close();
	});
});
