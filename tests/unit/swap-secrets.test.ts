/**
 * Swap secrets kept out of the records: the seed file and its derivation,
 * a reverse swap that claims with a key it never wrote down, a submarine
 * swap that refunds with one, and what happens to such a record on a host
 * that cannot derive it (a missing provider, or the wrong seed).
 */

import crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect } from 'chai';
import * as bitcoin from 'bitcoinjs-lib';
import { crypto as bcrypto } from 'beignet/lightning';
import {
	FileSecretProvider,
	ISwapSecretProvider,
	MemoryStorage,
	SwapClient,
	SwapError
} from '../../src';
import {
	REVERSE_SWAP_STORAGE_KEY,
	SUBMARINE_SWAP_STORAGE_KEY
} from '../../src/swaps/store';
import { FakeProvider } from '../swaps/fake-provider';
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
	/** A restart: the same storage, with or without the same seam. */
	reopen(secrets?: ISwapSecretProvider): SwapClient;
}

let tmpDir: string;

function seedFile(name = 'seed'): string {
	return path.join(tmpDir, `${name}-${crypto.randomBytes(4).toString('hex')}`);
}

function scene(secrets?: ISwapSecretProvider): IScene {
	const { client: clientLink, provider: providerLink } = linkPair();
	const provider = new FakeProvider(providerLink);
	const chain = new MockChain();
	const storage = new MemoryStorage();
	const payer = new FakePayer(storage);
	const funder = new FakeFunder(chain, storage);
	const logs: string[] = [];
	// No default for the parameter: `reopen()` must mean "no seam this time".
	const make = (withSecrets: ISwapSecretProvider | undefined): SwapClient =>
		new SwapClient({
			link: clientLink,
			network: 'regtest',
			payer,
			funder,
			chain,
			storage,
			secrets: withSecrets,
			policy: {
				statusPollMs: 0,
				chainPollMs: 5,
				replyTimeoutMs: 500,
				minRefundDeltaBlocks: 30,
				claimSafetyBlocks: 6,
				routeBudgetBlocks: 6,
				invoiceFinalCltvBlocks: 40
			},
			log: (action) => logs.push(action)
		});
	return {
		client: make(secrets),
		provider,
		chain,
		payer,
		funder,
		storage,
		logs,
		reopen: (withSecrets?: ISwapSecretProvider) => make(withSecrets)
	};
}

