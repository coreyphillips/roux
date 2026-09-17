/**
 * roux against a REAL beignet LSP over TCP.
 *
 * The LSP is beignet's own LightningNode with JIT receive switched on,
 * listening on a loopback port. roux dials it with a standalone Noise
 * link (an identity the LSP has never seen), and the quote and the intent
 * registration go over the wire exactly as they would from a beignet
 * wallet: the LSP cannot tell the difference, and its intent ledger names
 * roux's key as the wallet.
 */

import { expect } from 'chai';
import { crypto as lnCrypto, invoice, node as lnNode } from 'beignet/lightning';
import {
	BeignetClient,
	JIT_HINT_CLTV_DELTA,
	JIT_MIN_FINAL_CLTV_EXPIRY,
	JitDeclinedError,
	NoisePeerLink,
	formatNodeUri
} from '../../src';
import { freePort, sha } from '../helpers';

type NodeConfig = ConstructorParameters<typeof lnNode.LightningNode>[0];
type JitConfig = NonNullable<NodeConfig['jitReceive']>;

function makeBasepoints(seed: Buffer): NodeConfig['channelBasepoints'] {
	const key = (i: number): Buffer => sha(seed, Buffer.from([i]));
	return {
		fundingPubkey: lnCrypto.getPublicKey(key(0)),
		revocationBasepoint: lnCrypto.getPublicKey(key(1)),
		paymentBasepoint: lnCrypto.getPublicKey(key(2)),
		delayedPaymentBasepoint: lnCrypto.getPublicKey(key(3)),
		htlcBasepoint: lnCrypto.getPublicKey(key(4)),
		firstPerCommitmentPoint: Buffer.alloc(33)
	};
}

async function startLsp(
	label: string,
	jit: Partial<JitConfig>
): Promise<{ lsp: lnNode.LightningNode; uri: string; pubkey: string }> {
	const seed = sha(`roux-jit-${label}`);
	const lsp = new lnNode.LightningNode({
		nodePrivateKey: sha(seed, 'identity'),
		channelBasepoints: makeBasepoints(seed),
		perCommitmentSeed: sha(seed, 'per-commitment'),
		fundingPrivkey: sha(seed, Buffer.from([0])),
		htlcBasepointSecret: sha(seed, Buffer.from([4])),
		network: invoice.Network.REGTEST,
		enableNetworking: true,
		jitReceive: { enabled: true, ...jit }
	});
	lsp.on('error', () => {});
	lsp.on('node:error', () => {});
	const port = await freePort();
	await lsp.listen(port, '127.0.0.1');
	const pubkey = lsp.getNodeId();
	return { lsp, uri: formatNodeUri(pubkey, '127.0.0.1', port), pubkey };
}

