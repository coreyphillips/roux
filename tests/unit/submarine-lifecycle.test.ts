/**
 * The submarine swap after creation: the funding discovered and verified,
 * FUNDING to FUNDED at the provider's depth, the settle (by invoice, or by
 * the provider's claim seen first on chain), the refund persisted before
 * broadcast and never while the invoice holds an HTLC or the node cannot
 * be asked, the refund bump, the races with a late-paying provider, the
 * window closing, and resume() at every persisted state.
 */

import { expect } from 'chai';
import * as bitcoin from 'bitcoinjs-lib';
import { MemoryStorage, SubmarineSwap, SwapClient } from '../../src';
import { SUBMARINE_SWAP_STORAGE_KEY } from '../../src/swaps/store';
import { ISubmarineSwapRecord, SwapError } from '../../src/swaps/types';
import { FakeProvider, IFakeProviderKnobs } from '../swaps/fake-provider';
import { linkPair } from '../swaps/fake-link';
import { MockChain } from '../swaps/mock-chain';
import { FakePayer } from '../swaps/fake-payer';
import { FakeFunder } from '../swaps/fake-funder';

interface IScene {
	client: SwapClient;
	provider: FakeProvider;
	chain: MockChain;
	payer: FakePayer;
	funder: FakeFunder;
	storage: MemoryStorage;
	logs: string[];
	reopen(): SwapClient;
}

function scene(
	policy: Record<string, unknown> = {},
	knobs: IFakeProviderKnobs = {}
): IScene {
	const { client: clientLink, provider: providerLink } = linkPair();
	const provider = new FakeProvider(providerLink);
	provider.knobs = knobs;
	const chain = new MockChain();
	const storage = new MemoryStorage();
	const payer = new FakePayer(storage);
	const funder = new FakeFunder(chain, storage);
	const logs: string[] = [];
	const make = (): SwapClient =>
		new SwapClient({
			link: clientLink,
			network: 'regtest',
			payer,
			funder,
			chain,
			storage,
			policy: {
				statusPollMs: 0,
				chainPollMs: 5,
				replyTimeoutMs: 500,
				minRefundDeltaBlocks: 30,
				claimSafetyBlocks: 6,
				routeBudgetBlocks: 6,
				invoiceFinalCltvBlocks: 40,
				bumpAfterBlocks: 2,
				...policy
			},
			log: (action) => logs.push(action)
		});
	return {
		client: make(),
		provider,
		chain,
		payer,
		funder,
		storage,
		logs,
		reopen: make
	};
}

const AMOUNT = 100_000;

/** Create and fund through the funder (mempool); FUNDING. */
async function funded(s: IScene): Promise<SubmarineSwap> {
	const swap = await s.client.submarine.create(s.provider.id, {
		amountSat: AMOUNT
	});
	await swap.fund();
	expect(swap.state).to.equal('FUNDING');
	return swap;
}

/** Create, fund, confirm: FUNDED. */
async function confirmed(s: IScene): Promise<SubmarineSwap> {
	const swap = await funded(s);
	s.chain.mine(1);
	await swap.tick();
	expect(swap.state).to.equal('FUNDED');
	return swap;
}

function stored(s: IScene, swapIdHex: string): ISubmarineSwapRecord {
	const doc = JSON.parse(
		s.storage.loadWalletData(SUBMARINE_SWAP_STORAGE_KEY)!
	) as { swaps: Record<string, ISubmarineSwapRecord> };
	return doc.swaps[swapIdHex];
}

async function failure(p: Promise<unknown>): Promise<SwapError> {
	try {
		await p;
	} catch (err) {
		if (err instanceof SwapError) return err;
		throw err;
	}
	throw new Error('expected a SwapError');
}

function mineTo(s: IScene, height: number): void {
	if (height > s.chain.height) s.chain.mine(height - s.chain.height);
}

