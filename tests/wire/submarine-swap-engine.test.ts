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
import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { invoice as beignetInvoice } from 'beignet/lightning';
import { BeignetClient, MemoryStorage, NoisePeerLink } from '../../src';
import {
	ISwapChain,
	ISwapChainOutput,
	ISwapCreateInvoiceParams,
	ISwapCreatedInvoice,
	ISwapFunder,
	ISwapFundingCandidate,
	ISwapInvoiceStatus,
	ISwapLightningPayer,
	ISwapPaymentStatus
} from '../../src/swaps/types';
import { listeningPeer } from '../df-harness';
import { sha, waitFor } from '../helpers';
import {
	SubmarineSwapProvider,
	SwapChainResolver,
	SwapLedger,
	deriveSwapKey
} from '../../node_modules/beignet/src/lightning/swaps';
import { MemoryLedgerStore } from '../../node_modules/beignet/src/lightning/storage/durable-ledger';
import { getPublicKey } from '../../node_modules/beignet/src/lightning/crypto/ecdh';
import { computeScriptHash } from '../../node_modules/beignet/src/lightning/chain/chain-watcher';
import {
	IOutgoingPaymentResolution,
	IPaymentInfo,
	PaymentDirection,
	PaymentStatus
} from '../../node_modules/beignet/src/lightning/node/types';
import {
	FakeSwapChain,
	FakeWallet
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
	async findSpender(
		txidHex: string,
		vout: number,
		outputScript: Buffer
	): Promise<string | null> {
		const hash = Buffer.from(txidHex, 'hex').reverse();
		for (const e of await this.entriesFor(outputScript)) {
			if (e.txid === txidHex) continue;
			const tx = bitcoin.Transaction.fromBuffer(
				await this.chain.getTransaction(e.txid)
			);
			if (tx.ins.some((i) => i.hash.equals(hash) && i.index === vout))
				return e.txid;
		}
		return null;
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

/**
 * The Lightning rail: the client node's invoices, and what the provider's
 * payment engine would report about paying them.
 */
class Rail {
	readonly nodeKey = crypto.randomBytes(32);
	readonly invoices = new Map<
		string,
		{
			preimage: Buffer;
			amountMsat: bigint;
			state: ISwapInvoiceStatus['state'];
		}
	>();
	readonly views = new Map<string, IOutgoingPaymentResolution>();
	readonly listeners = new Set<(hash: Buffer) => void>();
	readonly payCalls: Array<{
		maxCltvExpiryHeight: number;
		maxFeeMsat: bigint;
	}> = [];
	/** Refuse every payment before an HTLC leaves (no route). */
	refuse = false;

	mint(params: ISwapCreateInvoiceParams): ISwapCreatedInvoice {
		const preimage = crypto.randomBytes(32);
		const paymentHash = crypto.createHash('sha256').update(preimage).digest();
		const bolt11 = beignetInvoice.encode({
			network: beignetInvoice.Network.REGTEST,
			amountMsat: params.amountMsat,
			timestamp: Math.floor(Date.now() / 1000),
			paymentHash,
			paymentSecret: crypto.randomBytes(32),
			description: params.description,
			expiry: params.expirySeconds,
			minFinalCltvExpiry: params.minFinalCltvExpiry,
			privateKey: this.nodeKey
		});
		this.invoices.set(paymentHash.toString('hex'), {
			preimage,
			amountMsat: params.amountMsat,
			state: 'open'
		});
		return { bolt11, paymentHash };
	}

	lookup(paymentHash: Buffer): ISwapInvoiceStatus {
		const inv = this.invoices.get(paymentHash.toString('hex'));
		if (!inv) return { state: 'unknown' };
		return {
			state: inv.state,
			preimage: inv.state === 'settled' ? inv.preimage : undefined,
			htlcsInFlight: inv.state === 'accepted' ? 1 : 0
		};
	}

	/** The provider's sendPaymentWithOptions: settled at once, or refused. */
	pay(
		bolt11: string,
		options: { maxCltvExpiryHeight: number; maxFeeMsat: bigint }
	): IPaymentInfo {
		this.payCalls.push(options);
		const decoded = beignetInvoice.decode(bolt11);
		const hashHex = decoded.paymentHash.toString('hex');
		const inv = this.invoices.get(hashHex);
		if (this.refuse || !inv) throw new Error('NO_ROUTE');
		inv.state = 'settled';
		this.views.set(hashHex, {
			paymentHash: decoded.paymentHash,
			status: PaymentStatus.COMPLETED,
			htlcs: [
				{
					channelId: Buffer.alloc(32, 1),
					htlcId: 0n,
					amountMsat: inv.amountMsat,
					cltvExpiry: options.maxCltvExpiryHeight - 5,
					state: 'fulfilled',
					terminal: true
				}
			],
			resolved: true,
			latestOutstandingExpiry: null,
			preimage: inv.preimage
		});
		return {
			paymentHash: decoded.paymentHash,
			amountMsat: inv.amountMsat,
			status: PaymentStatus.COMPLETED,
			direction: PaymentDirection.OUTGOING,
			createdAt: Date.now(),
			preimage: inv.preimage
		};
	}

	view(paymentHash: Buffer): IOutgoingPaymentResolution {
		return (
			this.views.get(paymentHash.toString('hex')) ?? {
				paymentHash,
				status: null,
				htlcs: [],
				resolved: true,
				latestOutstandingExpiry: null
			}
		);
	}
}

class RailPayer implements ISwapLightningPayer {
	readonly destination = bitcoin.payments.p2wpkh({
		pubkey: getPublicKey(crypto.randomBytes(32))
	}).output!;
	constructor(private readonly rail: Rail) {}
	async payInvoice(): Promise<ISwapPaymentStatus> {
		throw new Error('the submarine client never pays');
	}
	async trackPayment(): Promise<ISwapPaymentStatus> {
		return { status: 'unknown' };
	}
	async newDestinationScript(): Promise<Buffer> {
		return this.destination;
	}
	async createInvoice(
		params: ISwapCreateInvoiceParams
	): Promise<ISwapCreatedInvoice> {
		return this.rail.mint(params);
	}
	async lookupInvoice(paymentHash: Buffer): Promise<ISwapInvoiceStatus> {
		return this.rail.lookup(paymentHash);
	}
}

/** Funds through beignet's fake wallet and the fake chain's broadcast. */
class RailFunder implements ISwapFunder {
	constructor(
		private readonly wallet: FakeWallet,
		private readonly chain: FakeSwapChain
	) {}
	async fund(
		address: string,
		amountSat: bigint
	): Promise<{ txidHex: string; vout: number; rawHex: string }> {
		const built = await this.wallet.fundOutput(address, amountSat, 2);
		await this.chain.broadcastTransaction(built.txHex);
		return {
			txidHex: bitcoin.Transaction.fromHex(built.txHex).getId(),
			vout: built.vout,
			rawHex: built.txHex
		};
	}
}

interface IWireScene {
	peer: Awaited<ReturnType<typeof listeningPeer>>;
	chain: FakeSwapChain;
	rail: Rail;
	ledger: SwapLedger;
	engine: SubmarineSwapProvider;
	events: string[];
	client: BeignetClient;
}

async function wireScene(label: string): Promise<IWireScene> {
	const providerKey = sha(`submarine-engine-wire-${label}`);
	const peer = await listeningPeer(providerKey);
	const chain = new FakeSwapChain();
	chain.height = 5_000;
	const rail = new Rail();
	const wallet = new FakeWallet();
	const ledger = new SwapLedger(new MemoryLedgerStore());
	ledger.rehydrate();
	const events: string[] = [];
	const engine = new SubmarineSwapProvider(
		{
			peers: peer.peers,
			ledger,
			resolver: new SwapChainResolver(
				chain,
				{ fundingConfirmations: 1, resolutionConfirmations: 2 },
				bitcoin.networks.regtest
			),
			payInvoice: (bolt11, options) => rail.pay(bolt11, options),
			outgoingHtlcs: (hash) => rail.view(hash),
			onPaymentEvent: (cb) => {
				rail.listeners.add(cb);
				return () => rail.listeners.delete(cb);
			},
			hashInUse: () => false,
			spendableOutboundMsat: () => 10_000_000_000n,
			ownNodeId: getPublicKey(providerKey),
			hasUsableChannelWith: () => true,
			broadcast: (hex) => chain.broadcastTransaction(hex),
			estimateFee: async () => 2,
			currentHeight: () => chain.height,
			deriveClaimKey: (id) => deriveSwapKey(providerKey, id, 'claim'),
			claimDestinationScript: () =>
				bitcoin.payments.p2wpkh({ pubkey: getPublicKey(providerKey) }).output!,
			network: bitcoin.networks.regtest,
			networkName: 'regtest',
			log: () => undefined
		},
		{
			flatFeeSat: 50n,
			feePpm: 2_000,
			paymentMaxFeePpm: 1_000,
			refundDeltaBlocks: 200,
			minRefundDeltaBlocks: 100,
			maxRefundDeltaBlocks: 400,
			claimSafetyBlocks: 12,
			resolutionSafetyBlocks: 6,
			routeCltvBudgetBlocks: 20,
			fundingConfirmations: 1,
			resolutionConfirmations: 2,
			claimBumpIntervalBlocks: 2,
			minInvoiceExpirySeconds: 60
		}
	);
	for (const evt of [
		'swap:created',
		'swap:funding-seen',
		'swap:funded',
		'swap:paying',
		'swap:preimage',
		'swap:claim-broadcast',
		'swap:claim-confirmed',
		'swap:payment-failed'
	]) {
		engine.on(evt, () => events.push(evt));
	}
	await engine.start();
	const client = new BeignetClient({
		link: new NoisePeerLink({ network: 'regtest' }),
		network: 'regtest',
		storage: new MemoryStorage(),
		swaps: {
			payer: new RailPayer(rail),
			funder: new RailFunder(wallet, chain),
			chain: new ClientChainView(chain),
			policy: {
				statusPollMs: 0,
				chainPollMs: 20,
				minRefundDeltaBlocks: 30,
				claimSafetyBlocks: 6,
				routeBudgetBlocks: 6,
				invoiceFinalCltvBlocks: 40
			}
		}
	});
	await client.connect(`${peer.idHex}@127.0.0.1:${peer.port}`);
	return { peer, chain, rail, ledger, engine, events, client };
}

async function teardown(s: IWireScene): Promise<void> {
	await s.client.close();
	s.engine.stop();
	s.peer.pm.destroy();
}

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
				swap.record().refund!.attempts[0].rawHex!
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
