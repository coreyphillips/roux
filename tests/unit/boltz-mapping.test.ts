/**
 * roux-boltzd's pure pieces: the on-chain amount found for a Boltz invoice
 * amount (against beignet's own fee arithmetic, including the ceilings
 * that make it a step function), every row of the state mapping, the fee
 * split boltzcli prints, and a provider quote as a boltz pair.
 */

import { expect } from 'chai';
import { swaps } from 'beignet/lightning';
import { MemoryStorage, SwapClient } from '../../src';
import {
	reverseOnchainFor,
	reverseState,
	submarineOnchainFor,
	submarineState,
	toAnySwapInfo,
	toPairInfo,
	toReverseSwapInfo,
	toSwapInfo
} from '../../src/boltz';
import { bip21 } from '../../src/boltz/service';
import {
	IReverseSwapRecord,
	ISubmarineSwapRecord
} from '../../src/swaps/types';
import { ISwapQuoteResult } from '../../src/swaps/client';
import { FakeProvider } from '../swaps/fake-provider';
import { linkPair } from '../swaps/fake-link';
import { MockChain } from '../swaps/mock-chain';
import { FakePayer } from '../swaps/fake-payer';

function feeOf(terms: {
	flatFeeSat: bigint;
	feePpm: number;
	minerFeeSat: bigint;
}): { quote: (x: bigint) => Promise<bigint>; calls: bigint[] } {
	const calls: bigint[] = [];
	return {
		calls,
		quote: async (x): Promise<bigint> => {
			calls.push(x);
			return swaps.reverseSwapFee(x, terms);
		}
	};
}

const SCHEDULES = [
	{ flatFeeSat: 100n, feePpm: 1_000, minerFeeSat: 400n },
	{ flatFeeSat: 0n, feePpm: 5_000, minerFeeSat: 1_234n },
	{ flatFeeSat: 7n, feePpm: 999, minerFeeSat: 0n },
	{ flatFeeSat: 0n, feePpm: 0, minerFeeSat: 0n }
];

describe('roux-boltzd amounts', function () {
	it('submarine: the on-chain amount whose invoice is exactly the requested one', async function () {
		for (const terms of SCHEDULES) {
			for (const invoice of [1n, 10_000n, 99_999n, 100_000n, 1_234_567n]) {
				const { quote, calls } = feeOf(terms);
				const onchain = await submarineOnchainFor(invoice, quote, 100n);
				const fee = swaps.reverseSwapFee(onchain, terms);
				expect(onchain - fee - 100n, `${invoice} @ ${terms.feePpm}`).to.equal(
					invoice
				);
				expect(calls.length).to.be.at.most(6);
			}
		}
	});

	it('reverse: the largest on-chain amount whose invoice does not exceed the requested one', async function () {
		for (const terms of SCHEDULES) {
			for (const invoice of [2_000n, 10_000n, 100_000n, 1_234_567n]) {
				const { quote } = feeOf(terms);
				const onchain = await reverseOnchainFor(invoice, quote);
				const pays = onchain + swaps.reverseSwapFee(onchain, terms);
				expect(Number(pays)).to.be.at.most(Number(invoice));
				const next = onchain + 1n + swaps.reverseSwapFee(onchain + 1n, terms);
				expect(Number(next), `${invoice} @ ${terms.feePpm}`).to.be.greaterThan(
					Number(invoice)
				);
			}
		}
	});

	it('reverse: an invoice that cannot cover the fee is refused', async function () {
		const { quote } = feeOf(SCHEDULES[0]);
		let error: Error | null = null;
		await reverseOnchainFor(300n, quote).catch((e) => (error = e));
		expect(error!.message).to.match(/does not cover the fee/);
	});

	it('bip21 carries the amount in BTC without trailing zeros', function () {
		expect(bip21('bcrt1qx', 100_000n)).to.equal(
			'bitcoin:bcrt1qx?amount=0.001&label=Send%20to%20BTC%20lightning'
		);
		expect(bip21('bcrt1qx', 250_000_000n)).to.match(/amount=2\.5&/);
		expect(bip21('bcrt1qx', 100_000_000n)).to.match(/amount=1&/);
	});
});

async function records(): Promise<{
	submarine: ISubmarineSwapRecord;
	reverse: IReverseSwapRecord;
}> {
	const { client: link, provider: providerLink } = linkPair('map');
	const provider = new FakeProvider(providerLink);
	const chain = new MockChain();
	const client = new SwapClient({
		link,
		network: 'regtest',
		payer: new FakePayer(),
		chain,
		storage: new MemoryStorage(),
		policy: { replyTimeoutMs: 500, minRefundDeltaBlocks: 30 }
	});
	const submarine = await client.submarine.create(provider.id, {
		amountSat: 100_000
	});
	const reverse = await client.reverse.create(provider.id, {
		amountSat: 100_000
	});
	return { submarine: submarine.record(), reverse: reverse.record() };
}