function rawReverse(s: IScene): string {
	return s.storage.loadWalletData(REVERSE_SWAP_STORAGE_KEY)!;
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

describe('swap secrets', function () {
	before(function () {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roux-secrets-'));
	});

	after(function () {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('FileSecretProvider', function () {
		it('creates the seed with mode 0600 and derives the same secrets from it forever', function () {
			const file = seedFile();
			const provider = new FileSecretProvider(file);
			const idHex = crypto.randomBytes(16).toString('hex');
			const preimage = provider.derivePreimage(idHex);
			const claimKey = provider.deriveClaimKey(idHex);
			const refundKey = provider.deriveRefundKey(idHex);
			expect(provider.id).to.equal('file');
			expect(preimage).to.have.length(32);
			expect(bcrypto.isValidPrivateKey(claimKey)).to.equal(true);
			expect(bcrypto.isValidPrivateKey(refundKey)).to.equal(true);
			// One role per secret, one secret per swap.
			expect(claimKey.toString('hex')).to.not.equal(refundKey.toString('hex'));
			expect(preimage.toString('hex')).to.not.equal(claimKey.toString('hex'));
			const other = crypto.randomBytes(16).toString('hex');
			expect(provider.derivePreimage(other).toString('hex')).to.not.equal(
				preimage.toString('hex')
			);
			// The file, not the instance, is what the derivation depends on.
			expect(fs.statSync(file).mode & 0o777).to.equal(0o600);
			const reread = new FileSecretProvider(file);
			expect(reread.derivePreimage(idHex).toString('hex')).to.equal(
				preimage.toString('hex')
			);
			expect(reread.deriveClaimKey(idHex).toString('hex')).to.equal(
				claimKey.toString('hex')
			);
			// A different seed, the same id: different secrets.
			const elsewhere = new FileSecretProvider(seedFile());
			expect(elsewhere.deriveClaimKey(idHex).toString('hex')).to.not.equal(
				claimKey.toString('hex')
			);
		});

		it('refuses a seed anyone on the box can read, a short one, and an id of the wrong size', function () {
			const wide = seedFile();
			fs.writeFileSync(wide, crypto.randomBytes(32).toString('hex'), {
				mode: 0o644
			});
			const idHex = crypto.randomBytes(16).toString('hex');
			expect(() => new FileSecretProvider(wide).derivePreimage(idHex))
				.to.throw(SwapError)
				.with.property('code', 'secrets');
			const short = seedFile();
			fs.writeFileSync(short, 'abcd', { mode: 0o600 });
			expect(() => new FileSecretProvider(short).derivePreimage(idHex))
				.to.throw(SwapError)
				.with.property('code', 'secrets');
			expect(() => new FileSecretProvider(seedFile()).derivePreimage('00'))
				.to.throw(SwapError)
				.with.property('code', 'secrets');
		});

		it('takes the seed of whoever created the file first', function () {
			const file = seedFile();
			const a = new FileSecretProvider(file);
			const b = new FileSecretProvider(file);
			const idHex = crypto.randomBytes(16).toString('hex');
			const first = a.derivePreimage(idHex);
			expect(b.derivePreimage(idHex).toString('hex')).to.equal(
				first.toString('hex')
			);
		});
	});

	describe('a reverse swap whose secrets the host derives', function () {
		it('records the id and the public material only, and claims with the derived key', async function () {
			const file = seedFile();
			const s = scene(new FileSecretProvider(file));
			const swap = await s.client.reverse.create(s.provider.id, {
				amountSat: 100_000
			});
			const rec = swap.record();
			expect(rec.preimageHex).to.equal(undefined);
			expect(rec.claimPrivkeyHex).to.equal(undefined);
			expect(rec.secrets).to.deep.equal({
				provider: 'file',
				idHex: rec.secrets!.idHex
			});
			expect(rec.secrets!.idHex).to.have.length(32);
			// Nothing secret is in the bytes on disk: the preimage the provider
			// derives for this id appears nowhere in the document.
			const preimage = new FileSecretProvider(file).derivePreimage(
				rec.secrets!.idHex
			);
			expect(rawReverse(s)).to.not.contain(preimage.toString('hex'));
			expect(
				crypto.createHash('sha256').update(preimage).digest('hex')
			).to.equal(rec.paymentHashHex);

			// The claim is signed from the seed and spends the contract.
			void swap.pay();
			s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
			await swap.tick();
			expect(swap.state).to.equal('CLAIM_BROADCAST');
			const claim = bitcoin.Transaction.fromHex(
				swap.record().claim!.attempts[0].rawHex!
			);
			expect(claim.ins[0].witness[1].toString('hex')).to.equal(
				preimage.toString('hex')
			);
			s.payer.settle(rec.paymentHashHex, preimage);
			s.chain.mine(1);
			await swap.tick();
			expect(swap.state).to.equal('CLAIMED');
		});

		it('keeps the claim bytes off the record until a broadcast publishes them', async function () {
			const file = seedFile();
			const s = scene(new FileSecretProvider(file));
			const swap = await s.client.reverse.create(s.provider.id, {
				amountSat: 100_000
			});
			const preimage = new FileSecretProvider(file).derivePreimage(
				swap.record().secrets!.idHex
			);
			void swap.pay();
			s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
			s.chain.failNextBroadcasts = 1;
			await swap.tick();
			// The claim is signed and its witness carries the preimage, but the
			// broadcast failed: nothing disclosed it, so nothing wrote it down.
			expect(swap.state).to.equal('CLAIM_BROADCAST');
			expect(swap.record().claim!.attempts[0].rawHex).to.equal(undefined);
			expect(rawReverse(s)).to.not.contain(preimage.toString('hex'));
			// Out on the second try: now the bytes are a receipt, and kept.
			await swap.tick();
			expect(s.chain.broadcasts).to.have.length(1);
			expect(rawReverse(s)).to.contain(preimage.toString('hex'));
		});

		it('resumes from the record when the same seam is there, and refuses it when it is not', async function () {
			const file = seedFile();
			const s = scene(new FileSecretProvider(file));
			const swap = await s.client.reverse.create(s.provider.id, {
				amountSat: 100_000
			});
			void swap.pay();
			s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });

			// A restart with no provider: reported, and nothing is signed.
			const blind = await s.reopen().reverse.resume({ run: true });
			expect(blind.resumed).to.have.length(0);
			expect(blind.errors).to.have.length(1);
			expect(blind.errors[0].swapIdHex).to.equal(swap.swapIdHex);
			expect(blind.errors[0].error).to.match(/"file".*was not given/);
			expect(s.chain.broadcasts).to.have.length(0);

			// A restart with a provider under another name: the same refusal.
			const renamed = await s
				.reopen(new FileSecretProvider(file, { id: 'wallet' }))
				.reverse.resume();
			expect(renamed.errors[0].error).to.match(/but swaps.secrets is "wallet"/);
			expect(s.chain.broadcasts).to.have.length(0);

			// The seam it was created with: the claim goes out.
			const report = await s
				.reopen(new FileSecretProvider(file))
				.reverse.resume();
			expect(report.errors).to.have.length(0);
			expect(report.resumed[0].state).to.equal('CLAIM_BROADCAST');
			expect(s.chain.broadcasts).to.have.length(1);
		});

		it('refuses to sign with a seed that derives some other swap', async function () {
			const s = scene(new FileSecretProvider(seedFile()));
			const swap = await s.client.reverse.create(s.provider.id, {
				amountSat: 100_000
			});
			void swap.pay();
			s.provider.fund(s.chain, swap.swapIdHex, { height: 1000 });
			// Same provider name, another seed: the derivation is valid and
			// useless, and the preimage it gives does not hash to ours. The
			// pass that would have claimed fails instead of signing.
			const wrong = s.reopen(new FileSecretProvider(seedFile()));
			const err = await failure(wrong.reverse.get(swap.swapIdHex)!.tick());
			expect(err.code).to.equal('secrets');
			expect(err.message).to.match(/payment hash/);
			expect(s.chain.broadcasts).to.have.length(0);
		});

		it('refuses a claim key or preimage the caller supplies, since it could not be derived again', async function () {
			const s = scene(new FileSecretProvider(seedFile()));
			const supplied = await failure(
				s.client.reverse.create(s.provider.id, {
					amountSat: 100_000,
					preimage: crypto.randomBytes(32)
				})
			);
			expect(supplied.code).to.equal('policy');
			expect(supplied.message).to.match(/swaps.secrets/);
			expect(s.provider.received).to.have.length(0);
		});
	});

	describe('a submarine swap whose refund key the host derives', function () {
		it('records the id only, and refunds with the derived key', async function () {
			const file = seedFile();
			const s = scene(new FileSecretProvider(file));
			const swap = await s.client.submarine.create(s.provider.id, {
				amountSat: 100_000
			});
			const rec = swap.record();
			expect(rec.refundPrivkeyHex).to.equal(undefined);
			expect(rec.secrets!.provider).to.equal('file');
			const refundKey = new FileSecretProvider(file).deriveRefundKey(
				rec.secrets!.idHex
			);
			expect(bcrypto.getPublicKey(refundKey).toString('hex')).to.equal(
				rec.refundPubkeyHex
			);
			expect(
				s.storage.loadWalletData(SUBMARINE_SWAP_STORAGE_KEY)!
			).to.not.contain(refundKey.toString('hex'));

			await swap.fund();
			s.chain.mine(1);
			await swap.tick();
			expect(swap.state).to.equal('FUNDED');
			s.chain.mine(rec.refundHeight - s.chain.height);
			await swap.tick();
			expect(swap.state).to.equal('REFUND_BROADCAST');
			const refund = bitcoin.Transaction.fromHex(
				swap.record().refund!.attempts[0].rawHex!
			);
			const funding = swap.record().funding!;
			expect(
				Buffer.from(refund.ins[0].hash).reverse().toString('hex')
			).to.equal(funding.txidHex);
			expect(s.chain.broadcasts).to.deep.equal([refund.getId()]);
		});

		it('refuses to fund when the seed does not derive the refund key on the record', async function () {
			const s = scene(new FileSecretProvider(seedFile()));
			const swap = await s.client.submarine.create(s.provider.id, {
				amountSat: 100_000
			});
			// Another seed under the same name: resume() cannot tell the two
			// apart, so the refund key has to, before the coins go out.
			const wrong = s.reopen(new FileSecretProvider(seedFile()));
			const report = await wrong.submarine.resume({ fund: true });
			expect(report.errors).to.have.length(0);
			const err = await failure(wrong.submarine.get(swap.swapIdHex)!.fund());
			expect(err.code).to.equal('secrets');
			expect(err.message).to.match(/refund key/);
			expect(s.funder.calls).to.have.length(0);
			expect(
				wrong.submarine.get(swap.swapIdHex)!.record().fundingAttempt
			).to.equal(undefined);
		});

		it('refuses a record whose provider this client was not given, and a supplied refund key', async function () {
			const s = scene(new FileSecretProvider(seedFile()));
			const swap = await s.client.submarine.create(s.provider.id, {
				amountSat: 100_000
			});
			await swap.fund();
			const report = await s.reopen().submarine.resume({ run: true });
			expect(report.resumed).to.have.length(0);
			expect(report.errors[0].swapIdHex).to.equal(swap.swapIdHex);
			expect(report.errors[0].error).to.match(/"file".*was not given/);
			const supplied = await failure(
				s.client.submarine.create(s.provider.id, {
					amountSat: 100_000,
					refundKey: crypto.randomBytes(32)
				})
			);
			expect(supplied.code).to.equal('policy');
		});
	});

	it('versions the document 2 once a record names a provider, 1 while none does', async function () {
		const version = (raw: string): number =>
			(JSON.parse(raw) as { version: number }).version;
		const plain = scene();
		await plain.client.reverse.create(plain.provider.id, {
			amountSat: 100_000
		});
		expect(version(rawReverse(plain))).to.equal(1);
		// A roux from before the seam reads version 1 only. It has to refuse
		// the document: a keyless record looks to it like one whose key went
		// missing, and it would fund a swap it could never refund.
		const s = scene(new FileSecretProvider(seedFile()));
		await s.client.reverse.create(s.provider.id, { amountSat: 100_000 });
		expect(version(rawReverse(s))).to.equal(2);
	});

	it('without the seam the records still hold the secrets', async function () {
		const s = scene();
		const swap = await s.client.reverse.create(s.provider.id, {
			amountSat: 100_000
		});
		const rec = swap.record();
		expect(rec.secrets).to.equal(undefined);
		expect(rec.preimageHex).to.have.length(64);
		expect(rec.claimPrivkeyHex).to.have.length(64);
		expect(rawReverse(s)).to.contain(rec.preimageHex!);
	});
});
