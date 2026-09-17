/**
 * A real LND moves an on-chain coin into its own Lightning balance through
 * a beignet submarine provider, driven entirely by roux: LndPeerLink
 * carries the swap protocol over LND's own connection, LndPayer mints and
 * looks up the invoice, LndFunder pays the contract from LND's wallet,
 * BitcoinCoreChain watches the contract, and the provider (a beignet node
 * from source that opened a channel TO LND, since it pays) pays the invoice
 * under its ceiling and claims with the preimage. Asserted on both sides:
 * roux ends SETTLED with LND's invoice SETTLED, the provider ends
 * CLAIM_CONFIRMED. The second case supplies an LND hold invoice: the
 * provider pays, LND parks the HTLC, roux refuses to refund while it is
 * parked, LND cancels, the provider fails the swap, roux refunds after
 * the height.
 *
 * Opt-in: REQUIRE_SWAP_LIVE=1 with the docker stack up (bitcoind 43782,
 * LND REST on LND_REST_PORT, default 8091 here). Otherwise it skips.
 */

import crypto from 'crypto';
import { expect } from 'chai';
import {
	BeignetClient,
	BitcoinCoreChain,
	LndFunder,
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
	fundLndWallet,
	lndClient,
	loadLndMacaroon,
	mineAndTick,
	openProviderChannelTo,
	providerSwap,
	startProvider,
	until,
	waitForLndChannels,
	waitForLndSync
} from '../swap-live-harness';