describe('SubmarineSwap lifecycle', function () {
	it('discovers a manual funding by script scan, rejects a wrong or short one, and reaches FUNDED at the provider depth', async function () {
		const s = scene({}, { fundingConfirmations: 2 });
		const swap = await s.client.submarine.create(s.provider.id, {
			amountSat: AMOUNT
		});
		const rec = swap.record();
		expect(rec.providerFundingConfirmations).to.equal(2);
		// Wrong script, then short: neither counts.
		const wrongScript = Buffer.concat([
			Buffer.from('0020', 'hex'),
			Buffer.alloc(32, 9)
		]);
		const wrongAddress = bitcoin.address.fromOutputScript(
			wrongScript,
			bitcoin.networks.regtest
		);
		await s.funder.fund(wrongAddress, 100_000n, { label: 'wrong' });
		s.funder.shortValue = true;
		await s.funder.fund(rec.htlcAddress, 100_000n, { label: 'short' });
		s.funder.shortValue = false;
		await swap.tick();
		expect(swap.state).to.equal('CREATED');
		expect(swap.record().funding).to.equal(undefined);
		expect(s.logs).to.include('swap_funding_rejected');
		// The real one, found by the script scan: FUNDING, then FUNDED at 2.
		const good = await s.funder.fund(rec.htlcAddress, 100_000n, {
			label: 'by-hand'
		});
		await swap.tick();
		expect(swap.state).to.equal('FUNDING');
		expect(swap.record().funding!.txidHex).to.equal(good.txidHex);
		expect(swap.record().funding!.source).to.equal('discovered');
		s.chain.mine(1);
		await swap.tick();
		expect(swap.state).to.equal('FUNDING');
		s.chain.mine(1);
		await swap.tick();
		expect(swap.state).to.equal('FUNDED');
		expect(s.logs).to.include('swap_funded');
		// A reorg below the depth demotes; a vanished funding returns to CREATED
		// with the attempt untouched (none here: funded by hand).
		s.chain.evict(good.txidHex);
		await swap.tick();
		expect(swap.state).to.equal('CREATED');
		expect(swap.record().funding).to.equal(undefined);
		expect(s.logs).to.include('swap_funding_reorged');
	});

	it('settles when the provider pays the invoice: SETTLED, no refund bytes ever', async function () {
		const s = scene();
		const changes: string[] = [];
		s.client.submarine.onChange((c) => changes.push(`${c.from}>${c.to}`));
		const swap = await confirmed(s);
		expect(swap.record().invoice?.state).to.equal('open');
		s.provider.pay(s.payer, swap.swapIdHex);
		await swap.tick();
		const rec = swap.record();
		expect(rec.state).to.equal('SETTLED');
		expect(rec.settledBy).to.equal('invoice');
		expect(rec.invoice!.state).to.equal('settled');
		expect(rec.invoice!.preimageHex).to.have.length(64);
		expect(rec.refund).to.equal(undefined);
		expect(s.chain.broadcasts).to.have.length(0);
		expect(changes).to.deep.equal([
			'CREATED>FUNDING',
			'FUNDING>FUNDED',
			'FUNDED>SETTLED'
		]);
		expect(s.logs).to.include('swap_settled');
		// A settled swap is left alone by every later pass and by refund().
		mineTo(s, rec.refundHeight + 5);
		await swap.tick();
		expect(swap.state).to.equal('SETTLED');
		expect((await failure(swap.refund())).code).to.equal('state');
	});

	it('settles on the claim seen on chain even when the node lags, with the preimage extracted', async function () {
		const s = scene();
		const swap = await confirmed(s);
		const preimage = s.provider.pay(s.payer, swap.swapIdHex);
		// The node is slow to show the settle: keep it "open" for the tick.
		const hash = swap.record().paymentHashHex;
		s.payer.invoices.get(hash)!.state = 'open';
		const claimTxid = s.provider.claim(s.chain, swap.swapIdHex, s.chain.height);
		await swap.tick();
		const rec = swap.record();
		expect(rec.state).to.equal('SETTLED');
		expect(rec.settledBy).to.equal('chain');
		expect(rec.resolution).to.deep.equal({ kind: 'claim', txidHex: claimTxid });
		expect(rec.invoice!.preimageHex).to.equal(preimage.toString('hex'));
		expect(s.logs).to.include('swap_preimage_on_chain_invoice_unpaid');
	});

	it('refunds at the refund height: nothing before it, the attempt persisted before broadcast, REFUNDED at depth', async function () {
		const s = scene();
		const swap = await confirmed(s);
		const rec0 = swap.record();
		mineTo(s, rec0.refundHeight - 1);
		await swap.tick();
		expect(swap.state).to.equal('FUNDED');
		expect(s.chain.broadcasts).to.have.length(0);
		// The refund height: persisted first, then broadcast (which fails once).
		s.chain.mine(1);
		s.chain.failNextBroadcasts = 1;
		await swap.tick();
		let rec = swap.record();
		expect(rec.state).to.equal('REFUND_BROADCAST');
		expect(rec.refund!.attempts).to.have.length(1);
		expect(rec.refund!.attempts[0].broadcastAt).to.equal(undefined);
		expect(rec.lastError).to.match(/broadcast refused/);
		expect(stored(s, swap.swapIdHex).refund!.attempts[0].rawHex).to.equal(
			rec.refund!.attempts[0].rawHex
		);
		expect(s.chain.broadcasts).to.have.length(0);
		const tx = bitcoin.Transaction.fromHex(rec.refund!.attempts[0].rawHex!);
		expect(tx.locktime).to.equal(rec0.refundHeight);
		expect(tx.ins[0].witness).to.have.length(3);
		expect(tx.outs[0].script.toString('hex')).to.equal(
			rec0.refundDestinationScriptHex
		);
		expect(Number(rec.refund!.attempts[0].feeSat)).to.be.at.most(10_000);
		// Re-sent on the next pass, confirmed on the next block.
		await swap.tick();
		rec = swap.record();
		expect(s.chain.broadcasts).to.deep.equal([rec.refund!.attempts[0].txidHex]);
		expect(rec.refund!.attempts[0].broadcastAt).to.be.a('number');
		s.chain.mine(1);
		await swap.tick();
		rec = swap.record();
		expect(rec.state).to.equal('REFUNDED');
		expect(rec.resolution).to.deep.equal({
			kind: 'refund',
			txidHex: rec.refund!.attempts[0].txidHex
		});
		expect(s.logs).to.include('swap_refunded');
	});

	it('never refunds while the invoice holds an HTLC; refunds once released; settles if it settles', async function () {
		const s = scene();
		const swap = await confirmed(s);
		const rec0 = swap.record();
		s.provider.acceptOnly(s.payer, swap.swapIdHex);
		mineTo(s, rec0.refundHeight + 3);
		await swap.tick();
		expect(swap.state).to.equal('FUNDED');
		expect(swap.record().refundBlockedReason).to.match(/HTLC is in flight/);
		expect(swap.record().invoice!.acceptedSeenAt).to.be.a('number');
		expect(s.chain.broadcasts).to.have.length(0);
		expect(s.logs).to.include('swap_refund_blocked');
		const err = await failure(swap.refund());
		expect(err.code).to.equal('refund_blocked');
		expect(swap.record().refund).to.equal(undefined);
		// Released: the next pass refunds.
		s.payer.releaseInvoice(rec0.paymentHashHex);
		await swap.tick();
		expect(swap.state).to.equal('REFUND_BROADCAST');
		expect(swap.record().refundBlockedReason).to.equal(undefined);

		// The other outcome: it settles while parked.
		const t = scene();
		const held = await confirmed(t);
		t.provider.acceptOnly(t.payer, held.swapIdHex);
		mineTo(t, held.record().refundHeight + 1);
		await held.tick();
		expect(held.state).to.equal('FUNDED');
		t.provider.pay(t.payer, held.swapIdHex);
		await held.tick();
		expect(held.state).to.equal('SETTLED');
		expect(t.chain.broadcasts).to.have.length(0);
	});

	it('blocks the refund when the node cannot be asked (fail closed) and on an unknown invoice unless overridden', async function () {
		const s = scene();
		const swap = await confirmed(s);
		const rec0 = swap.record();
		mineTo(s, rec0.refundHeight + 1);
		s.payer.lookupThrows = true;
		await swap.tick();
		expect(swap.state).to.equal('FUNDED');
		expect(s.chain.broadcasts).to.have.length(0);
		expect((await failure(swap.refund())).code).to.equal('refund_blocked');
		expect(swap.record().refundBlockedReason).to.match(/lookup failed/);
		s.payer.lookupThrows = false;
		// The node forgot the invoice: blocked by the loop, refundable by hand.
		s.payer.forgetInvoice(rec0.paymentHashHex);
		await swap.tick();
		expect(swap.state).to.equal('FUNDED');
		expect(swap.record().refundBlockedReason).to.match(/does not know/);
		await swap.refund({ allowUnknownInvoice: true });
		expect(swap.state).to.equal('REFUND_BROADCAST');
	});

	it('judges last: an invoice accepted or settled during the fee estimate stops the refund', async function () {
		const s = scene();
		const swap = await confirmed(s);
		const rec0 = swap.record();
		mineTo(s, rec0.refundHeight + 1);
		let armed = true;
		s.chain.feeGate = async (): Promise<void> => {
			if (armed) {
				armed = false;
				s.provider.acceptOnly(s.payer, swap.swapIdHex);
			}
		};
		await swap.tick();
		expect(swap.state).to.equal('FUNDED');
		expect(swap.record().refund).to.equal(undefined);
		expect(s.chain.broadcasts).to.have.length(0);
		// Settled during the wait: SETTLED, no attempt.
		s.payer.releaseInvoice(rec0.paymentHashHex);
		let settleArmed = true;
		s.chain.feeGate = async (): Promise<void> => {
			if (settleArmed) {
				settleArmed = false;
				s.provider.pay(s.payer, swap.swapIdHex);
			}
		};
		await swap.tick();
		expect(swap.state).to.equal('SETTLED');
		expect(swap.record().refund).to.equal(undefined);
	});

	it('a provider paying and claiming after our refund went out: SETTLED either way, logged as the provider racing', async function () {
		// The claim confirms first.
		const s = scene();
		const swap = await confirmed(s);
		mineTo(s, swap.record().refundHeight + 1);
		await swap.tick();
		expect(swap.state).to.equal('REFUND_BROADCAST');
		const refundTxid = swap.record().refund!.attempts[0].txidHex;
		s.chain.evict(refundTxid);
		s.provider.pay(s.payer, swap.swapIdHex);
		s.provider.claim(s.chain, swap.swapIdHex, s.chain.height + 1);
		s.chain.height += 1;
		await swap.tick();
		expect(swap.state).to.equal('SETTLED');
		// The invoice is read first, so the settle is the recorded truth; the
		// claim on chain is consistent with it either way.
		expect(['settled', 'claim']).to.include(swap.record().resolution!.kind);
		expect(s.logs).to.include('swap_settled_after_refund_broadcast');

		// Our refund confirms first, yet the invoice settled: SETTLED, refund noted.
		const t = scene();
		const other = await confirmed(t);
		mineTo(t, other.record().refundHeight + 1);
		await other.tick();
		t.provider.pay(t.payer, other.swapIdHex);
		t.chain.mine(1);
		await other.tick();
		expect(other.state).to.equal('SETTLED');
		expect(t.logs).to.include('swap_settled_after_refund_broadcast');
	});

	it('bumps an unconfirmed refund by rebuild after bumpAfterBlocks, never below the replacement floor, capped', async function () {
		const s = scene({ maxRefundFeeSat: 1_500n });
		const swap = await confirmed(s);
		mineTo(s, swap.record().refundHeight + 1);
		await swap.tick();
		const first = swap.record().refund!.attempts[0];
		expect(swap.state).to.equal('REFUND_BROADCAST');
		// Stuck: evict from the mempool view so it never confirms, advance.
		s.chain.evict(first.txidHex);
		s.chain.height += 1;
		await swap.tick();
		expect(swap.record().refund!.attempts).to.have.length(1);
		s.chain.height += 1;
		await swap.tick();
		const attempts = swap.record().refund!.attempts;
		expect(attempts).to.have.length(2);
		expect(BigInt(attempts[1].feeSat) >= BigInt(first.feeSat) + 100n).to.equal(
			true
		);
		expect(Number(attempts[1].feeSat)).to.be.at.most(1_500);
		// The mock chain does not evict a replaced transaction: drop it by hand.
		s.chain.evict(attempts[0].txidHex);
		s.chain.mine(1);
		await swap.tick();
		expect(swap.state).to.equal('REFUNDED');
		expect(swap.record().refund!.confirmedTxidHex).to.equal(
			attempts[1].txidHex
		);
	});

	it('cancels a never-funded swap when the window closes or the invoice dies, never a funded one', async function () {
		const s = scene();
		const unfunded = await s.client.submarine.create(s.provider.id, {
			amountSat: AMOUNT
		});
		const expired = await s.client.submarine.create(s.provider.id, {
			amountSat: AMOUNT
		});
		const fundedOne = await confirmed(s);
		s.payer.expireInvoice(expired.record().paymentHashHex);
		await expired.tick();
		expect(expired.state).to.equal('CANCELLED');
		mineTo(s, unfunded.record().refundHeight + 1);
		await unfunded.tick();
		expect(unfunded.state).to.equal('CANCELLED');
		await fundedOne.tick();
		expect(fundedOne.state).to.equal('REFUND_BROADCAST');
		expect((await failure(unfunded.fund())).code).to.equal('state');
	});

	it('resume(): every persisted state continues from where it stopped', async function () {
		const s = scene();
		// FUNDED, a settle, and a refund out.
		const fundedSwap = await confirmed(s);
		const settledSwap = await confirmed(s);
		s.provider.pay(s.payer, settledSwap.swapIdHex);
		await settledSwap.tick();
		expect(settledSwap.state).to.equal('SETTLED');
		const refunding = await confirmed(s);
		mineTo(s, refunding.record().refundHeight + 1);
		s.chain.failNextBroadcasts = 1;
		await refunding.tick();
		expect(refunding.state).to.equal('REFUND_BROADCAST');
		expect(refunding.record().refund!.attempts[0].broadcastAt).to.equal(
			undefined
		);
		// Two young swaps (the provider's window opens at its own height):
		// CREATED with nothing sent, and CREATED with a funding request whose
		// reply was lost.
		s.provider.knobs.height = s.chain.height;
		const created = await s.client.submarine.create(s.provider.id, {
			amountSat: AMOUNT
		});
		const lost = await s.client.submarine.create(s.provider.id, {
			amountSat: AMOUNT
		});
		s.funder.hang = true;
		void lost.fund().catch(() => undefined);
		await new Promise((r) => setImmediate(r));
		s.funder.hang = false;
		expect(lost.record().fundingAttempt).to.not.equal(undefined);
		expect(lost.record().fundingAttempt!.txidHex).to.equal(undefined);

		await s.client.stop();
		const again = s.reopen();
		const report = await again.submarine.resume();
		const byId = (id: string): SubmarineSwap => again.submarine.get(id)!;
		expect(report.terminal).to.equal(1);
		expect(report.needsFunding.map((x) => x.swapIdHex)).to.deep.equal([
			created.swapIdHex
		]);
		expect(report.fundingUnknown.map((x) => x.swapIdHex)).to.deep.equal([
			lost.swapIdHex
		]);
		expect(
			s.funder.calls.filter((c) => c.label.includes(lost.swapIdHex))
		).to.have.length(1);
		expect(byId(fundedSwap.swapIdHex).state).to.equal('REFUND_BROADCAST');
		expect(byId(refunding.swapIdHex).state).to.equal('REFUND_BROADCAST');
		expect(s.chain.broadcasts).to.include(
			byId(refunding.swapIdHex).record().refund!.attempts[0].txidHex
		);
		expect(report.errors).to.deep.equal([]);
		// The lost funding turns up in the wallet: adopted on the next resume.
		s.funder.sent.set(
			lost.record().fundingAttempt!.label,
			await s.funder.fund(lost.record().htlcAddress, 100_000n, {
				label: 'found-later'
			})
		);
		await again.stop();
		const third = s.reopen();
		const report2 = await third.submarine.resume();
		expect(report2.fundingUnknown).to.deep.equal([]);
		expect(third.submarine.get(lost.swapIdHex)!.state).to.equal('FUNDING');
		// A funder present and fund: true funds the CREATED one.
		await third.stop();
		const fourth = s.reopen();
		const report3 = await fourth.submarine.resume({ fund: true });
		expect(report3.needsFunding).to.deep.equal([]);
		await new Promise((r) => setTimeout(r, 20));
		expect(
			fourth.submarine.get(created.swapIdHex)!.record().fundingAttempt
		).to.not.equal(undefined);
		await fourth.stop();
	});

	it('a damaged submarine document is kept and refused, and the reverse document is untouched', async function () {
		const s = scene();
		await s.client.submarine.create(s.provider.id, { amountSat: AMOUNT });
		await s.client.stop();
		s.storage.saveWalletData(SUBMARINE_SWAP_STORAGE_KEY, '{not json');
		const again = s.reopen();
		await again.submarine.resume().then(
			() => expect.fail('expected a storage error'),
			(err: SwapError) => {
				expect(err.code).to.equal('storage');
				expect(err.message).to.match(/submarine swap store is damaged/);
			}
		);
		expect(s.storage.loadWalletData(SUBMARINE_SWAP_STORAGE_KEY)).to.equal(
			'{not json'
		);
		expect(s.storage.loadWalletData('swaps:reverse')).to.equal(null);
	});

	it('run() funds, follows to SETTLED, and stop() is awaitable', async function () {
		const s = scene();
		const swap = await s.client.submarine.create(s.provider.id, {
			amountSat: AMOUNT
		});
		const running = swap.run();
		await new Promise((r) => setTimeout(r, 30));
		expect(swap.state).to.equal('FUNDING');
		s.chain.mine(1);
		swap.poke();
		await new Promise((r) => setTimeout(r, 30));
		expect(swap.state).to.equal('FUNDED');
		s.provider.pay(s.payer, swap.swapIdHex);
		swap.poke();
		const done = await running;
		expect(done.state).to.equal('SETTLED');
		await swap.stop();
		await s.client.stop();
	});
});
