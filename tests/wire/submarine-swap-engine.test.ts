/**
 * roux's submarine swap client against beignet's REAL provider engine
 * over a real Noise connection on loopback TCP: the client side runs on the
 * published `beignet/lightning` build, the provider side on beignet's
 * source tree with its test fakes for the chain and the funding wallet. The
 * Lightning rail between them is one in-memory invoice registry: the
 * client's node mints and settles invoices there, the provider's payment
 * closures pay against it and hand the engine the honest HTLC view.
 */

import { expect } from 'chai';
import * as bitcoin from 'bitcoinjs-lib';
import { waitFor } from '../helpers';
import { teardown, wireScene } from '../swaps/submarine-engine-harness';

describe("submarine swap: roux against beignet's real provider engine over Noise TCP", function () {
	this.timeout(60_000);

	it('quotes, creates, funds, the engine pays under the ceiling and claims, the client settles', async function () {
		const s = await wireScene('settle');
		try {
			const quote = await s.client.swaps.quote(s.peer.idHex, {
				direction: 'submarine',
				amountSat: 100_000
			});
			expect(quote.accepted).to.equal(true);
			expect(quote.direction).to.equal('submarine');
			// flat 50 + 2000 ppm (200) + 2 sat/vB x 150 vB (300), plus the
			// routing budget of 1000 ppm on the 99_450 sat left (100).
			expect(quote.totalFeeSat).to.equal(650n);
			expect(quote.invoiceAmountMsat).to.equal((100_000n - 650n) * 1000n);
			expect(quote.withinPolicy).to.equal(true);

			const swap = await s.client.swaps.submarine.create(s.peer.idHex, {
				amountSat: 100_000
			});
			const rec = swap.record();
			expect(rec.refundHeight).to.equal(5_200);
			expect(rec.paymentCeilingHeight).to.equal(5_200 - 12 - 6);
			expect(rec.totalFeeSat).to.equal('750');
			expect(s.ledger.list()[0].state).to.equal('CREATED');
			expect(s.ledger.list()[0].bolt11).to.equal(rec.bolt11);

			const done = swap.run();
			await waitFor(() => swap.state === 'FUNDING', 'client funded', 10_000);
			await s.engine.onBlock(s.chain.height);
			expect(s.ledger.list()[0].state).to.equal('FUNDING_SEEN');
			// One block confirms the funding: the engine pays and claims.
			s.chain.height += 1;
			s.chain.confirm(swap.record().funding!.txidHex, s.chain.height);
			await s.engine.onBlock(s.chain.height);
			const row = s.ledger.list()[0];
			expect(row.state).to.equal('CLAIM_BROADCAST');
			expect(s.rail.payCalls).to.have.length(1);
			expect(s.rail.payCalls[0].maxCltvExpiryHeight).to.equal(5_182);
			expect(row.preimageHex).to.equal(
				s.rail.invoices.get(rec.paymentHashHex)!.preimage.toString('hex')
			);
			swap.poke();
			await waitFor(() => swap.state === 'SETTLED', 'client settled', 10_000);
			expect(swap.record().settledBy).to.equal('invoice');
			expect(swap.record().invoice!.preimageHex).to.equal(row.preimageHex);
			expect(swap.record().refund).to.equal(undefined);
			const final = await done;
			expect(final.state).to.equal('SETTLED');
			// The claim confirms to policy depth.
			s.chain.height += 1;
			s.chain.confirm(row.claimTxid!, s.chain.height);
			await s.engine.onBlock(s.chain.height);
			s.chain.height += 1;
			await s.engine.onBlock(s.chain.height);
			expect(s.ledger.list()[0].state).to.equal('CLAIM_CONFIRMED');
			expect(s.events).to.deep.equal([
				'swap:created',
				'swap:funding-seen',
				'swap:funded',
				'swap:paying',
				'swap:preimage',
				'swap:claim-broadcast',
				'swap:claim-confirmed'
			]);
		} finally {
			await teardown(s);
		}
	});

	it('the engine cannot pay: PAYMENT_FAILED with no claim, and the client refunds after the height', async function () {
		const s = await wireScene('refund');
		s.rail.refuse = true;
		try {
			const swap = await s.client.swaps.submarine.create(s.peer.idHex, {
				amountSat: 80_000
			});
			const rec = swap.record();
			const done = swap.run();
			await waitFor(() => swap.state === 'FUNDING', 'client funded', 10_000);
			s.chain.height += 1;
			s.chain.confirm(swap.record().funding!.txidHex, s.chain.height);
			await s.engine.onBlock(s.chain.height);
			expect(s.ledger.list()[0].state).to.equal('PAYMENT_FAILED');
			expect(s.ledger.list()[0].claimTxHex).to.equal(undefined);
			swap.poke();
			await waitFor(
				() => swap.state === 'FUNDED',
				'client sees the depth',
				10_000
			);
			// Up to the refund height: nothing; at it: the refund.
			s.chain.height = rec.refundHeight - 1;
			swap.poke();
			await new Promise((r) => setTimeout(r, 100));
			expect(swap.state).to.equal('FUNDED');
			expect(
				s.chain.broadcasts.filter((b) => !b.includes(rec.htlcOutputScriptHex))
			).to.have.length(0);
			s.chain.height = rec.refundHeight;
			swap.poke();
			await waitFor(
				() => swap.state === 'REFUND_BROADCAST',
				'refund broadcast',
				10_000
			);
			const refund = bitcoin.Transaction.fromHex(
				swap.record().refund!.attempts[0].rawHex
			);
			expect(refund.locktime).to.equal(rec.refundHeight);
			expect(refund.outs[0].script.toString('hex')).to.equal(
				rec.refundDestinationScriptHex
			);
			s.chain.height += 1;
			s.chain.confirm(refund.getId(), s.chain.height);
			swap.poke();
			const final = await done;
			expect(final.state).to.equal('REFUNDED');
			expect(s.ledger.list()[0].state).to.equal('PAYMENT_FAILED');
			expect(s.events).to.include('swap:payment-failed');
			expect(s.events).to.not.include('swap:claim-broadcast');
		} finally {
			await teardown(s);
		}
	});
});