describe('LND submarine swap through roux (docker)', function () {
	this.timeout(900_000);
	let provider: ILiveProvider | null = null;
	let macaroonHex = '';
	let lnd: Awaited<ReturnType<typeof lndClient>> = null;

	before(async function () {
		this.timeout(240_000);
		if (!REQUIRED) {
			this.skip();
			return;
		}
		macaroonHex = loadLndMacaroon() ?? '';
		if (!macaroonHex) throw new Error('LND macaroon not readable');
		lnd = await lndClient();
		if (!lnd) throw new Error('LND is not reachable');
		await waitForLndSync(lnd);
		await cleanupLnd(lnd);
		await fundLndWallet(lnd, 10);
		const lndPubkey = (await lnd.getInfo()).identity_pubkey;

		provider = await startProvider(
			`roux-submarine-provider-lnd-${Date.now()}`,
			{ submarine: true }
		);
		await openProviderChannelTo(
			provider,
			lndPubkey,
			LND_P2P_HOST,
			LND_P2P_PORT,
			1_000_000n,
			() => waitForLndChannels(lnd!, 1, 60_000)
		);
	});

	after(async function () {
		provider?.stop();
	});

	function clientFor(): {
		client: BeignetClient;
		payer: LndPayer;
		chain: BitcoinCoreChain;
	} {
		const rest = {
			host: LND_REST_HOST,
			port: LND_REST_PORT,
			macaroonHex,
			rejectUnauthorized: false,
			network: 'regtest' as const
		};
		const payer = new LndPayer(rest);
		const funder = new LndFunder(rest);
		const chain = new BitcoinCoreChain({
			host: '127.0.0.1',
			port: 43782,
			user: 'polaruser',
			pass: 'polarpass',
			wallet: 'default'
		});
		// One link per test: client.close() closes it.
		const link = new LndPeerLink({
			host: LND_REST_HOST,
			port: LND_REST_PORT,
			macaroonHex,
			rejectUnauthorized: false
		});
		const client = new BeignetClient({
			link,
			network: 'regtest',
			storage: new MemoryStorage(),
			swaps: {
				payer,
				funder,
				chain,
				policy: {
					statusPollMs: 2_000,
					chainPollMs: 2_000,
					minRefundDeltaBlocks: 50,
					claimSafetyBlocks: 6,
					routeBudgetBlocks: 6,
					invoiceFinalCltvBlocks: 80
				}
			}
		});
		return { client, payer, chain };
	}

	it('LND invoices and funds from its wallet, the provider pays under the ceiling and claims, LND settles', async function () {
		const p = provider!;
		const { client, payer } = clientFor();
		await client.connect(`${p.node.getNodeId()}@${HOST_FROM_DOCKER}:${p.port}`);
		const quote = await client.swaps.quote(p.node.getNodeId(), {
			direction: 'submarine',
			amountSat: 100_000
		});
		expect(quote.accepted, quote.reason).to.equal(true);
		expect(quote.withinPolicy).to.equal(true);
		const swap = await client.swaps.submarine.create(p.node.getNodeId(), {
			amountSat: 100_000
		});
		const record = swap.record();
		p.chain.watch(
			Buffer.from(record.htlcOutputScriptHex, 'hex'),
			record.createdHeight
		);
		const row = (): ReturnType<typeof providerSwap> =>
			providerSwap(p, swap.swapIdHex);
		expect(row()!.state).to.equal('CREATED');
		const done = swap.run();
		await until(
			'LND funded the contract',
			async () => swap.state === 'FUNDING'
		);
		expect(swap.record().funding!.source).to.equal('funder');
		await mineAndTick(p, 1);
		await until(
			'provider paid and claimed',
			async () =>
				['CLAIM_BROADCAST', 'CLAIM_CONFIRMED'].includes(row()!.state as string),
			120_000
		);
		swap.poke();
		await until('roux settled', async () => swap.state === 'SETTLED');
		expect(swap.record().settledBy).to.equal('invoice');
		const invoice = await payer.lookupInvoice(
			Buffer.from(record.paymentHashHex, 'hex')
		);
		expect(invoice.state).to.equal('settled');
		expect(invoice.preimage!.toString('hex')).to.equal(row()!.preimageHex);
		const final = await done;
		expect(final.state).to.equal('SETTLED');
		await mineAndTick(p, 1);
		await mineAndTick(p, 1);
		await until(
			'provider claim confirmed',
			async () => row()!.state === 'CLAIM_CONFIRMED'
		);
		const claim = (await bitcoinRpc('getrawtransaction', [
			row()!.claimTxid,
			true
		])) as {
			confirmations?: number;
			vout: Array<{ scriptPubKey: { hex: string } }>;
		};
		expect(claim.confirmations ?? 0).to.be.at.least(2);
		expect(claim.vout[0].scriptPubKey.hex).to.equal(
			p.node.getSweepDestinationScript().toString('hex')
		);
		await client.close();
	});

	it('an LND hold invoice: the refund waits while the HTLC is parked, LND cancels, the provider fails, roux refunds after the height', async function () {
		const p = provider!;
		const { client, payer } = clientFor();
		await client.connect(`${p.node.getNodeId()}@${HOST_FROM_DOCKER}:${p.port}`);
		const amountSat = 80_000n;
		const quote = await client.swaps.quote(p.node.getNodeId(), {
			direction: 'submarine',
			amountSat
		});
		expect(quote.accepted, quote.reason).to.equal(true);
		// The invoice the client will supply: a hold invoice for exactly the
		// amount roux computes (quoted fee plus its 100 sat slack).
		const invoiceSat = amountSat - quote.totalFeeSat - 100n;
		const preimage = crypto.randomBytes(32);
		const hashHex = crypto.createHash('sha256').update(preimage).digest('hex');
		const hold = await lnd!.addHoldInvoice(hashHex, Number(invoiceSat));
		expect(
			(await payer.lookupInvoice(Buffer.from(hashHex, 'hex'))).state
		).to.equal('open');
		const swap = await client.swaps.submarine.create(p.node.getNodeId(), {
			amountSat,
			invoice: hold.payment_request
		});
		const record = swap.record();
		expect(record.invoiceSource).to.equal('supplied');
		p.chain.watch(
			Buffer.from(record.htlcOutputScriptHex, 'hex'),
			record.createdHeight
		);
		const row = (): ReturnType<typeof providerSwap> =>
			providerSwap(p, swap.swapIdHex);
		const done = swap.run();
		await until(
			'LND funded the contract',
			async () => swap.state === 'FUNDING'
		);
		await mineAndTick(p, 1);
		// The provider pays; LND parks the HTLC.
		await until(
			'provider paying',
			async () =>
				['PAYING', 'PAYMENT_UNRESOLVED'].includes(row()!.state as string),
			120_000
		);
		await until(
			'LND parked the HTLC',
			async () =>
				(await payer.lookupInvoice(Buffer.from(hashHex, 'hex'))).state ===
				'accepted'
		);
		// With the HTLC parked, roux sees the invoice accepted. A refund
		// is not due yet (the height), and past the provider's ceiling LND
		// itself fails the HTLC back before the refund height arrives, so a
		// parked HTLC at the refund height cannot occur by construction; the
		// gate itself is exercised by the unit suite.
		await swap.tick();
		expect(swap.record().invoice?.state).to.equal('accepted');
		expect(swap.state).to.equal('FUNDED');
		await swap.refund().then(
			() => expect.fail('a refund before the height must be refused'),
			(err: { code?: string }) => expect(err.code).to.equal('deadline')
		);
		expect(swap.record().refund).to.equal(undefined);
		// LND cancels: the HTLC fails back, the provider fails the swap,
		// roux refunds.
		await lnd!.cancelHoldInvoice(hashHex);
		await until(
			'provider failed the payment',
			async () => row()!.state === 'PAYMENT_FAILED',
			120_000
		);
		expect(row()!.claimTxHex).to.equal(undefined);
		expect(
			(await payer.lookupInvoice(Buffer.from(hashHex, 'hex'))).state
		).to.equal('cancelled');
		let tip = await p.chain.refresh();
		while (tip < record.refundHeight) {
			tip = await mineAndTick(p, Math.min(20, record.refundHeight - tip));
		}
		swap.poke();
		await until(
			'refund broadcast',
			async () => swap.state === 'REFUND_BROADCAST'
		);
		await mineAndTick(p, 1);
		swap.poke();
		const final = await done;
		expect(final.state).to.equal('REFUNDED');
		const refund = (await bitcoinRpc('getrawtransaction', [
			final.refund!.confirmedTxidHex,
			true
		])) as {
			confirmations?: number;
			vout: Array<{ scriptPubKey: { hex: string } }>;
		};
		expect(refund.confirmations ?? 0).to.be.at.least(1);
		expect(refund.vout[0].scriptPubKey.hex).to.equal(
			final.refundDestinationScriptHex
		);
		expect(row()!.state).to.equal('PAYMENT_FAILED');
		await client.close();
	});
});
