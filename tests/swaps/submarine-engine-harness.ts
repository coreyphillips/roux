/**
 * beignet's REAL submarine provider engine on a real Noise listener, with
 * roux's client connected to it over loopback TCP: the provider runs on
 * beignet's source tree with its test fakes for the chain and the funding
 * wallet, and the Lightning rail between them is one in-memory invoice
 * registry. Shared by the submarine engine wire test and roux-boltzd's.
 */
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
import { sha } from '../helpers';
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
export class ClientChainView implements ISwapChain {
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
export class Rail {
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

export class RailPayer implements ISwapLightningPayer {
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
export class RailFunder implements ISwapFunder {
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

export interface IWireScene {
	peer: Awaited<ReturnType<typeof listeningPeer>>;
	chain: FakeSwapChain;
	rail: Rail;
	ledger: SwapLedger;
	engine: SubmarineSwapProvider;
	events: string[];
	client: BeignetClient;
}

export async function wireScene(label: string): Promise<IWireScene> {
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

export async function teardown(s: IWireScene): Promise<void> {
	await s.client.close();
	s.engine.stop();
	s.peer.pm.destroy();
}
