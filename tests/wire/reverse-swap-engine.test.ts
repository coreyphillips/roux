/**
 * roux's reverse swap client against beignet's REAL provider engine over
 * a real Noise connection on loopback TCP: the client side runs on the
 * published `beignet/lightning` build, the provider side on beignet's
 * source tree with its own test fakes for the chain, the hold invoice and
 * the funding wallet. They share nothing but the wire and the fake chain,
 * which is the point.
 */

import { expect } from 'chai';
import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { invoice as beignetInvoice } from 'beignet/lightning';
import { BeignetClient, MemoryStorage, NoisePeerLink } from '../../src';
import {
	ISwapChain,
	ISwapChainOutput,
	ISwapFundingCandidate,
	ISwapLightningPayer,
	ISwapPaymentStatus
} from '../../src/swaps/types';
import { listeningPeer } from '../df-harness';
import { sha, waitFor } from '../helpers';
import {
	ReverseSwapProvider,
	SwapChainResolver,
	SwapLedger,
	deriveSwapKey
} from '../../node_modules/beignet/src/lightning/swaps';
import { MemoryLedgerStore } from '../../node_modules/beignet/src/lightning/storage/durable-ledger';
import { getPublicKey } from '../../node_modules/beignet/src/lightning/crypto/ecdh';
import { computeScriptHash } from '../../node_modules/beignet/src/lightning/chain/chain-watcher';
import {
	FakeHolds,
	FakeSwapChain,
	FakeWallet,
	HOLD_CANCEL_MARGIN
} from '../../node_modules/beignet/tests/lightning/helpers/swap-harness';

/** The client's chain view over the provider's fake chain. */
class ClientChainView implements ISwapChain {
	constructor(private readonly chain: FakeSwapChain) {}
	async currentHeight(): Promise<number> {
		return this.chain.height;
	}
	async getTransaction(txidHex: string): Promise<Buffer | null> {
		try {
			return await this.chain.getTransaction(txidHex);
		} catch {
			return null;
		}
	}
	private async entriesFor(
		script: Buffer
	): Promise<Array<{ txid: string; height: number }>> {
		return this.chain.getScriptHashHistory(computeScriptHash(script));
	}
	async getOutput(
		txidHex: string,
		vout: number
	): Promise<ISwapChainOutput | null> {
		const raw = await this.getTransaction(txidHex);
		if (!raw) return null;
		const tx = bitcoin.Transaction.fromBuffer(raw);
		const out = tx.outs[vout];
		if (!out) return null;
		const entries = await this.entriesFor(out.script);
		const own = entries.find((e) => e.txid === txidHex);
		if (!own) return null;
		for (const e of entries) {
			if (e.txid === txidHex) continue;
			const spender = bitcoin.Transaction.fromBuffer(
				await this.chain.getTransaction(e.txid)
			);
			if (
				spender.ins.some((i) => i.hash.equals(tx.getHash()) && i.index === vout)
			)
				return null;
		}
		return {
			valueSat: BigInt(out.value),
			script: out.script,
			confirmations: own.height > 0 ? this.chain.height - own.height + 1 : 0,
			height: own.height
		};
	}
	async findOutputs(outputScript: Buffer): Promise<ISwapFundingCandidate[]> {
		const out: ISwapFundingCandidate[] = [];
		for (const e of await this.entriesFor(outputScript)) {
			const tx = bitcoin.Transaction.fromBuffer(
				await this.chain.getTransaction(e.txid)
			);
			tx.outs.forEach((o, vout) => {
				if (o.script.equals(outputScript))
					out.push({
						txidHex: e.txid,
						vout,
						valueSat: BigInt(o.value),
						height: e.height
					});
			});
		}
		return out;
	}
	async confirmations(txidHex: string): Promise<number | null> {
		const raw = await this.getTransaction(txidHex);
		if (!raw) return null;
		const tx = bitcoin.Transaction.fromBuffer(raw);
		for (const o of tx.outs) {
			const own = (await this.entriesFor(o.script)).find(
				(e) => e.txid === txidHex
			);
			if (own) return own.height > 0 ? this.chain.height - own.height + 1 : 0;
		}
		return null;
	}
	async broadcast(rawHex: string): Promise<string> {
		return this.chain.broadcastTransaction(rawHex);
	}
}

/** "Pays" by parking a committed part on the provider's hold model. */
class HoldPayer implements ISwapLightningPayer {
	readonly destination = bitcoin.payments.p2wpkh({
		pubkey: getPublicKey(crypto.randomBytes(32))
	}).output!;
	/** Hashes this node was asked to pay; anything else is unknown to it. */
	private readonly paid = new Set<string>();
	constructor(
		private readonly holds: FakeHolds,
		private readonly chain: FakeSwapChain
	) {}
	async payInvoice(bolt11: string): Promise<ISwapPaymentStatus> {
		const decoded = beignetInvoice.decode(bolt11);
		const hashHex = decoded.paymentHash.toString('hex');
		this.paid.add(hashHex);
		this.holds.hold(
			decoded.paymentHash,
			decoded.amountMsat!,
			this.chain.height + (decoded.minFinalCltvExpiry ?? 40) + 3
		);
		await waitFor(
			() =>
				this.holds.settledHashes.has(hashHex) ||
				this.holds.cancelledHashes.has(hashHex),
			'hold outcome',
			30_000
		);
		return this.trackPayment(decoded.paymentHash);
	}
	async trackPayment(paymentHash: Buffer): Promise<ISwapPaymentStatus> {
		const hashHex = paymentHash.toString('hex');
		if (!this.paid.has(hashHex)) return { status: 'unknown' };
		const settled = this.holds.settled.find((s) => s.hash === hashHex);
		if (settled)
			return {
				status: 'succeeded',
				preimage: Buffer.from(settled.preimage, 'hex')
			};
		if (this.holds.cancelledHashes.has(hashHex)) return { status: 'failed' };
		if (this.holds.parts.has(hashHex) || this.holds.invoices.has(hashHex))
			return { status: 'pending' };
		return { status: 'unknown' };
	}
	async newDestinationScript(): Promise<Buffer> {
		return this.destination;
	}
}