describe('JIT inbound liquidity against a real beignet LSP over TCP', function () {
	this.timeout(60_000);

	let feeLsp: Awaited<ReturnType<typeof startLsp>>;
	let freeLsp: Awaited<ReturnType<typeof startLsp>>;

	before(async () => {
		feeLsp = await startLsp('fee', {
			flatFeeSat: 500n,
			feePpm: 1_000,
			maxClientFundingSats: 2_000_000n
		});
		freeLsp = await startLsp('free', {
			flatFeeSat: 0n,
			feePpm: 0,
			maxClientFundingSats: 2_000_000n
		});
	});

	after(() => {
		feeLsp.lsp.destroy();
		freeLsp.lsp.destroy();
	});

	it('connects with an ephemeral identity and gets a priced quote', async () => {
		const link = new NoisePeerLink({ network: 'regtest' });
		const client = new BeignetClient({ link, network: 'regtest' });
		try {
			const peer = await client.connect(feeLsp.uri);
			expect(peer.pubkeyHex).to.equal(feeLsp.pubkey);
			expect(client.isConnected(feeLsp.pubkey)).to.equal(true);
			// The LSP sees us as a connected peer of its own.
			expect(feeLsp.lsp.listPeers().map((p) => p.pubkey)).to.include(
				client.nodeIdHex()
			);

			const quote = await client.jit.quote(feeLsp.pubkey, {
				maxAmountSat: 100_000
			});
			expect(quote.accepted).to.equal(true);
			expect(quote.flatFeeSat).to.equal(500n);
			expect(quote.feePpm).to.equal(1_000);
			// 500 sat flat + 0.1% of 100 000 sat.
			expect(quote.feeSats).to.equal(600n);
			expect(quote.fundingSats > 0n).to.equal(true);
			expect(quote.withinCeilings).to.equal(true);
			// Quotes register nothing.
			expect(feeLsp.lsp.getJitReceiveManager()!.listIntents()).to.have.length(
				0
			);
		} finally {
			await client.close();
		}
	});

	it('registers an intent and hands back the invoice hint the LSP will intercept', async () => {
		const link = new NoisePeerLink({
			network: 'regtest',
			privateKey: sha('roux-wallet-key')
		});
		const client = new BeignetClient({ link, network: 'regtest' });
		try {
			await client.connect(feeLsp.uri);
			const grant = await client.jit.authorize(feeLsp.pubkey, {
				maxAmountSat: 100_000,
				expectedTotalSat: 100_000,
				acceptsSkimmedFee: true
			});
			expect(grant.lspPubkeyHex).to.equal(feeLsp.pubkey);
			expect(grant.interceptScid).to.have.length(8);
			// Every intercept scid sits at the synthetic block height.
			expect(grant.interceptScidParts.block).to.equal(0xffffff);
			expect(grant.routeHint).to.deep.equal({
				pubkeyHex: feeLsp.pubkey,
				shortChannelIdHex: grant.interceptScidHex,
				feeBaseMsat: 0,
				feeProportionalMillionths: 0,
				cltvExpiryDelta: JIT_HINT_CLTV_DELTA
			});
			expect(grant.minFinalCltvExpiry).to.equal(JIT_MIN_FINAL_CLTV_EXPIRY);
			expect(grant.flatFeeSat).to.equal(500n);
			expect(grant.feePpm).to.equal(1_000);
			expect(grant.openingFeeSats(100_000)).to.equal(600n);
			expect(grant.lndHopHint()).to.deep.equal({
				node_id: feeLsp.pubkey,
				chan_id: grant.interceptScid.readBigUInt64BE(0).toString(10),
				fee_base_msat: 0,
				fee_proportional_millionths: 0,
				cltv_expiry_delta: JIT_HINT_CLTV_DELTA
			});
			expect(grant.clnShortChannelId()).to.match(/^16777215x\d+x\d+$/);

			// The LSP's ledger names roux's key as the wallet it will open to.
			const intents = feeLsp.lsp.getJitReceiveManager()!.listIntents();
			const ours = intents.find(
				(i) => i.interceptScidHex === grant.interceptScidHex
			);
			expect(ours, 'the LSP did not record the intent').to.not.equal(undefined);
			expect(ours!.walletPubkeyHex).to.equal(client.nodeIdHex());
			expect(ours!.maxAmountMsat).to.equal(100_000_000n);
			expect(ours!.expectedTotalMsat).to.equal(100_000_000n);
			expect(ours!.acceptsSkimmedFee).to.equal(true);
		} finally {
			await client.close();
		}
	});

	it('a fee-charging LSP serves a wallet that cannot settle a skimmed HTLC in hop mode', async () => {
		const link = new NoisePeerLink({ network: 'regtest' });
		const client = new BeignetClient({ link, network: 'regtest' });
		try {
			await client.connect(feeLsp.uri);
			const grant = await client.jit.authorize(feeLsp.pubkey, {
				maxAmountSat: 50_000
			});
			expect(grant.feeMode).to.equal('hop');
			// The fee is in the hint, as a routing fee the sender pays.
			expect(grant.routeHint.feeBaseMsat).to.equal(500_000);
			expect(grant.routeHint.feeProportionalMillionths).to.equal(1_000);
			expect(grant.lndHopHint().fee_base_msat).to.equal(500_000);
			expect(grant.lndHopHint().fee_proportional_millionths).to.equal(1_000);
			expect(grant.openingFeeSats(50_000)).to.equal(550n);
			const intent = feeLsp.lsp
				.getJitReceiveManager()!
				.listIntents()
				.find((i) => i.interceptScidHex === grant.interceptScidHex)!;
			expect(intent.feeMode).to.equal('hop');
			expect(intent.acceptsSkimmedFee).to.equal(false);
		} finally {
			await client.close();
		}
	});

	it('a skim-accepting wallet gets skim mode and a zero-fee hint', async () => {
		const link = new NoisePeerLink({ network: 'regtest' });
		const client = new BeignetClient({ link, network: 'regtest' });
		try {
			await client.connect(feeLsp.uri);
			const grant = await client.jit.authorize(feeLsp.pubkey, {
				maxAmountSat: 50_000,
				acceptsSkimmedFee: true
			});
			expect(grant.feeMode).to.equal('skim');
			expect(grant.routeHint.feeBaseMsat).to.equal(0);
			expect(grant.routeHint.feeProportionalMillionths).to.equal(0);
		} finally {
			await client.close();
		}
	});

	it('a zero-fee LSP serves a wallet that cannot settle a skimmed HTLC', async () => {
		const link = new NoisePeerLink({ network: 'regtest' });
		const client = new BeignetClient({ link, network: 'regtest' });
		try {
			await client.connect(freeLsp.uri);
			const grant = await client.jit.authorize(freeLsp.pubkey, {
				maxAmountSat: 50_000
			});
			expect(grant.flatFeeSat).to.equal(0n);
			expect(grant.feePpm).to.equal(0);
			expect(grant.feeMode).to.equal('skim');
			expect(grant.routeHint.feeBaseMsat).to.equal(0);
			expect(grant.openingFeeSats(50_000)).to.equal(0n);
			const intent = freeLsp.lsp
				.getJitReceiveManager()!
				.listIntents()
				.find((i) => i.interceptScidHex === grant.interceptScidHex);
			expect(intent!.acceptsSkimmedFee).to.equal(false);
		} finally {
			await client.close();
		}
	});

	it('refuses a quote above the fee ceilings rather than registering it', async () => {
		const link = new NoisePeerLink({ network: 'regtest' });
		const client = new BeignetClient({
			link,
			network: 'regtest',
			jit: { maxFlatFeeSat: 100 }
		});
		try {
			await client.connect(feeLsp.uri);
			const before = feeLsp.lsp.getJitReceiveManager()!.listIntents().length;
			let caught: unknown;
			try {
				await client.jit.authorize(feeLsp.pubkey, {
					maxAmountSat: 50_000,
					acceptsSkimmedFee: true
				});
			} catch (err) {
				caught = err;
			}
			expect((caught as JitDeclinedError).reason).to.equal('fee_above_ceiling');
			// The LSP registered it (the ack is its number); the client just
			// will not carry that number into an invoice. Same as beignet's
			// own wallet role.
			expect(feeLsp.lsp.getJitReceiveManager()!.listIntents().length).to.equal(
				before + 1
			);
		} finally {
			await client.close();
		}
	});

	it('a throwing listener on the link does not break an exchange', async () => {
		const link = new NoisePeerLink({ network: 'regtest' });
		const client = new BeignetClient({ link, network: 'regtest' });
		try {
			await client.connect(feeLsp.uri);
			const off = link.onCustomMessage(() => {
				throw new Error('listener failure must not break the exchange');
			});
			const quote = await client.jit.quote(feeLsp.pubkey, {
				maxAmountSat: 1_000
			});
			off();
			expect(quote.accepted).to.equal(true);
		} finally {
			await client.close();
		}
	});

	it('times out cleanly against a beignet node that does not serve JIT', async () => {
		const mute = await startLsp('mute', {
			enabled: false
		} as Partial<JitConfig>);
		const link = new NoisePeerLink({ network: 'regtest' });
		const client = new BeignetClient({ link, network: 'regtest' });
		try {
			await client.connect(mute.uri);
			const t0 = Date.now();
			let caught: unknown;
			try {
				await client.jit.quote(mute.pubkey, {
					maxAmountSat: 1_000,
					timeoutMs: 400
				});
			} catch (err) {
				caught = err;
			}
			expect((caught as Error).message).to.match(
				/timed out waiting for the LSP JIT quote/
			);
			expect(Date.now() - t0).to.be.lessThan(5_000);
			// The connection survived the silence: a later call still works
			// at the transport level (it just times out again).
			expect(client.isConnected(mute.pubkey)).to.equal(true);
		} finally {
			await client.close();
			mute.lsp.destroy();
		}
	});
});
