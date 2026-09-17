/**
 * A real CLN moves an on-chain coin into its own Lightning balance through
 * a beignet submarine provider, driven entirely by roux: ClnPeerLink
 * carries the swap protocol over clnrest, ClnPayer mints and looks up the
 * invoice, ClnFunder pays the contract with `withdraw`, BitcoinCoreChain
 * watches the contract, and the provider (a beignet node from source that
 * opened a channel TO CLN) pays the invoice and claims with the preimage.
 * The second case deletes CLN's unpaid invoice: the provider's HTLC fails
 * on arrival, the swap fails, and roux refunds after the height with the
 * operator's override, since CLN no longer knows the invoice.
 *
 * Opt-in: REQUIRE_SWAP_LIVE=1 with the docker stack up (bitcoind 43782,
 * clnrest on CLN_REST_PORT, default 3010). Otherwise it skips. Not to be
 * run concurrently with beignet's own CLN interop suites.
 */

import { expect } from 'chai';
import {
	BeignetClient,
	BitcoinCoreChain,
	ClnFunder,
	ClnPayer,
	ClnPeerLink,
	MemoryStorage
} from '../../src';
import {
	CLN_P2P_HOST,
	CLN_P2P_PORT,
	createClnClient,
	fundClnWallet,
	isClnAvailable,
	waitForClnPeerChannelNormal,
	waitForClnSync
} from '../../node_modules/beignet/tests/lightning/interop/cln-helpers';
import {
	HOST_FROM_DOCKER,
	ILiveProvider,
	REQUIRED,
	bitcoinRpc,
	dockerExec,
	mineAndTick,
	openProviderChannelTo,
	providerSwap,
	startProvider,
	until
} from '../swap-live-harness';

const CLN_REST_PORT = Number(process.env.CLN_REST_PORT ?? 3010);

describe('CLN submarine swap through roux (docker)', function () {
	this.timeout(900_000);
	let provider: ILiveProvider | null = null;
	let rune = '';
	let cln: Awaited<ReturnType<typeof createClnClient>> = null;

	before(async function () {
		this.timeout(240_000);
		if (!REQUIRED) {
			this.skip();
			return;
		}
		if (!(await isClnAvailable())) throw new Error('CLN is not reachable');
		const minted = dockerExec(
			'docker exec cln lightning-cli --network=regtest createrune'
		);
		const match = minted?.match(/"rune":\s*"([^"]+)"/);
		if (!match) throw new Error('could not mint a CLN rune');
		rune = match[1];
		cln = await createClnClient();
		if (!cln) throw new Error('clnrest is not reachable');
		await waitForClnSync(cln);
		await fundClnWallet(cln);
		const clnPubkey = (await cln.getInfo()).id;

		provider = await startProvider('roux-submarine-provider-cln', {
			submarine: true
		});
		await openProviderChannelTo(
			provider,
			clnPubkey,
			CLN_P2P_HOST,
			CLN_P2P_PORT,
			1_000_000n,
			() => waitForClnPeerChannelNormal(cln!, provider!.node.getNodeId())
		);
	});

	after(async function () {
		provider?.stop();
	});

	function clientFor(): { client: BeignetClient; payer: ClnPayer } {
		const rest = {
			host: '127.0.0.1',
			port: CLN_REST_PORT,
			rune,
			rejectUnauthorized: false,
			network: 'regtest' as const
		};
		const payer = new ClnPayer(rest);
		const funder = new ClnFunder(rest);
		const chain = new BitcoinCoreChain({
			host: '127.0.0.1',
			port: 43782,
			user: 'polaruser',
			pass: 'polarpass',
			wallet: 'default'
		});
		// One link per test: client.close() closes it.
		const link = new ClnPeerLink({
			host: '127.0.0.1',
			port: CLN_REST_PORT,
			rune,
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
					invoiceFinalCltvBlocks: 40
				}
			}
		});
		return { client, payer };
	}

	it('CLN invoices and withdraws to the contract, the provider pays under the ceiling and claims, CLN is paid', async function () {
		const p = provider!;
		const { client, payer } = clientFor();
		await client.connect(`${p.node.getNodeId()}@${HOST_FROM_DOCKER}:${p.port}`);
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
		const done = swap.run();
		await until(
			'CLN funded the contract',
			async () => swap.state === 'FUNDING'
		);
		await mineAndTick(p, 1);
		await until(
			'provider paid and claimed',
			async () =>
				['CLAIM_BROADCAST', 'CLAIM_CONFIRMED'].includes(row()!.state as string),
			120_000
		);
		swap.poke();
		await until('roux settled', async () => swap.state === 'SETTLED');
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
		])) as { confirmations?: number };
		expect(claim.confirmations ?? 0).to.be.at.least(2);
		await client.close();
	});

	it('CLN deletes the unpaid invoice: the provider fails, roux refunds after the height with the override', async function () {
		const p = provider!;
		const { client, payer } = clientFor();
		await client.connect(`${p.node.getNodeId()}@${HOST_FROM_DOCKER}:${p.port}`);
		const swap = await client.swaps.submarine.create(p.node.getNodeId(), {
			amountSat: 80_000
		});
		const record = swap.record();
		p.chain.watch(
			Buffer.from(record.htlcOutputScriptHex, 'hex'),
			record.createdHeight
		);
		const row = (): ReturnType<typeof providerSwap> =>
			providerSwap(p, swap.swapIdHex);
		const done = swap.run();
		await until(
			'CLN funded the contract',
			async () => swap.state === 'FUNDING'
		);
		// Funded; now delete the invoice, so the provider's HTLC fails on
		// arrival (fund() itself refuses an invoice the node does not know).
		const { invoices } = await cln!.listInvoices();
		const inv = invoices.find((i) => i.payment_hash === record.paymentHashHex);
		expect(inv, 'CLN holds the invoice').to.not.equal(undefined);
		await cln!.delInvoice(inv!.label, 'unpaid');
		expect(
			(await payer.lookupInvoice(Buffer.from(record.paymentHashHex, 'hex')))
				.state
		).to.equal('unknown');
		await mineAndTick(p, 1);
		await until(
			'provider failed the payment',
			async () => row()!.state === 'PAYMENT_FAILED',
			120_000
		);
		expect(row()!.claimTxHex).to.equal(undefined);
		let tip = await p.chain.refresh();
		while (tip < record.refundHeight) {
			tip = await mineAndTick(p, Math.min(20, record.refundHeight - tip));
		}
		swap.poke();
		await until('refund withheld for the unknown invoice', async () =>
			/does not know/.test(swap.record().refundBlockedReason ?? '')
		);
		expect(swap.state).to.equal('FUNDED');
		await swap.refund({ allowUnknownInvoice: true });
		expect(swap.state).to.equal('REFUND_BROADCAST');
		await mineAndTick(p, 1);
		swap.poke();
		const final = await done;
		expect(final.state).to.equal('REFUNDED');
		expect(row()!.state).to.equal('PAYMENT_FAILED');
		await client.close();
	});
});
