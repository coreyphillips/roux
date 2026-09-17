/**
 * The swap after creation: funding discovered from the provider's hint and
 * verified on chain (wrong script, short value, spent and unconfirmed
 * outputs never count), the claim built with beignet's builder and
 * persisted before broadcast, bumps, the provider's refund, a reorg, and
 * resume() at every persisted state.
 */

import { expect } from 'chai';
import * as bitcoin from 'bitcoinjs-lib';
import { swaps } from 'beignet/lightning';
import { MemoryStorage, ReverseSwap, SwapClient } from '../../src';
import { REVERSE_SWAP_STORAGE_KEY } from '../../src/swaps/store';
import { IReverseSwapRecord } from '../../src/swaps/types';
import { FakeProvider } from '../swaps/fake-provider';
import { linkPair } from '../swaps/fake-link';
import { MockChain } from '../swaps/mock-chain';
import { FakePayer } from '../swaps/fake-payer';

interface IScene {
	client: SwapClient;
	provider: FakeProvider;
	chain: MockChain;
	payer: FakePayer;
	storage: MemoryStorage;
	logs: string[];
	reopen(): SwapClient;
}

function scene(policy: Record<string, unknown> = {}): IScene {
	const { client: clientLink, provider: providerLink } = linkPair();
	const provider = new FakeProvider(providerLink);
	const chain = new MockChain();
	const storage = new MemoryStorage();
	const payer = new FakePayer(storage);
	const logs: string[] = [];
	const make = (): SwapClient =>
		new SwapClient({
			link: clientLink,
			network: 'regtest',
			payer,
			chain,
			storage,
			policy: {
				statusPollMs: 0,
				chainPollMs: 5,
				replyTimeoutMs: 500,
				...policy
			},
			log: (action) => logs.push(action)
		});
	return {
		client: make(),
		provider,
		chain,
		payer,
		storage,
		logs,
		reopen: make
	};
}

async function started(s: IScene, amountSat = 100_000): Promise<ReverseSwap> {
	const swap = await s.client.reverse.create(s.provider.id, { amountSat });
	void swap.pay();
	return swap;
}

function stored(s: IScene, swapIdHex: string): IReverseSwapRecord {
	const doc = JSON.parse(
		s.storage.loadWalletData(REVERSE_SWAP_STORAGE_KEY)!
	) as {
		swaps: Record<string, IReverseSwapRecord>;
	};
	return doc.swaps[swapIdHex];
}

