/**
 * Reverse swap client against the fake provider: quote and create through
 * beignet's real codecs, every ack the client must reject (nothing stored,
 * nothing paid), the record persisted BEFORE the payer is asked, duplicate
 * hashes, and the not-configured refusal.
 */

import { expect } from 'chai';
import crypto from 'crypto';
import { swaps } from 'beignet/lightning';
import { BeignetClient, MemoryStorage, SwapClient, SwapError } from '../../src';
import { REVERSE_SWAP_STORAGE_KEY } from '../../src/swaps/store';
import { FakeProvider, IFakeProviderKnobs } from '../swaps/fake-provider';
import { linkPair } from '../swaps/fake-link';
import { MockChain } from '../swaps/mock-chain';
import { FakePayer } from '../swaps/fake-payer';

interface IScene {
	client: SwapClient;
	provider: FakeProvider;
	chain: MockChain;
	payer: FakePayer;
	storage: MemoryStorage;
	logs: Array<{ action: string; data: Record<string, unknown> }>;
}

function scene(
	knobs: IFakeProviderKnobs = {},
	policy: Record<string, unknown> = {}
): IScene {
	const { client: clientLink, provider: providerLink } = linkPair();
	const provider = new FakeProvider(providerLink);
	provider.knobs = knobs;
	const chain = new MockChain();
	const storage = new MemoryStorage();
	const payer = new FakePayer(storage);
	const logs: IScene['logs'] = [];
	const client = new SwapClient({
		link: clientLink,
		network: 'regtest',
		payer,
		chain,
		storage,
		policy: { statusPollMs: 0, chainPollMs: 5, replyTimeoutMs: 500, ...policy },
		log: (action, data) => logs.push({ action, data })
	});
	return { client, provider, chain, payer, storage, logs };
}

