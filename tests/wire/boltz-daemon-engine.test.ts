/**
 * roux-boltzd over gRPC against beignet's REAL submarine provider engine
 * over Noise TCP: the Lightning amount a boltz client asks for is the
 * invoice the engine pays, to the satoshi, under the engine's own fee
 * schedule (flat, ppm, miner and the routing budget it charges on the net
 * amount); the engine pays and claims, and boltzrpc reports SUCCESSFUL.
 */

import { expect } from 'chai';
import * as grpc from '@grpc/grpc-js';
import {
	BoltzService,
	RpcAuth,
	boltzClient,
	startBoltzServer
} from '../../src/boltz';
import type {
	CreateSwapResponse,
	GetSwapInfoResponse,
	GetSwapQuoteResponse,
	PairInfo
} from '../../src/boltz';
import { waitFor } from '../helpers';
import {
	ClientChainView,
	teardown,
	wireScene
} from '../swaps/submarine-engine-harness';

describe("roux-boltzd against beignet's real submarine engine over Noise TCP", function () {
	this.timeout(60_000);

	it('CreateSwap lands the exact Lightning amount; the engine pays and claims; SUCCESSFUL', async function () {
		const s = await wireScene('boltzd');
		const service = new BoltzService({
			client: s.client,
			chain: new ClientChainView(s.chain),
			provider: s.peer.idHex,
			network: 'regtest'
		});
		const auth = new RpcAuth({
			noMacaroons: true,
			adminMacaroonPath: '',
			readonlyMacaroonPath: ''
		});
		auth.init();
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
		const call = <T>(method: string, request: object): Promise<T> =>
			new Promise<T>((resolve, reject) =>
				rpc[method](request, (err: Error | null, res: T) =>
					err ? reject(err) : resolve(res)
				)
			);
		try {
			const quote = await call<GetSwapQuoteResponse>('GetSwapQuote', {
				type: 'SUBMARINE',
				receive_amount: 99_000
			});
			expect(quote.receive_amount).to.equal(99_000);
			expect(quote.send_amount - quote.boltz_fee - quote.network_fee).to.equal(
				99_000
			);

			const created = await call<CreateSwapResponse>('CreateSwap', {
				amount: 99_000,
				send_from_internal: true
			});
			expect(created.tx_id).to.match(/^[0-9a-f]{64}$/);
			expect(created.expected_amount).to.equal(quote.send_amount);
			const swap = s.client.swaps.submarine.get(created.id)!;
			const rec = swap.record();
			// The invoice the engine will pay is the amount asked for, exactly.
			expect(rec.invoiceAmountMsat).to.equal('99000000');
			expect(s.ledger.list()[0].bolt11).to.equal(rec.bolt11);

			await waitFor(() => swap.state === 'FUNDING', 'client funded', 10_000);
			await s.engine.onBlock(s.chain.height);
			s.chain.height += 1;
			s.chain.confirm(swap.record().funding!.txidHex, s.chain.height);
			await s.engine.onBlock(s.chain.height);
			expect(s.ledger.list()[0].state).to.equal('CLAIM_BROADCAST');
			expect(s.rail.payCalls).to.have.length(1);
			swap.poke();
			await waitFor(() => swap.state === 'SETTLED', 'client settled', 10_000);

			const info = await call<GetSwapInfoResponse>('GetSwapInfo', {
				swap_id: created.id
			});
			expect(info.swap!.state).to.equal('SUCCESSFUL');
			expect(info.swap!.preimage).to.equal(s.ledger.list()[0].preimageHex);
			expect(info.swap!.lockup_transaction_id).to.equal(created.tx_id);
			expect(info.swap!.service_fee! + info.swap!.onchain_fee!).to.equal(
				created.expected_amount - 99_000
			);
		} finally {
			rpc.close();
			await server.close(200);
			await teardown(s);
		}
	});

	it('advertises limits the engine honours, its routing budget included', async function () {
		const s = await wireScene('limits');
		const service = new BoltzService({
			client: s.client,
			chain: new ClientChainView(s.chain),
			provider: s.peer.idHex,
			network: 'regtest'
		});
		const auth = new RpcAuth({
			noMacaroons: true,
			adminMacaroonPath: '',
			readonlyMacaroonPath: ''
		});
		auth.init();
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
		const call = <T>(method: string, request: object): Promise<T> =>
			new Promise<T>((resolve, reject) =>
				rpc[method](request, (err: Error | null, res: T) =>
					err ? reject(err) : resolve(res)
				)
			);
		try {
			// The engine charges 50 flat, 2000 ppm, a 300 sat miner fee and a
			// 1000 ppm routing budget on the net amount: 380 sat at its 10 000
			// sat minimum, which with roux's 100 sat slack leaves 9 520. No fee
			// formula outside the engine knows that budget.
			const pair = await call<PairInfo>('GetPairInfo', { type: 'SUBMARINE' });
			expect(pair.limits.minimal).to.equal(9_520);
			const quote = await call<GetSwapQuoteResponse>('GetSwapQuote', {
				type: 'SUBMARINE',
				send_amount: 10_000
			});
			expect(quote.receive_amount).to.equal(9_520);
			expect(quote.boltz_fee + quote.network_fee).to.equal(480);
			// The advertised minimum is creatable, though the fee probes for it
			// start below the engine's own minimum.
			const smallest = await call<CreateSwapResponse>('CreateSwap', {
				amount: pair.limits.minimal
			});
			expect(smallest.expected_amount).to.equal(10_000);
			expect(
				s.client.swaps.submarine.get(smallest.id)!.record().invoiceAmountMsat
			).to.equal('9520000');
		} finally {
			rpc.close();
			await server.close(200);
			await teardown(s);
		}
	});
});
