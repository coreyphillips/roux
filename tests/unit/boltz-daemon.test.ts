/**
 * roux-boltzd end to end over real gRPC: a boltzrpc client built from the
 * vendored proto, authenticated with boltzd-style macaroons, drives a
 * BeignetClient whose provider, node, wallet and chain are the swap fakes.
 * Both directions to their end (reverse paid by the node and externally;
 * submarine funded by the node wallet and by hand; a refund redirected),
 * the streams boltzcli follows, the refusals, and the auth split.
 */

import { expect } from 'chai';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as bitcoin from 'bitcoinjs-lib';
import * as grpc from '@grpc/grpc-js';
import { invoice as beignetInvoice } from 'beignet/lightning';
import { BeignetClient, MemoryStorage } from '../../src';
import {
	BoltzService,
	IBoltzServer,
	RpcAuth,
	boltzClient,
	startBoltzDaemon,
	startBoltzServer
} from '../../src/boltz';
import type {
	IBoltzDaemonConfig,
	CreateReverseSwapResponse,
	CreateSwapResponse,
	GetInfoResponse,
	GetPairInfoRequest,
	GetSwapInfoResponse,
	GetSwapQuoteResponse,
	ListSwapsResponse,
	PairInfo
} from '../../src/boltz';
import { FakeProvider } from '../swaps/fake-provider';
import { FakeLink, linkPair } from '../swaps/fake-link';
import { MockChain } from '../swaps/mock-chain';
import { FakePayer } from '../swaps/fake-payer';
import { FakeFunder } from '../swaps/fake-funder';
import { waitFor } from '../helpers';

type Rpc = grpc.Client & Record<string, (...args: unknown[]) => unknown>;

interface IScene {
	rpc: Rpc;
	server: IBoltzServer;
	client: BeignetClient;
	link: FakeLink;
	provider: FakeProvider;
	chain: MockChain;
	payer: FakePayer;
	funder: FakeFunder;
	storage: MemoryStorage;
	admin: string;
	readonly: string;
	stops: number;
	call<T>(
		method: string,
		request?: object,
		macaroon?: string | null
	): Promise<T>;
	stream(
		id: string,
		macaroon?: string
	): { messages: GetSwapInfoResponse[]; ended: Promise<void> };
	close(): Promise<void>;
}

async function scene(): Promise<IScene> {
	const { client: link, provider: providerLink } = linkPair('boltzd');
	const provider = new FakeProvider(providerLink);
	const chain = new MockChain();
	const storage = new MemoryStorage();
	const payer = new FakePayer(storage);
	const funder = new FakeFunder(chain, storage);
	const client = new BeignetClient({
		link,
		network: 'regtest',
		storage,
		swaps: {
			payer,
			funder,
			chain,
			policy: {
				statusPollMs: 0,
				chainPollMs: 5,
				replyTimeoutMs: 500,
				minRefundDeltaBlocks: 30,
				claimSafetyBlocks: 6,
				routeBudgetBlocks: 6,
				invoiceFinalCltvBlocks: 40
			}
		}
	});
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roux-boltzd-'));
	const auth = new RpcAuth({
		adminMacaroonPath: path.join(dir, 'macaroons', 'admin.macaroon'),
		readonlyMacaroonPath: path.join(dir, 'macaroons', 'readonly.macaroon')
	});
	auth.init();
	const admin = fs
		.readFileSync(path.join(dir, 'macaroons', 'admin.macaroon'))
		.toString('hex');
	const readonly = fs
		.readFileSync(path.join(dir, 'macaroons', 'readonly.macaroon'))
		.toString('hex');
	const s = { stops: 0 } as IScene;
	const service = new BoltzService({
		client,
		chain,
		provider: provider.id,
		network: 'regtest',
		node: 'lnd',
		version: 'roux-boltzd test',
		onStop: () => s.stops++
	});
	const server = await startBoltzServer({
		service,
		auth,
		host: '127.0.0.1',
		port: 0,
		credentials: grpc.ServerCredentials.createInsecure()
	});
	const rpc = boltzClient(
		`127.0.0.1:${server.port}`,
		grpc.credentials.createInsecure()
	);
	const md = (macaroon: string | null): grpc.Metadata => {
		const m = new grpc.Metadata();
		if (macaroon !== null) m.set('macaroon', macaroon);
		return m;
	};
	Object.assign(s, {
		rpc,
		server,
		client,
		link,
		provider,
		chain,
		payer,
		funder,
		storage,
		admin,
		readonly,
		call: <T>(
			method: string,
			request: object = {},
			macaroon: string | null = admin
		): Promise<T> =>
			new Promise<T>((resolve, reject) =>
				rpc[method](request, md(macaroon), (err: Error | null, res: T) =>
					err ? reject(err) : resolve(res)
				)
			),
		stream: (id: string, macaroon: string = admin) => {
			const messages: GetSwapInfoResponse[] = [];
			const call = rpc.GetSwapInfoStream(
				{ swap_id: id },
				md(macaroon)
			) as grpc.ClientReadableStream<GetSwapInfoResponse>;
			call.on('data', (m: GetSwapInfoResponse) => messages.push(m));
			const ended = new Promise<void>((resolve, reject) => {
				call.on('end', () => resolve());
				call.on('error', reject);
			});
			return { messages, ended };
		},
		close: async () => {
			rpc.close();
			await server.close(200);
			await client.close();
		}
	});
	return s;
}

