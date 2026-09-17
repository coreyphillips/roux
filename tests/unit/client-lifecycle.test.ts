/**
 * The client's guarantees around records: fund-moving calls refuse
 * defaulted in-process storage, a damaged swap document is kept and
 * reported rather than read as empty, state changes are announced, and
 * shutdown waits for the pass in flight.
 */

import { expect } from 'chai';
import {
	BeignetClient,
	EphemeralStorageError,
	MemoryStorage,
	ReverseSwapStore,
	createClnClient,
	createLndClient,
	isEphemeralStorage
} from '../../src';
import { REVERSE_SWAP_STORAGE_KEY } from '../../src/swaps/store';
import { IWalletDataStorage } from '../../src/storage';
import { linkPair } from '../swaps/fake-link';
import { FakeProvider } from '../swaps/fake-provider';
import { MockChain } from '../swaps/mock-chain';
import { FakePayer } from '../swaps/fake-payer';

describe('BeignetClient records and lifecycle', function () {
	it('refuses to move funds on storage nobody chose, unless told that is intended', async function () {
		const { client: link, provider: providerLink } = linkPair();
		const provider = new FakeProvider(providerLink);
		const chain = new MockChain();
		const payer = new FakePayer(new MemoryStorage());
		const defaulted = new BeignetClient({
			link,
			network: 'regtest',
			swaps: { payer, chain, policy: { replyTimeoutMs: 200 } }
		});
		let refused: unknown;
		try {
			await defaulted.swaps.reverse.create(provider.id, { amountSat: 100_000 });
		} catch (err) {
			refused = err;
		}
		expect(refused).to.be.instanceOf(EphemeralStorageError);
		expect(String((refused as Error).message)).to.match(
			/allowEphemeralStorage/
		);
		// Nothing reached the provider.
		expect(provider.swaps.size).to.equal(0);

		const allowed = new BeignetClient({
			link,
			network: 'regtest',
			allowEphemeralStorage: true,
			swaps: { payer, chain, policy: { replyTimeoutMs: 500 } }
		});
		const swap = await allowed.swaps.reverse.create(provider.id, {
			amountSat: 100_000
		});
		expect(swap.state).to.equal('CREATED');

		// Storage the caller chose is theirs to judge, memory included.
		const chosen = new BeignetClient({
			link,
			network: 'regtest',
			storage: new MemoryStorage(),
			swaps: { payer, chain, policy: { replyTimeoutMs: 500 } }
		});
		const second = await chosen.swaps.reverse.create(provider.id, {
			amountSat: 50_000
		});
		expect(second.state).to.equal('CREATED');
		expect(isEphemeralStorage(new MemoryStorage())).to.equal(true);
		await allowed.close();
		await chosen.close();
	});

	it('keeps a damaged swap document under a dated key and refuses to read it as empty', function () {
		const saved = new Map<string, string>();
		const storage: IWalletDataStorage = {
			saveWalletData: (k, v) => {
				saved.set(k, v);
			},
			loadWalletData: (k) => saved.get(k) ?? null
		};
		saved.set(REVERSE_SWAP_STORAGE_KEY, '{"version":1,"swaps":"not a map"');
		const store = new ReverseSwapStore(storage);
		let thrown: unknown;
		try {
			store.restore();
		} catch (err) {
			thrown = err;
		}
		expect((thrown as { code?: string }).code).to.equal('storage');
		const kept = [...saved.keys()].find((k) =>
			k.startsWith(`${REVERSE_SWAP_STORAGE_KEY}.damaged.`)
		);
		expect(kept).to.be.a('string');
		expect(saved.get(kept!)).to.equal('{"version":1,"swaps":"not a map"');
		// The original is untouched: nothing wrote over it.
		expect(saved.get(REVERSE_SWAP_STORAGE_KEY)).to.equal(
			'{"version":1,"swaps":"not a map"'
		);
		// The same for a document of a version this roux does not know.
		saved.clear();
		saved.set(
			REVERSE_SWAP_STORAGE_KEY,
			JSON.stringify({ version: 3, swaps: {} })
		);
		expect(() => new ReverseSwapStore(storage).restore()).to.throw(/version 1/);
	});

	it('announces every persisted state change and close() waits for the pass in flight', async function () {
		const { client: link, provider: providerLink } = linkPair();
		const provider = new FakeProvider(providerLink);
		const chain = new MockChain();
		const storage = new MemoryStorage();
		const payer = new FakePayer(storage);
		const client = new BeignetClient({
			link,
			network: 'regtest',
			storage,
			swaps: {
				payer,
				chain,
				policy: { replyTimeoutMs: 500, chainPollMs: 5, statusPollMs: 0 }
			}
		});
		const changes: string[] = [];
		const off = client.swaps.reverse.onChange((c) =>
			changes.push(`${c.from}>${c.to}`)
		);
		const swap = await client.swaps.reverse.create(provider.id, {
			amountSat: 100_000
		});
		void swap.pay();
		await new Promise((r) => setTimeout(r, 10));
		provider.fund(chain, swap.swapIdHex, { height: 1000 });
		await swap.tick();
		expect(changes).to.deep.equal([
			'CREATED>PAYING',
			'PAYING>FUNDED',
			'FUNDED>CLAIM_BROADCAST'
		]);
		off();
		// A slow chain read holds a pass open; close() returns after it.
		let releaseHeight: () => void = () => undefined;
		const original = chain.currentHeight.bind(chain);
		chain.currentHeight = () =>
			new Promise<number>((resolve) => {
				releaseHeight = () => resolve(original());
			});
		const running = swap.run();
		await new Promise((r) => setTimeout(r, 10));
		let closed = false;
		const closing = client.close().then(() => {
			closed = true;
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(closed).to.equal(false);
		chain.currentHeight = original;
		releaseHeight();
		await closing;
		expect(closed).to.equal(true);
		await running;
		expect(changes).to.have.length(3);
	});

	it('the setup helpers wire one node as link, wallet and payer without contacting it', function () {
		const lnd = createLndClient({
			host: '127.0.0.1',
			port: 8080,
			macaroonHex: 'ab',
			network: 'regtest',
			storage: new MemoryStorage()
		});
		expect(() => lnd.directFunding).to.not.throw();
		expect(() => lnd.swaps).to.not.throw();
		const cln = createClnClient({
			host: '127.0.0.1',
			rune: 'r',
			network: 'regtest',
			allowEphemeralStorage: true
		});
		expect(() => cln.directFunding).to.not.throw();
		expect(() => cln.swaps).to.not.throw();
	});
});