describe("reverse swap: roux against beignet's real provider engine over Noise TCP", function () {
	this.timeout(60_000);

	it('quotes, creates, pays, claims from the mempool and the engine settles on the preimage', async function () {
		const providerKey = sha('swap-engine-wire-provider');
		const peer = await listeningPeer(providerKey);
		const chain = new FakeSwapChain();
		chain.height = 5_000;
		const holds = new FakeHolds(providerKey, () => chain.height);
		const wallet = new FakeWallet();
		const ledger = new SwapLedger(new MemoryLedgerStore());
		ledger.rehydrate();
		const events: string[] = [];
		const engine = new ReverseSwapProvider(
			{
				peers: peer.peers,
				ledger,
				resolver: new SwapChainResolver(
					chain,
					{ fundingConfirmations: 1, resolutionConfirmations: 2 },
					bitcoin.networks.regtest
				),
				createHoldInvoice: (o) => holds.createHoldInvoice(o),
				heldSnapshot: (h) => holds.snapshot(h),
				settleHeld: (h, p) => holds.settleHeld(h, p),
				cancelHold: (h) => holds.cancelHold(h),
				onHeld: (cb) => {
					holds.heldListeners.add(cb);
					return () => holds.heldListeners.delete(cb);
				},
				onHoldCancelled: (cb) => {
					holds.cancelListeners.add(cb);
					return () => holds.cancelListeners.delete(cb);
				},
				fundOutput: (a, s, r) => wallet.fundOutput(a, s, r),
				broadcast: (hex) => chain.broadcastTransaction(hex),
				estimateFee: async () => 2,
				currentHeight: () => chain.height,
				deriveRefundKey: (id) => deriveSwapKey(providerKey, id, 'refund'),
				refundDestinationScript: () =>
					bitcoin.payments.p2wpkh({ pubkey: getPublicKey(providerKey) })
						.output!,
				network: bitcoin.networks.regtest,
				networkName: 'regtest',
				log: () => undefined
			},
			{
				flatFeeSat: 50n,
				feePpm: 2_000,
				refundDeltaBlocks: 60,
				minRefundDeltaBlocks: 30,
				maxRefundDeltaBlocks: 120,
				fundingSafetyBlocks: 6,
				resolutionSafetyBlocks: 6,
				fundingConfirmations: 1,
				resolutionConfirmations: 2,
				holdCancelSafetyBlocks: HOLD_CANCEL_MARGIN
			}
		);
		for (const evt of [
			'swap:created',
			'swap:held',
			'swap:funding',
			'swap:funded',
			'swap:claimed',
			'swap:settled'
		]) {
			engine.on(evt, () => events.push(evt));
		}
		await engine.start();

		const link = new NoisePeerLink({ network: 'regtest' });
		const payer = new HoldPayer(holds, chain);
		const client = new BeignetClient({
			link,
			network: 'regtest',
			storage: new MemoryStorage(),
			swaps: {
				payer,
				chain: new ClientChainView(chain),
				policy: { statusPollMs: 0, chainPollMs: 20, minRefundDeltaBlocks: 30 }
			}
		});
		try {
			await client.connect(`${peer.idHex}@127.0.0.1:${peer.port}`);
			const quote = await client.swaps.quote(peer.idHex, {
				direction: 'reverse',
				amountSat: 100_000
			});
			expect(quote.accepted).to.equal(true);
			expect(quote.totalFeeSat).to.equal(50n + 200n + 400n);

			const swap = await client.swaps.reverse.create(peer.idHex, {
				amountSat: 100_000
			});
			expect(swap.record().refundHeight).to.equal(5_060);
			expect(ledger.list()[0].state).to.equal('CREATED');
			const done = swap.run();

			await waitFor(
				() => ledger.list()[0].state === 'FUNDING_BROADCAST',
				'engine funded',
				10_000
			);
			expect(wallet.builds).to.have.length(1);
			// One block confirms the funding; roux then claims.
			const fundingTxid = ledger.list()[0].fundingTxid!;
			chain.height += 1;
			chain.confirm(fundingTxid, chain.height);
			await engine.onBlock(chain.height);
			swap.poke();
			await waitFor(
				() => swap.state === 'CLAIM_BROADCAST',
				'claim broadcast',
				10_000
			);
			// The claim is in the fake mempool: the engine settles from it.
			await engine.onBlock(chain.height);
			expect(ledger.list()[0].state).to.equal('SETTLED');
			expect(ledger.list()[0].preimageHex).to.equal(swap.record().preimageHex);
			expect(holds.settled).to.have.length(1);
			// Then the claim confirms and roux finishes.
			chain.height += 1;
			chain.confirm(swap.record().claim!.attempts[0].txidHex, chain.height);
			swap.poke();
			const final = await done;
			expect(final.state).to.equal('CLAIMED');
			expect(final.payment!.status).to.equal('succeeded');
			expect(final.payment!.preimageHex).to.equal(final.preimageHex);
			expect(events).to.deep.equal([
				'swap:created',
				'swap:held',
				'swap:funding',
				'swap:funded',
				'swap:claimed',
				'swap:settled'
			]);
		} finally {
			await client.close();
			engine.stop();
			peer.pm.destroy();
		}
	});
});