describe('roux-boltzd mapping', function () {
	it('maps every submarine state', async function () {
		const { submarine: r } = await records();
		const funding = {
			txidHex: 'aa'.repeat(32),
			vout: 0,
			valueSat: r.onchainAmountSat,
			firstSeenHeight: 1000,
			source: 'funder' as const
		};
		const cases: Array<[Partial<ISubmarineSwapRecord>, string, string]> = [
			[{ state: 'CREATED' }, 'PENDING', 'invoice.set'],
			[{ state: 'FUNDING', funding }, 'PENDING', 'transaction.mempool'],
			[
				{ state: 'FUNDING', funding: { ...funding, confirmedHeight: 1001 } },
				'PENDING',
				'transaction.confirmed'
			],
			[{ state: 'FUNDED', funding }, 'PENDING', 'transaction.confirmed'],
			[
				{
					state: 'FUNDED',
					funding,
					invoice: { state: 'accepted', checkedAt: 1 }
				},
				'PENDING',
				'invoice.pending'
			],
			[{ state: 'SETTLED' }, 'SUCCESSFUL', 'invoice.paid'],
			[
				{ state: 'SETTLED', resolution: { kind: 'claim', txidHex: 'bb' } },
				'SUCCESSFUL',
				'transaction.claimed'
			],
			[{ state: 'REFUND_BROADCAST' }, 'PENDING', 'swap.expired'],
			[{ state: 'REFUNDED' }, 'REFUNDED', 'swap.expired'],
			[{ state: 'CANCELLED' }, 'ABANDONED', 'swap.expired']
		];
		for (const [patch, state, status] of cases) {
			expect(
				submarineState({ ...r, ...patch }),
				JSON.stringify(patch)
			).to.deep.equal({
				state,
				status
			});
		}
	});

	it('maps every reverse state', async function () {
		const { reverse: r } = await records();
		const funding = {
			txidHex: 'aa'.repeat(32),
			vout: 0,
			valueSat: r.onchainAmountSat,
			firstSeenHeight: 1000
		};
		const cases: Array<[Partial<IReverseSwapRecord>, string, string]> = [
			[{ state: 'CREATED' }, 'PENDING', 'swap.created'],
			[{ state: 'PAYING' }, 'PENDING', 'swap.created'],
			[{ state: 'PAYING', funding }, 'PENDING', 'transaction.mempool'],
			[
				{ state: 'FUNDED', funding: { ...funding, confirmedHeight: 1000 } },
				'PENDING',
				'transaction.confirmed'
			],
			[{ state: 'CLAIM_BROADCAST' }, 'PENDING', 'transaction.confirmed'],
			[{ state: 'CLAIMED' }, 'SUCCESSFUL', 'invoice.settled'],
			[{ state: 'PAYMENT_FAILED' }, 'ERROR', 'invoice.expired'],
			[{ state: 'EXPIRED' }, 'ERROR', 'swap.expired'],
			[
				{ state: 'EXPIRED', resolution: { kind: 'refund', txidHex: 'cc' } },
				'ERROR',
				'transaction.refunded'
			]
		];
		for (const [patch, state, status] of cases) {
			expect(
				reverseState({ ...r, ...patch }),
				JSON.stringify(patch)
			).to.deep.equal({
				state,
				status
			});
		}
	});

	it('fills SwapInfo the way boltzd does, fees always set', async function () {
		const { submarine: r } = await records();
		const info = toSwapInfo(r, 'regtest');
		expect(info.id).to.equal(r.swapIdHex);
		expect(info.pair).to.deep.equal({ from: 'BTC', to: 'BTC' });
		expect(info.private_key).to.equal(r.refundPrivkeyHex);
		expect(info.invoice).to.equal(r.bolt11);
		expect(info.lockup_address).to.equal(r.htlcAddress);
		expect(info.expected_amount).to.equal(100_000);
		expect(info.timeout_block_height).to.equal(r.refundHeight);
		expect(info.refund_address).to.match(/^bcrt1/);
		// The P2WSH witness script hashes to the lockup output.
		const script = Buffer.from(info.redeem_script, 'hex');
		expect(
			swaps
				.buildSwapHtlc({
					paymentHash: Buffer.from(r.paymentHashHex, 'hex'),
					claimPublicKey: Buffer.from(r.claimPubkeyHex, 'hex'),
					refundPublicKey: Buffer.from(r.refundPubkeyHex, 'hex'),
					refundHeight: r.refundHeight
				})
				.witnessScript.equals(script)
		).to.equal(true);
		// Everything below the invoice is a fee, split service / miner.
		const total = Number(r.totalFeeSat);
		expect(info.service_fee! + info.onchain_fee!).to.equal(total);
		expect(info.onchain_fee).to.equal(Number(r.minerFeeSat));
		const any = toAnySwapInfo(info);
		expect(any.type).to.equal('SUBMARINE');
		expect(any.from_amount).to.equal(100_000);
		expect(any.to_amount).to.equal(Number(r.invoiceAmountMsat) / 1000);
	});

	it('fills ReverseSwapInfo, counting our claim fee as on-chain fee', async function () {
		const { reverse: r } = await records();
		const claimed: IReverseSwapRecord = {
			...r,
			state: 'CLAIMED',
			claim: {
				attempts: [
					{
						txidHex: 'dd'.repeat(32),
						rawHex: '',
						feeSat: '321',
						feeRateSatPerVb: 3,
						builtAt: 1
					}
				],
				confirmedTxidHex: 'dd'.repeat(32)
			},
			payment: { startedAt: 1, status: 'pending', external: true }
		};
		const info = toReverseSwapInfo(claimed, 'regtest');
		expect(info.state).to.equal('SUCCESSFUL');
		expect(info.preimage).to.equal(r.preimageHex);
		expect(info.private_key).to.equal(r.claimPrivkeyHex);
		expect(info.claim_transaction_id).to.equal('dd'.repeat(32));
		expect(info.onchain_amount).to.equal(100_000);
		expect(info.invoice_amount).to.equal(Number(r.invoiceAmountMsat) / 1000);
		expect(info.external_pay).to.equal(true);
		expect(info.onchain_fee).to.equal(Number(r.minerFeeSat) + 321);
		expect(info.service_fee).to.equal(
			Number(r.totalFeeSat) - Number(r.minerFeeSat)
		);
		expect(info.claim_address).to.match(/^bcrt1/);
		const failed = toReverseSwapInfo(
			{
				...r,
				state: 'PAYMENT_FAILED',
				payment: { startedAt: 1, status: 'failed', failureReason: 'no route' }
			},
			'regtest'
		);
		expect(failed.error).to.equal('payment failed: no route');
	});

	it('prices a pair as Boltz does: percentage plus miner fees, limits on the invoice', function () {
		const limits: ISwapQuoteResult = {
			direction: 'submarine',
			accepted: true,
			flatFeeSat: 100n,
			feePpm: 1_000,
			minSwapSat: 10_000n,
			maxSwapSat: 1_000_000n,
			refundDeltaBlocks: 144,
			fundingConfirmations: 1,
			invoiceExpirySeconds: 600,
			totalFeeSat: 0n,
			minerFeeSat: 0n,
			invoiceAmountMsat: 0n,
			withinPolicy: true
		};
		// flat 100 + 1000 ppm + 400 miner, as the fake provider charges.
		const terms = {
			limits,
			feeAtMinSat: 510n,
			feeAtMaxSat: 1_500n,
			minerFeeSat: 400n,
			slackSat: 100n
		};
		const sub = toPairInfo('submarine', terms);
		expect(sub.fees.percentage).to.equal(0.1);
		// Everything that is not the percentage, measured at the minimum.
		expect(sub.fees.miner_fees).to.equal(510 - 10 + 100);
		expect(sub.limits.minimal).to.equal(10_000 - 510 - 100);
		expect(sub.limits.maximal).to.equal(1_000_000 - 1_500 - 100);
		const rev = toPairInfo('reverse', terms);
		expect(rev.fees.miner_fees).to.equal(500);
		expect(rev.limits.minimal).to.equal(10_510);
		expect(rev.limits.maximal).to.equal(1_001_500);
		// Same terms, same hash; a moved fee is a new hash.
		expect(toPairInfo('submarine', terms).hash).to.equal(sub.hash);
		expect(
			toPairInfo('submarine', { ...terms, feeAtMinSat: 511n }).hash
		).to.not.equal(sub.hash);
		expect(rev.hash).to.not.equal(sub.hash);
	});

	it('takes the provider at its word, including a fee no local formula knows', function () {
		// beignet's submarine engine also charges a routing budget on the net
		// amount, which is in its quote and in no fee formula here.
		const limits: ISwapQuoteResult = {
			direction: 'submarine',
			accepted: true,
			flatFeeSat: 50n,
			feePpm: 2_000,
			minSwapSat: 10_000n,
			maxSwapSat: 1_000_000n,
			refundDeltaBlocks: 200,
			fundingConfirmations: 1,
			invoiceExpirySeconds: 60,
			totalFeeSat: 0n,
			minerFeeSat: 0n,
			invoiceAmountMsat: 0n,
			withinPolicy: true
		};
		// 50 flat + 20 ppm + 300 miner + 10 routing at the 10 000 sat minimum.
		const sub = toPairInfo('submarine', {
			limits,
			feeAtMinSat: 380n,
			feeAtMaxSat: 3_300n,
			minerFeeSat: 300n,
			slackSat: 100n
		});
		expect(sub.limits.minimal).to.equal(9_520);
		expect(sub.fees.miner_fees).to.equal(380 - 20 + 100);
	});
});