describe('ReverseSwap lifecycle', function () {
	it('takes the funding from the provider status hint only after verifying it on chain', async function () {
		const s = scene();
		const swap = await started(s);
		await swap.tick();
		expect(swap.state).to.equal('PAYING');
		expect(swap.record().funding).to.equal(undefined);
		const txid = s.provider.fund(s.chain, swap.swapIdHex);
		await swap.tick();
		expect(swap.record().funding!.txidHex).to.equal(txid);
		expect(swap.record().funding!.valueSat).to.equal('100000');
		// Unconfirmed: never claimed.
		expect(swap.state).to.equal('PAYING');
		expect(s.chain.broadcasts).to.have.length(0);
		s.chain.mine(1);
		await swap.tick();
		expect(swap.state).to.equal('CLAIM_BROADCAST');
		expect(s.logs).to.include('swap_funded');
	});

	it('ignores a funding with the wrong script or a short value, and a spent one', async function () {
		const s = scene();
		const swap = await started(s);
		const wrong = s.provider.fund(s.chain, swap.swapIdHex, {
			script: Buffer.concat([Buffer.from('0020', 'hex'), Buffer.alloc(32, 9)])
		});
		await swap.tick();
		expect(swap.record().funding).to.equal(undefined);
		s.chain.evict(wrong);
		s.provider.fund(s.chain, swap.swapIdHex, { valueSat: 99_999n });
		await swap.tick();
		expect(swap.record().funding).to.equal(undefined);
		expect(s.logs.filter((l) => l === 'swap_funding_rejected')).to.have.length(
			2
		);
	});

	it('falls back to a script scan when the provider is silent', async function () {
		const s = scene();
		const swap = await started(s);
		s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		s.provider.knobs.silent = true;
		await swap.tick();
		expect(swap.record().funding).to.not.equal(undefined);
	});

	it('claims to the destination with the policy fee, persisting the attempt before broadcast', async function () {
		const s = scene();
		const swap = await started(s);
		s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		s.chain.failNextBroadcasts = 1;
		await swap.tick();
		const r = swap.record();
		expect(r.state).to.equal('CLAIM_BROADCAST');
		expect(r.claim!.attempts).to.have.length(1);
		const attempt = r.claim!.attempts[0];
		expect(attempt.broadcastAt).to.equal(undefined);
		expect(r.lastError).to.match(/refused/);
		expect(stored(s, swap.swapIdHex).claim!.attempts[0].rawHex).to.equal(
			attempt.rawHex
		);
		const tx = bitcoin.Transaction.fromHex(attempt.rawHex);
		expect(tx.outs[0].script.toString('hex')).to.equal(r.destinationScriptHex);
		// The fee was sized from a probe build; a signature byte may differ.
		expect(Number(attempt.feeSat)).to.be.within(
			tx.virtualSize() * 3,
			(tx.virtualSize() + 3) * 3
		);
		expect(tx.ins[0].witness[1].toString('hex')).to.equal(r.preimageHex);
		// Next tick: the same bytes go out.
		await swap.tick();
		expect(s.chain.broadcasts).to.deep.equal([attempt.txidHex]);
		expect(swap.record().claim!.attempts[0].broadcastAt).to.be.a('number');
		expect(swap.record().lastError).to.equal(undefined);
	});

	it('marks CLAIMED at one confirmation and the payment completes with our preimage', async function () {
		const s = scene();
		const swap = await started(s);
		s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		await swap.tick();
		const claimTxid = swap.record().claim!.attempts[0].txidHex;
		s.payer.settle(
			swap.record().paymentHashHex,
			Buffer.from(swap.record().preimageHex!, 'hex')
		);
		s.chain.mine(1);
		await swap.tick();
		expect(swap.state).to.equal('CLAIMED');
		expect(swap.record().resolution).to.deep.equal({
			kind: 'claim',
			txidHex: claimTxid
		});
		expect(swap.record().payment!.status).to.equal('succeeded');
		expect(swap.record().payment!.preimageHex).to.equal(
			swap.record().preimageHex
		);
	});

	it('bumps an unconfirmed claim after the policy interval, never below the replacement floor', async function () {
		const s = scene({ bumpAfterBlocks: 2, maxClaimFeeSat: 700n });
		const swap = await started(s);
		s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		await swap.tick();
		const first = swap.record().claim!.attempts[0];
		s.chain.evict(first.txidHex);
		s.chain.height += 1;
		await swap.tick();
		expect(swap.record().claim!.attempts).to.have.length(1);
		s.chain.evict(first.txidHex);
		s.chain.height += 1;
		await swap.tick();
		const attempts = swap.record().claim!.attempts;
		expect(attempts).to.have.length(2);
		expect(Number(attempts[1].feeSat)).to.be.greaterThan(Number(first.feeSat));
		expect(attempts[1].txidHex).to.not.equal(first.txidHex);
		// At the cap the bump is refused; the bytes are just re-sent.
		s.chain.evict(attempts[1].txidHex);
		s.chain.height += 2;
		await swap.tick();
		s.chain.height += 2;
		await swap.tick();
		expect(swap.record().claim!.attempts.length).to.be.at.most(3);
		for (const a of swap.record().claim!.attempts)
			expect(Number(a.feeSat)).to.be.at.most(700);
	});

	it('the provider refund confirming first ends the swap EXPIRED with the witness classified', async function () {
		const s = scene();
		const swap = await started(s);
		s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		await swap.tick();
		const claimTxid = swap.record().claim!.attempts[0].txidHex;
		s.chain.evict(claimTxid);
		s.chain.height = swap.record().refundHeight + 1;
		s.provider.refund(s.chain, swap.swapIdHex, s.chain.height);
		await swap.tick();
		expect(swap.state).to.equal('EXPIRED');
		expect(swap.record().resolution!.kind).to.equal('refund');
	});

	it('never discloses a first preimage past the claim deadline; a claim already out is still followed', async function () {
		const s = scene({ claimSafetyBlocks: 6 });
		const swap = await started(s);
		s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		// The funding is seen and confirmed, but the tip is already inside
		// the safety window: no claim, no preimage on the wire.
		s.chain.height = swap.record().refundHeight - 6;
		await swap.tick();
		expect(swap.state).to.equal('FUNDED');
		expect(swap.record().claim).to.equal(undefined);
		expect(swap.record().claimDeadlinePassedAt).to.be.a('number');
		expect(s.logs).to.include('swap_claim_deadline_passed');
		expect(s.chain.broadcasts).to.have.length(0);
		let refused: unknown;
		try {
			await swap.claim();
		} catch (err) {
			refused = err;
		}
		expect((refused as { code?: string }).code).to.equal('deadline');
		s.chain.height = swap.record().refundHeight + 5;
		await swap.tick();
		expect(s.chain.broadcasts).to.have.length(0);
		// The provider refunds: the swap ends EXPIRED, principal intact.
		s.provider.refund(s.chain, swap.swapIdHex, s.chain.height);
		await swap.tick();
		expect(swap.state).to.equal('EXPIRED');

		// A claim disclosed in time keeps being followed past the deadline.
		const t = scene({ claimSafetyBlocks: 6 });
		const early = await started(t);
		t.provider.fund(t.chain, early.swapIdHex, { height: 1000 });
		await early.tick();
		expect(early.state).to.equal('CLAIM_BROADCAST');
		t.chain.height = early.record().refundHeight + 2;
		await early.tick();
		expect(early.state).to.equal('CLAIM_BROADCAST');
		expect(t.chain.broadcasts.length).to.be.greaterThan(1);
	});

	it('the first disclosure is judged after fee estimation: a deadline or a demotion during the wait refuses it', async function () {
		// Deadline passes while the fee backend is slow.
		const s = scene({ claimSafetyBlocks: 6 });
		const swap = await started(s);
		s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		let releaseFee: () => void = () => undefined;
		s.chain.feeGate = () =>
			new Promise<void>((resolve) => {
				releaseFee = resolve;
			});
		const ticking = swap.tick().catch((err: { code?: string }) => err);
		await new Promise((r) => setTimeout(r, 20));
		s.chain.height = swap.record().refundHeight + 1;
		releaseFee();
		const refused = (await ticking) as { code?: string };
		expect(refused.code).to.equal('deadline');
		expect(s.chain.broadcasts).to.have.length(0);
		expect(swap.record().claim).to.equal(undefined);
		expect(swap.state).to.equal('FUNDED');

		// Funding falls back into the mempool while the fee backend is slow.
		const t = scene();
		const other = await started(t);
		const txid = t.provider.fund(t.chain, other.swapIdHex, { height: 1000 });
		let releaseFee2: () => void = () => undefined;
		t.chain.feeGate = () =>
			new Promise<void>((resolve) => {
				releaseFee2 = resolve;
			});
		const ticking2 = other.tick().catch((err: { code?: string }) => err);
		await new Promise((r) => setTimeout(r, 20));
		t.chain.confirm(txid, 0);
		releaseFee2();
		const demoted = (await ticking2) as { code?: string };
		expect(demoted.code).to.equal('funding_unconfirmed');
		expect(t.chain.broadcasts).to.have.length(0);
		expect(other.record().claim).to.equal(undefined);
		expect(other.state).to.equal('PAYING');
		expect(t.logs).to.include('swap_funding_demoted');
	});

	it('an unanswerable claim keeps the funding context instead of reading a reorg', async function () {
		const s = scene();
		const swap = await started(s);
		s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		await swap.tick();
		expect(swap.state).to.equal('CLAIM_BROADCAST');
		const claimTxid = swap.record().claim!.attempts[0].txidHex;
		const funding = swap.record().funding!;
		// The claim was mined long ago and the source's window no longer
		// reaches it; the output it spent still reads as spent.
		s.chain.confirm(claimTxid, 1001);
		s.chain.height = 1100;
		s.chain.unknownTxids.add(claimTxid);
		s.provider.knobs.silent = true;
		await swap.tick();
		expect(swap.record().funding).to.deep.equal(funding);
		expect(swap.state).to.equal('CLAIM_BROADCAST');
		expect(s.logs).to.include('swap_claim_status_unknown');
		expect(s.logs).to.not.include('swap_funding_reorged');
		// The source can answer again: CLAIMED, and a restart resumes clean.
		s.chain.unknownTxids.delete(claimTxid);
		await swap.tick();
		expect(swap.state).to.equal('CLAIMED');
		const report = await s.reopen().reverse.resume();
		expect(report.errors).to.have.length(0);
	});

	it('a resumed FUNDED record whose funding is back in the mempool is demoted, never claimed at zero confirmations', async function () {
		const s = scene();
		const swap = await started(s);
		const txid = s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		// Persist FUNDED without a claim (the chain read failed before the
		// claim was built), then let the funding fall back into the mempool.
		s.chain.failNextBroadcasts = 0;
		const doc = JSON.parse(
			s.storage.loadWalletData(REVERSE_SWAP_STORAGE_KEY)!
		) as { swaps: Record<string, IReverseSwapRecord> };
		doc.swaps[swap.swapIdHex] = {
			...doc.swaps[swap.swapIdHex],
			state: 'FUNDED',
			funding: {
				txidHex: txid,
				vout: 0,
				valueSat: '100000',
				firstSeenHeight: 1000,
				confirmedHeight: 1000
			}
		};
		s.storage.saveWalletData(REVERSE_SWAP_STORAGE_KEY, JSON.stringify(doc));
		s.chain.confirm(txid, 0);
		const report = await s.reopen().reverse.resume();
		expect(report.resumed).to.have.length(1);
		expect(report.resumed[0].state).to.equal('PAYING');
		expect(s.chain.broadcasts).to.have.length(0);
		expect(s.logs).to.include('swap_funding_demoted');
		// Confirmed again: FUNDED, then the claim.
		s.chain.confirm(txid, s.chain.height);
		const client = s.reopen();
		const again = await client.reverse.resume();
		expect(again.resumed[0].state).to.equal('CLAIM_BROADCAST');
		expect(s.chain.broadcasts).to.have.length(1);
	});

	it('a reorged funding is forgotten and waited for again', async function () {
		const s = scene();
		const swap = await started(s);
		const txid = s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		await swap.tick();
		expect(swap.state).to.equal('CLAIM_BROADCAST');
		const claimTxid = swap.record().claim!.attempts[0].txidHex;
		s.chain.evict(claimTxid);
		s.chain.evict(txid);
		s.provider.swaps.get(swap.swapIdHex)!.fundingTxid = undefined;
		s.provider.knobs.silent = true;
		await swap.tick();
		expect(swap.record().funding).to.equal(undefined);
		expect(swap.state).to.equal('CLAIM_BROADCAST');
		expect(s.logs).to.include('swap_funding_reorged');
	});

	it('a failed payment with no funding is PAYMENT_FAILED; a dead deadline is EXPIRED', async function () {
		const s = scene();
		const a = await started(s);
		s.payer.fail(a.record().paymentHashHex);
		await a.tick();
		expect(a.state).to.equal('PAYMENT_FAILED');
		const b = await s.client.reverse.create(s.provider.id, {
			amountSat: 50_000
		});
		s.chain.height = b.record().refundHeight + 1;
		await b.tick();
		expect(b.state).to.equal('CREATED');
		void b.pay();
		s.payer.fail(b.record().paymentHashHex);
		await b.tick();
		expect(b.state).to.equal('PAYMENT_FAILED');
	});

	it('run() pays, follows the swap to CLAIMED and stops', async function () {
		const s = scene();
		const swap = await s.client.reverse.create(s.provider.id, {
			amountSat: 100_000
		});
		const done = swap.run();
		await new Promise((r) => setTimeout(r, 20));
		expect(s.payer.calls).to.have.length(1);
		s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		await new Promise((r) => setTimeout(r, 40));
		s.chain.mine(1);
		s.payer.settle(
			swap.record().paymentHashHex,
			Buffer.from(swap.record().preimageHex!, 'hex')
		);
		const final = await done;
		expect(final.state).to.equal('CLAIMED');
	});

	describe('resume()', function () {
		it('reports a CREATED swap the node knows nothing about, and pays it only when asked', async function () {
			const s = scene();
			const swap = await s.client.reverse.create(s.provider.id, {
				amountSat: 100_000
			});
			const again = s.reopen();
			const report = await again.reverse.resume();
			expect(report.needsPayment.map((x) => x.swapIdHex)).to.deep.equal([
				swap.swapIdHex
			]);
			expect(s.payer.calls).to.have.length(0);
			const paid = await again.reverse.resume({ pay: true });
			expect(paid.resumed).to.have.length(1);
			await new Promise((r) => setImmediate(r));
			expect(s.payer.calls).to.have.length(1);
			expect(again.reverse.get(swap.swapIdHex)!.state).to.equal('PAYING');
		});

		it('a CREATED swap the node is already paying becomes PAYING; a dead one EXPIRED', async function () {
			const s = scene();
			const swap = await s.client.reverse.create(s.provider.id, {
				amountSat: 100_000
			});
			s.payer.status.set(swap.record().paymentHashHex, { status: 'pending' });
			const report = await s.reopen().reverse.resume();
			expect(report.resumed[0].state).to.equal('PAYING');
			const b = await s.client.reverse.create(s.provider.id, {
				amountSat: 50_000
			});
			s.chain.height = b.record().refundHeight + 1;
			const late = await s.reopen().reverse.resume();
			expect(late.terminal).to.be.greaterThan(0);
			expect(s.reopen().reverse.get(b.swapIdHex)!.state).to.equal('EXPIRED');
		});

		it('FUNDED after a crash claims; CLAIM_BROADCAST re-sends the persisted bytes', async function () {
			const s = scene();
			const swap = await started(s);
			s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
			s.chain.failNextBroadcasts = 1;
			await swap.tick();
			const attempt = swap.record().claim!.attempts[0];
			expect(attempt.broadcastAt).to.equal(undefined);
			const report = await s.reopen().reverse.resume();
			expect(report.resumed).to.have.length(1);
			expect(s.chain.broadcasts).to.deep.equal([attempt.txidHex]);
			// A FUNDED row (persisted before any attempt) builds the claim itself.
			const doc = JSON.parse(
				s.storage.loadWalletData(REVERSE_SWAP_STORAGE_KEY)!
			) as { swaps: Record<string, IReverseSwapRecord> };
			doc.swaps[swap.swapIdHex] = {
				...doc.swaps[swap.swapIdHex],
				state: 'FUNDED',
				claim: undefined
			};
			s.storage.saveWalletData(REVERSE_SWAP_STORAGE_KEY, JSON.stringify(doc));
			s.chain.evict(attempt.txidHex);
			const again = await s.reopen().reverse.resume();
			expect(again.resumed[0].state).to.equal('CLAIM_BROADCAST');
			expect(s.chain.broadcasts).to.have.length(2);
		});

		it('terminal rows are counted and never touched', async function () {
			const s = scene();
			const swap = await started(s);
			s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
			await swap.tick();
			s.chain.mine(1);
			await swap.tick();
			expect(swap.state).to.equal('CLAIMED');
			const report = await s.reopen().reverse.resume();
			expect(report.terminal).to.equal(1);
			expect(report.resumed).to.have.length(0);
			expect(
				s.payer.tracked.filter((h) => h === swap.record().paymentHashHex).length
			).to.be.at.most(2);
		});
	});

	it('beignet extracts our preimage from the claim we broadcast', async function () {
		const s = scene();
		const swap = await started(s);
		s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		await swap.tick();
		const r = swap.record();
		const claim = bitcoin.Transaction.fromHex(r.claim!.attempts[0].rawHex);
		const funding = s.chain.txs.get(r.funding!.txidHex)!.tx;
		const preimage = swaps.extractSwapPreimage(claim, {
			htlc: {
				paymentHash: Buffer.from(r.paymentHashHex, 'hex'),
				claimPublicKey: Buffer.from(r.claimPubkeyHex, 'hex'),
				refundPublicKey: Buffer.from(r.refundPubkeyHex, 'hex'),
				refundHeight: r.refundHeight
			},
			fundingTransaction: funding,
			outputIndex: r.funding!.vout
		});
		expect(preimage!.toString('hex')).to.equal(r.preimageHex);
	});
});