async function rejection(p: Promise<unknown>): Promise<grpc.ServiceError> {
	try {
		await p;
	} catch (err) {
		return err as grpc.ServiceError;
	}
	throw new Error('expected the call to fail');
}

/** The fake provider: flat 100 + 1000 ppm (rounded up) + 400 miner. */
function providerFee(onchain: number): number {
	return 100 + Math.ceil((onchain * 1000) / 1_000_000) + 400;
}

describe('roux-boltzd over gRPC', function () {
	this.timeout(20_000);
	let s: IScene;

	beforeEach(async function () {
		s = await scene();
	});

	afterEach(async function () {
		await s.close();
	});

	it('GetInfo, GetPairs, GetPairInfo and GetSwapQuote answer as boltzd does', async function () {
		const info = await s.call<GetInfoResponse>('GetInfo');
		expect(info).to.include({
			version: 'roux-boltzd test',
			node: 'lnd',
			network: 'regtest',
			node_pubkey: s.link.id,
			auto_swap_status: 'disabled'
		});
		expect(info.block_heights.btc).to.equal(1000);
		expect(info.warnings ?? []).to.deep.equal([]);

		const pairs = await s.call<{
			submarine: PairInfo[];
			reverse: PairInfo[];
			chain?: PairInfo[];
		}>('GetPairs');
		expect(pairs.submarine).to.have.length(1);
		expect(pairs.reverse).to.have.length(1);
		expect(pairs.chain ?? []).to.have.length(0);
		expect(pairs.submarine[0].pair).to.deep.equal({ from: 'BTC', to: 'BTC' });
		expect(pairs.submarine[0].fees.percentage).to.equal(0.1);
		expect(pairs.reverse[0].fees.miner_fees).to.equal(500);
		expect(pairs.submarine[0].hash).to.match(/^[0-9a-f]{64}$/);

		const liquid: GetPairInfoRequest = {
			type: 'SUBMARINE',
			pair: { from: 'LBTC', to: 'BTC' }
		};
		const err = await rejection(s.call('GetPairInfo', liquid));
		expect(err.code).to.equal(grpc.status.INVALID_ARGUMENT);
		expect(err.details).to.match(/BTC only/);

		const sub = await s.call<GetSwapQuoteResponse>('GetSwapQuote', {
			type: 'SUBMARINE',
			receive_amount: 50_000
		});
		expect(sub.receive_amount).to.equal(50_000);
		expect(sub.send_amount - sub.boltz_fee - sub.network_fee).to.equal(50_000);
		expect(sub.network_fee).to.equal(400);
		const rev = await s.call<GetSwapQuoteResponse>('GetSwapQuote', {
			type: 'REVERSE',
			send_amount: 100_000 + providerFee(100_000)
		});
		expect(rev.receive_amount).to.equal(100_000);
		expect(rev.send_amount).to.equal(100_000 + providerFee(100_000));
	});

	it('CreateReverseSwap: the node pays, roux claims, the stream ends SUCCESSFUL', async function () {
		const invoiceSat = 100_000 + providerFee(100_000);
		const created = await s.call<CreateReverseSwapResponse>(
			'CreateReverseSwap',
			{
				amount: invoiceSat,
				pair: { from: 'BTC', to: 'BTC' },
				accept_zero_conf: true,
				return_immediately: true,
				description: ''
			}
		);
		expect(created.id).to.match(/^[0-9a-f]{32}$/);
		expect(created.lockup_address).to.match(/^bcrt1q/);
		expect(created.invoice).to.match(/^lnbcrt/);
		const stream = s.stream(created.id);
		await waitFor(() => s.payer.calls.length === 1, 'the node pays');
		s.provider.fund(s.chain, created.id, { height: 1000 });
		// An unconfirmed claim is re-sent on every pass.
		await waitFor(
			() => s.chain.broadcasts.length > 0,
			'the claim is broadcast'
		);
		s.chain.mine(1);
		await stream.ended;
		const last = stream.messages[stream.messages.length - 1].reverse_swap!;
		expect(last.state).to.equal('SUCCESSFUL');
		expect(last.status).to.equal('invoice.settled');
		expect(last.onchain_amount).to.equal(100_000);
		expect(last.invoice_amount).to.equal(invoiceSat);
		expect(last.claim_transaction_id).to.equal(s.chain.broadcasts[0]);
		// boltzcli dereferences both on success.
		expect(last.onchain_fee).to.be.greaterThan(400);
		expect(last.service_fee).to.equal(providerFee(100_000) - 400);
		expect(last.private_key).to.match(/^[0-9a-f]{64}$/);
		expect(stream.messages.map((m) => m.reverse_swap!.status)).to.include(
			'swap.created'
		);
	});

	it('CreateReverseSwap waits for the claim when zero-conf is asked without return_immediately, as boltzd does', async function () {
		const pending = s.call<CreateReverseSwapResponse>('CreateReverseSwap', {
			amount: 100_000 + providerFee(100_000),
			accept_zero_conf: true
		});
		await waitFor(() => s.payer.calls.length === 1, 'the node pays');
		const [swap] = s.client.swaps.reverse.list();
		s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
		const created = await pending;
		expect(created.id).to.equal(swap.swapIdHex);
		expect(created.claim_transaction_id).to.equal(
			swap.record().claim!.attempts[0].txidHex
		);
	});

	it('CreateReverseSwap with external_pay returns the invoice and never asks the node to pay', async function () {
		const created = await s.call<CreateReverseSwapResponse>(
			'CreateReverseSwap',
			{ amount: 100_000 + providerFee(100_000), external_pay: true }
		);
		expect(created.invoice).to.match(/^lnbcrt/);
		const info = await s.call<GetSwapInfoResponse>('GetSwapInfo', {
			swap_id: created.id
		});
		expect(info.reverse_swap!.external_pay).to.equal(true);
		s.provider.fund(s.chain, created.id, { height: 1000 });
		await waitFor(() => s.chain.broadcasts.length > 0, 'the claim');
		s.chain.mine(1);
		await waitFor(
			() => s.client.swaps.reverse.get(created.id)!.state === 'CLAIMED',
			'claimed'
		);
		expect(s.payer.calls).to.have.length(0);
		const err = await rejection(
			s.call('CreateReverseSwap', {
				amount: 100_000,
				external_pay: true,
				return_immediately: false
			})
		);
		expect(err.code).to.equal(grpc.status.INVALID_ARGUMENT);
	});

	it('CreateReverseSwap refuses what roux cannot honour', async function () {
		for (const [request, code, detail] of [
			[
				{ amount: 100_000, chan_ids: ['1x2x3'] },
				grpc.status.FAILED_PRECONDITION,
				/chan_ids/
			],
			[
				{ amount: 100_000, wallet_id: 1 },
				grpc.status.FAILED_PRECONDITION,
				/internal wallets/
			],
			[
				{ amount: 100_000, add_magic_routing_hint: true },
				grpc.status.FAILED_PRECONDITION,
				/magic routing/
			],
			[{ amount: 0 }, grpc.status.INVALID_ARGUMENT, /amount is required/],
			[
				{ amount: 100_000, pair: { from: 'BTC', to: 'LBTC' } },
				grpc.status.INVALID_ARGUMENT,
				/BTC only/
			],
			[
				{ amount: 100_000, address: 'not-an-address' },
				grpc.status.INVALID_ARGUMENT,
				/invalid address/
			],
			[
				{ amount: 100_600, accepted_pair: { hash: 'stale' } },
				grpc.status.FAILED_PRECONDITION,
				/terms changed/
			]
		] as Array<[object, grpc.status, RegExp]>) {
			const err = await rejection(s.call('CreateReverseSwap', request));
			expect(err.code, JSON.stringify(request)).to.equal(code);
			expect(err.details).to.match(detail);
		}
		expect(s.client.swaps.reverse.list()).to.have.length(0);
	});

	it('the advertised limits are the ones a swap can be created at, both directions', async function () {
		// The provider serves 10 000 to 1 000 000 sat on chain and refuses
		// anything outside, so the fee probes for an amount at either end
		// fall outside its range before they are clamped.
		const submarine = await s.call<PairInfo>('GetPairInfo', {
			type: 'SUBMARINE'
		});
		expect(submarine.limits.minimal).to.equal(
			10_000 - providerFee(10_000) - 100
		);
		const atMinimum = await s.call<CreateSwapResponse>('CreateSwap', {
			amount: submarine.limits.minimal
		});
		expect(atMinimum.expected_amount).to.equal(10_000);
		expect(
			s.client.swaps.submarine.get(atMinimum.id)!.record().invoiceAmountMsat
		).to.equal(`${submarine.limits.minimal}000`);

		const reverse = await s.call<PairInfo>('GetPairInfo', { type: 'REVERSE' });
		expect(reverse.limits.maximal).to.equal(1_000_000 + providerFee(1_000_000));
		const atMaximum = await s.call<CreateReverseSwapResponse>(
			'CreateReverseSwap',
			{ amount: reverse.limits.maximal, external_pay: true }
		);
		expect(
			s.client.swaps.reverse.get(atMaximum.id)!.record().onchainAmountSat
		).to.equal('1000000');

		// Outside them, the provider's own limit is named.
		const small = await rejection(s.call('CreateSwap', { amount: 1_000 }));
		expect(small.code).to.equal(grpc.status.INVALID_ARGUMENT);
		expect(small.details).to.match(/below the provider's minimum 10000/);
		const large = await rejection(
			s.call('CreateReverseSwap', { amount: 5_000_000 })
		);
		expect(large.code).to.equal(grpc.status.INVALID_ARGUMENT);
		expect(large.details).to.match(/above the provider's maximum 1000000/);
		const quoted = await s.call<GetSwapQuoteResponse>('GetSwapQuote', {
			type: 'SUBMARINE',
			send_amount: 10_000
		});
		expect(quoted.receive_amount).to.equal(submarine.limits.minimal);
	});

	it('CreateSwap from the node wallet: tx_id returned, the provider pays, SETTLED', async function () {
		const created = await s.call<CreateSwapResponse>('CreateSwap', {
			amount: 50_000,
			pair: { from: 'BTC', to: 'BTC' },
			send_from_internal: true,
			// boltzcli sends these set, empty.
			refund_address: '',
			invoice: ''
		});
		expect(created.tx_id).to.match(/^[0-9a-f]{64}$/);
		expect(s.funder.calls).to.have.length(1);
		expect(created.expected_amount).to.equal(
			Number(s.funder.calls[0].amountSat)
		);
		expect(created.bip21).to.match(
			new RegExp(`^bitcoin:${created.address}\\?amount=0\\.`)
		);
		expect(created.timeout_hours).to.be.greaterThan(0);
		const rec = s.client.swaps.submarine.get(created.id)!.record();
		// The invoice is exactly the requested Lightning amount.
		expect(rec.invoiceAmountMsat).to.equal('50000000');
		const stream = s.stream(created.id);
		s.chain.mine(1);
		await waitFor(
			() => s.client.swaps.submarine.get(created.id)!.state === 'FUNDED',
			'funded'
		);
		s.provider.pay(s.payer, created.id);
		await stream.ended;
		const last = stream.messages[stream.messages.length - 1].swap!;
		expect(last.state).to.equal('SUCCESSFUL');
		expect(last.lockup_transaction_id).to.equal(created.tx_id);
		expect(last.service_fee! + last.onchain_fee!).to.equal(
			created.expected_amount - 50_000
		);
		expect(last.preimage).to.match(/^[0-9a-f]{64}$/);
	});

	it('CreateSwap funded by hand is found on chain; a node invoice for exactly the amount is taken', async function () {
		const external = await s.call<CreateSwapResponse>('CreateSwap', {
			amount: 40_000
		});
		expect(external.tx_id).to.equal('');
		expect(s.funder.calls).to.have.length(0);
		await s.funder.fund(external.address, BigInt(external.expected_amount), {
			label: 'by hand'
		});
		await waitFor(
			() => s.client.swaps.submarine.get(external.id)!.state === 'FUNDING',
			'the funding is discovered'
		);
		const own = s.payer.supplyInvoice(30_000_000n);
		const supplied = await s.call<CreateSwapResponse>('CreateSwap', {
			invoice: own
		});
		expect(s.client.swaps.submarine.get(supplied.id)!.record()).to.include({
			bolt11: own,
			invoiceSource: 'supplied'
		});
	});

	it("CreateSwap refuses a third party's invoice, LNURL, no amount and internal wallets", async function () {
		const foreign = beignetInvoice.encode({
			network: beignetInvoice.Network.REGTEST,
			amountMsat: 30_000_000n,
			timestamp: Math.floor(Date.now() / 1000),
			paymentHash: crypto.randomBytes(32),
			paymentSecret: crypto.randomBytes(32),
			description: 'a merchant',
			expiry: 7200,
			minFinalCltvExpiry: 40,
			privateKey: crypto.randomBytes(32)
		});
		for (const [request, code, detail] of [
			[
				{ invoice: foreign },
				grpc.status.FAILED_PRECONDITION,
				/only an open invoice of this node/
			],
			[
				{
					invoice:
						'lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexejxxepnxscrvwfnv9nxzcn9xq6xyefhvgcxxcmyxymnserxfq5fns'
				},
				grpc.status.INVALID_ARGUMENT,
				/bolt11 invoice of this node/
			],
			[{}, grpc.status.INVALID_ARGUMENT, /amount is required/],
			[
				{ amount: 50_000, wallet_id: 1, send_from_internal: true },
				grpc.status.FAILED_PRECONDITION,
				/internal wallets/
			]
		] as Array<[object, grpc.status, RegExp]>) {
			const err = await rejection(s.call('CreateSwap', request));
			expect(err.code, JSON.stringify(request)).to.equal(code);
			expect(err.details).to.match(detail);
		}
	});

	it('RefundSwap before the height saves the address and says when; the refund pays it', async function () {
		const created = await s.call<CreateSwapResponse>('CreateSwap', {
			amount: 50_000,
			send_from_internal: true
		});
		s.chain.mine(1);
		await waitFor(
			() => s.client.swaps.submarine.get(created.id)!.state === 'FUNDED',
			'funded'
		);
		const script = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 3) })
			.output!;
		const address = bitcoin.address.fromOutputScript(
			script,
			bitcoin.networks.regtest
		);
		const err = await rejection(
			s.call('RefundSwap', { id: created.id, address })
		);
		expect(err.code).to.equal(grpc.status.FAILED_PRECONDITION);
		expect(err.details).to.match(
			/not refundable before block .* address is saved/
		);
		const info = await s.call<GetSwapInfoResponse>('GetSwapInfo', {
			swap_id: created.id
		});
		expect(info.swap!.refund_address).to.equal(address);
		const swap = s.client.swaps.submarine.get(created.id)!;
		s.chain.mine(swap.record().refundHeight - s.chain.height);
		await waitFor(() => swap.state === 'REFUND_BROADCAST', 'refund out');
		const refund = bitcoin.Transaction.fromHex(
			swap.record().refund!.attempts[0].rawHex
		);
		expect(refund.outs[0].script.equals(script)).to.equal(true);
		s.chain.mine(1);
		await waitFor(() => swap.state === 'REFUNDED', 'refunded');
		const done = await s.call<GetSwapInfoResponse>('GetSwapInfo', {
			swap_id: created.id
		});
		expect(done.swap!.state).to.equal('REFUNDED');
		expect(done.swap!.refund_transaction_id).to.equal(refund.getId());
		const missing = await rejection(
			s.call('RefundSwap', { id: 'ff'.repeat(32) })
		);
		expect(missing.code).to.equal(grpc.status.NOT_FOUND);
	});

	it('the read-only macaroon reads without secrets and cannot write; no macaroon is refused', async function () {
		const created = await s.call<CreateSwapResponse>('CreateSwap', {
			amount: 50_000
		});
		const reverse = await s.call<CreateReverseSwapResponse>(
			'CreateReverseSwap',
			{ amount: 100_600, external_pay: true }
		);
		const sub = await s.call<GetSwapInfoResponse>(
			'GetSwapInfo',
			{ swap_id: created.id },
			s.readonly
		);
		expect(sub.swap!.id).to.equal(created.id);
		expect(sub.swap!.private_key).to.equal('');
		const rev = await s.call<GetSwapInfoResponse>(
			'GetSwapInfo',
			{ swap_id: reverse.id },
			s.readonly
		);
		expect(rev.reverse_swap!.private_key).to.equal('');
		expect(rev.reverse_swap!.preimage).to.equal('');
		const listed = await s.call<ListSwapsResponse>('ListSwaps', {}, s.readonly);
		expect(listed.reverse_swaps[0].preimage).to.equal('');
		const asAdmin = await s.call<GetSwapInfoResponse>('GetSwapInfo', {
			swap_id: reverse.id
		});
		expect(asAdmin.reverse_swap!.preimage).to.match(/^[0-9a-f]{64}$/);
		const stream = s.stream(reverse.id, s.readonly);
		await waitFor(() => stream.messages.length > 0, 'a read-only stream');
		expect(stream.messages[0].reverse_swap!.preimage).to.equal('');

		const denied = await rejection(
			s.call('CreateSwap', { amount: 50_000 }, s.readonly)
		);
		expect(denied.code).to.equal(grpc.status.PERMISSION_DENIED);
		const anonymous = await rejection(s.call('GetInfo', {}, null));
		expect(anonymous.code).to.equal(grpc.status.UNAUTHENTICATED);
	});

	it('ListSwaps filters and pages like boltzd; the rest is UNIMPLEMENTED with a reason; Stop stops', async function () {
		const a = await s.call<CreateSwapResponse>('CreateSwap', {
			amount: 20_000
		});
		await new Promise((r) => setTimeout(r, 1_100));
		const b = await s.call<CreateReverseSwapResponse>('CreateReverseSwap', {
			amount: 100_600,
			external_pay: true
		});
		const all = await s.call<ListSwapsResponse>('ListSwaps', {});
		expect(all.swaps.map((x) => x.id)).to.deep.equal([a.id]);
		expect(all.reverse_swaps.map((x) => x.id)).to.deep.equal([b.id]);
		const page = await s.call<ListSwapsResponse>('ListSwaps', {
			unify: true,
			limit: 1
		});
		expect(page.all_swaps.map((x) => x.id)).to.deep.equal([b.id]);
		expect(page.all_swaps[0].type).to.equal('REVERSE');
		const second = await s.call<ListSwapsResponse>('ListSwaps', {
			unify: true,
			offset: 1
		});
		expect(second.all_swaps.map((x) => x.id)).to.deep.equal([a.id]);
		const none = await s.call<ListSwapsResponse>('ListSwaps', {
			state: 'SUCCESSFUL'
		});
		expect(none.swaps ?? []).to.have.length(0);
		const bad = await rejection(s.call('ListSwaps', { limit: 1 }));
		expect(bad.code).to.equal(grpc.status.INVALID_ARGUMENT);

		for (const method of ['CreateWallet', 'CreateChainSwap', 'BakeMacaroon']) {
			const err = await rejection(s.call(method, {}));
			expect(err.code, method).to.equal(grpc.status.UNIMPLEMENTED);
			expect(err.details).to.match(/^roux-boltzd does not implement/);
		}
		const info = await s.call<GetInfoResponse>('GetInfo');
		expect(info.pending_swaps).to.deep.equal([a.id]);
		expect(info.pending_reverse_swaps).to.deep.equal([b.id]);

		await s.call('Stop', {});
		await waitFor(() => s.stops === 1, 'onStop');
	});

	describe('startBoltzDaemon', function () {
		/** The daemon's own config, with the parts it will not use stubbed. */
		const daemonConfig = (dir: string): IBoltzDaemonConfig => ({
			dataDir: dir,
			configFile: path.join(dir, 'boltz.toml'),
			network: 'regtest',
			node: 'lnd',
			rpc: {
				host: '127.0.0.1',
				port: 0,
				tlsCertPath: path.join(dir, 'tls.cert'),
				tlsKeyPath: path.join(dir, 'tls.key'),
				noTls: false,
				noMacaroons: false,
				adminMacaroonPath: path.join(dir, 'macaroons', 'admin.macaroon'),
				readonlyMacaroonPath: path.join(dir, 'macaroons', 'readonly.macaroon')
			},
			bitcoind: { host: '127.0.0.1', port: 1, user: 'u', pass: 'p' },
			provider: `${s.provider.id}@127.0.0.1:9735`,
			storePath: path.join(dir, 'unused.json'),
			policy: {}
		});

		it('resumes stored swaps, mints macaroons, serves, and resolves stopRequested on Stop', async function () {
			// A swap from a previous run, left in the store.
			const created = await s.call<CreateSwapResponse>('CreateSwap', {
				amount: 20_000
			});
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roux-boltzd-'));
			const config = daemonConfig(dir);
			const logs: string[] = [];
			const daemon = await startBoltzDaemon(config, {
				client: s.client,
				chain: s.chain,
				version: 'v-test',
				log: (action) => logs.push(action)
			});
			try {
				expect(daemon.tls).to.equal(false);
				expect(logs).to.include.members([
					'boltz_swaps_resumed',
					'boltz_macaroons_minted',
					'boltz_tls'
				]);
				const admin = fs
					.readFileSync(config.rpc.adminMacaroonPath)
					.toString('hex');
				const rpc = boltzClient(
					`127.0.0.1:${daemon.port}`,
					grpc.credentials.createInsecure()
				);
				const md = new grpc.Metadata();
				md.set('macaroon', admin);
				const info = await new Promise<GetInfoResponse>((resolve, reject) =>
					rpc.GetInfo({}, md, (err: Error | null, res: GetInfoResponse) =>
						err ? reject(err) : resolve(res)
					)
				);
				expect(info.version).to.equal('v-test');
				expect(info.pending_swaps).to.deep.equal([created.id]);
				await new Promise((resolve, reject) =>
					rpc.Stop({}, md, (err: Error | null) =>
						err ? reject(err) : resolve(null)
					)
				);
				await daemon.stopRequested;
				rpc.close();
			} finally {
				await daemon.close();
			}
		});

		it('retries a resume the chain was down for, so no swap is left unattended', async function () {
			// A funded swap the provider never pays, left by a previous run.
			const created = await s.call<CreateSwapResponse>('CreateSwap', {
				amount: 50_000,
				send_from_internal: true
			});
			s.chain.mine(1);
			await waitFor(
				() => s.client.swaps.submarine.get(created.id)!.state === 'FUNDED',
				'funded'
			);
			const refundHeight = s.client.swaps.submarine
				.get(created.id)!
				.record().refundHeight;
			await s.client.close();

			// A fresh client over the same store, as a restart would build.
			const restarted = new BeignetClient({
				link: s.link,
				network: 'regtest',
				storage: s.storage,
				swaps: {
					payer: s.payer,
					funder: s.funder,
					chain: s.chain,
					policy: { statusPollMs: 0, chainPollMs: 5, replyTimeoutMs: 500 }
				}
			});
			// Bitcoin Core is down while the daemon starts.
			const height = s.chain.currentHeight.bind(s.chain);
			let down = true;
			s.chain.currentHeight = async (): Promise<number> => {
				if (down) throw new Error('bitcoind is down');
				return height();
			};
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roux-boltzd-'));
			const logs: Array<Record<string, unknown>> = [];
			const daemon = await startBoltzDaemon(daemonConfig(dir), {
				client: restarted,
				chain: s.chain,
				resumeRetryMs: 20,
				log: (action, data) => logs.push({ action, ...data })
			});
			try {
				const resumed = logs.filter((l) => l.action === 'boltz_swaps_resumed');
				expect(resumed).to.have.length(1);
				expect((resumed[0].errors as unknown[]).length).to.be.greaterThan(0);
				// The swap is past its refund height and nobody is driving it.
				s.chain.height = refundHeight + 1;
				await new Promise((r) => setTimeout(r, 50));
				expect(s.chain.broadcasts).to.have.length(0);

				// Core comes back: the retry resumes it, and the loop refunds.
				down = false;
				await waitFor(
					() =>
						restarted.swaps.submarine.get(created.id)!.state ===
						'REFUND_BROADCAST',
					'the retried resume drives the refund',
					10_000
				);
			} finally {
				s.chain.currentHeight = height;
				await daemon.close();
			}
		});
	});
});