describe('SwapClient quote and create', function () {
	it('quotes limits and fees through the real codecs', async function () {
		const s = scene();
		const limits = await s.client.quote(s.provider.id, {
			direction: 'reverse'
		});
		expect(limits.accepted).to.equal(true);
		expect(limits.minSwapSat).to.equal(10_000n);
		expect(limits.totalFeeSat).to.equal(0n);
		const q = await s.client.quote(s.provider.id, {
			direction: 'reverse',
			amountSat: 100_000
		});
		expect(q.totalFeeSat).to.equal(
			swaps.reverseSwapFee(100_000n, {
				flatFeeSat: 100n,
				feePpm: 1_000,
				minerFeeSat: 400n
			})
		);
		expect(q.invoiceAmountMsat).to.equal((100_000n + q.totalFeeSat) * 1000n);
		expect(q.withinPolicy).to.equal(true);
		const declined = scene({
			refuse: swaps.SwapRefusalReason.AMOUNT_ABOVE_MAX
		});
		const d = await declined.client.quote(declined.provider.id, {
			direction: 'reverse',
			amountSat: 5
		});
		expect(d.accepted).to.equal(false);
		expect(d.reason).to.match(/AMOUNT_ABOVE_MAX/);
		const short = scene({ refundDelta: 10 });
		expect(
			(
				await short.client.quote(short.provider.id, {
					direction: 'reverse',
					amountSat: 100_000
				})
			).withinPolicy
		).to.equal(false);
	});

	it('times out on a silent provider without storing anything', async function () {
		const s = scene({ silent: true });
		let failed: unknown;
		try {
			await s.client.reverse.create(s.provider.id, { amountSat: 100_000 });
		} catch (err) {
			failed = err;
		}
		expect(String(failed)).to.match(/did not answer/);
		expect(s.client.reverse.list()).to.have.length(0);
	});

	it('creates a swap: verified terms, record persisted CREATED, nothing paid', async function () {
		const s = scene();
		const swap = await s.client.reverse.create(s.provider.id, {
			amountSat: 100_000
		});
		const r = swap.record();
		expect(r.state).to.equal('CREATED');
		expect(r.refundHeight).to.equal(1144);
		expect(r.onchainAmountSat).to.equal('100000');
		expect(r.htlcAddress).to.equal(s.provider.swaps.get(r.swapIdHex)!.address);
		expect(r.destinationScriptHex).to.equal(
			s.payer.destination.toString('hex')
		);
		expect(r.claimPrivkeyHex).to.have.length(64);
		expect(
			crypto
				.createHash('sha256')
				.update(Buffer.from(r.preimageHex!, 'hex'))
				.digest()
				.toString('hex')
		).to.equal(r.paymentHashHex);
		expect(s.payer.calls).to.have.length(0);
		expect(s.storage.loadWalletData(REVERSE_SWAP_STORAGE_KEY)).to.include(
			r.swapIdHex
		);
		expect(s.logs.map((l) => l.action)).to.include('swap_created');
		expect(s.client.reverse.get(r.swapIdHex)!.swapIdHex).to.equal(r.swapIdHex);
	});

	it('persists PAYING before the payer is asked, and the fee ceiling follows policy', async function () {
		const s = scene();
		const swap = await s.client.reverse.create(s.provider.id, {
			amountSat: 100_000
		});
		const paying = swap.pay();
		expect(s.payer.calls).to.have.length(1);
		expect(s.payer.calls[0].storedStateAtCall).to.equal('PAYING');
		// 1% of the invoice, with the floor.
		expect(s.payer.calls[0].maxFeeSat).to.equal(
			BigInt(swap.record().invoiceAmountMsat) / 1000n / 100n
		);
		expect(swap.pay()).to.equal(paying);
		s.payer.settle(
			swap.record().paymentHashHex,
			Buffer.from(swap.record().preimageHex!, 'hex')
		);
		const status = await paying;
		expect(status.status).to.equal('succeeded');
		expect(swap.record().payment!.status).to.equal('succeeded');
	});

	it('a failed pay call is not a failed payment: the node is asked on the next tick', async function () {
		const s = scene();
		const swap = await s.client.reverse.create(s.provider.id, {
			amountSat: 100_000
		});
		s.payer.rejectPay = true;
		const status = await swap.pay();
		expect(status.status).to.equal('unknown');
		expect(swap.record().state).to.equal('PAYING');
		expect(swap.record().payment!.status).to.equal('pending');
	});

	it('refuses a second swap for the same preimage', async function () {
		const s = scene();
		const preimage = crypto.randomBytes(32);
		await s.client.reverse.create(s.provider.id, {
			amountSat: 100_000,
			preimage
		});
		let failed: unknown;
		try {
			await s.client.reverse.create(s.provider.id, {
				amountSat: 100_000,
				preimage
			});
		} catch (err) {
			failed = err;
		}
		expect((failed as SwapError).code).to.equal('state');
	});

	it('refuses to create without a payer and a chain, but quotes', async function () {
		const { client: clientLink, provider: providerLink } = linkPair();
		const provider = new FakeProvider(providerLink);
		const bc = new BeignetClient({ link: clientLink, network: 'regtest' });
		const q = await bc.swaps.quote(provider.id, {
			direction: 'reverse',
			amountSat: 100_000
		});
		expect(q.accepted).to.equal(true);
		let failed: unknown;
		try {
			await bc.swaps.reverse.create(provider.id, { amountSat: 100_000 });
		} catch (err) {
			failed = err;
		}
		expect((failed as SwapError).code).to.equal('not_configured');
		expect(String(failed)).to.match(/payer/).and.match(/chain/);
	});

	it('rejects a policy without a confirmation floor', function () {
		const { client: clientLink } = linkPair();
		expect(
			() =>
				new SwapClient({
					link: clientLink,
					network: 'regtest',
					policy: { minFundingConfirmations: 0 }
				})
		).to.throw(/reveals the preimage/);
	});

	describe('ack verification', function () {
		const cases: Array<
			[string, IFakeProviderKnobs, Record<string, unknown>, string, RegExp]
		> = [
			[
				'declined',
				{ refuse: swaps.SwapRefusalReason.EXPOSURE_EXCEEDED },
				{},
				'provider_declined',
				/EXPOSURE_EXCEEDED/
			],
			[
				'refund too soon',
				{ refundDelta: 20 },
				{},
				'refund_too_soon',
				/too soon|blocks away/
			],
			[
				'refund too late',
				{ refundDelta: 5000 },
				{},
				'refund_too_late',
				/maximum/
			],
			[
				'refund key equals claim key',
				{ refundKeyEqualsClaimKey: true },
				{},
				'ack_mismatch',
				/claim key/
			],
			[
				'fee above the ceiling',
				{ flatFeeSat: 10_000n },
				{},
				'provider_declined',
				/FEE_CEILING/
			],
			[
				'fee overstated against its own invoice',
				{ overstateFee: true },
				{},
				'ack_mismatch',
				/amount plus fee/
			],
			[
				'wrong output script',
				{ wrongScript: true },
				{},
				'ack_mismatch',
				/output script/
			],
			[
				'invoice on another network',
				{ foreignNetwork: true },
				{},
				'ack_mismatch',
				/another network/
			],
			[
				'invoice with another hash',
				{ wrongInvoiceHash: true },
				{},
				'ack_mismatch',
				/payment hash/
			],
			[
				'invoice amount differs',
				{ wrongInvoiceAmount: true },
				{},
				'ack_mismatch',
				/amount/
			]
		];
		for (const [label, knobs, policy, code, pattern] of cases) {
			it(`rejects ${label} and stores nothing`, async function () {
				const s = scene(knobs, policy);
				let failed: unknown;
				try {
					await s.client.reverse.create(s.provider.id, { amountSat: 100_000 });
				} catch (err) {
					failed = err;
				}
				expect(failed, label).to.be.instanceOf(SwapError);
				expect((failed as SwapError).code, label).to.equal(code);
				expect(String(failed), label).to.match(pattern);
				expect(s.client.reverse.list(), label).to.have.length(0);
				expect(s.payer.calls, label).to.have.length(0);
				expect(
					s.logs.some((l) => l.action === 'swap_ack_rejected'),
					label
				).to.equal(true);
			});
		}
	});
});
