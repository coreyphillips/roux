/**
 * A REAL Core Lightning node pays a beignet direct-funding request, through
 * roux, with one of its own coins and no key leaving it.
 *
 * Needs the beignet interop docker stack (the `cln` container, clnrest on
 * 3010, a rune minted with `docker exec`); skips otherwise. The receiver is
 * beignet's real engine on a real listening PeerManager with the channel
 * stubbed, so nothing is broadcast and CLN's reservation is released after.
 *
 * Proven per coin kind: CLN's signpsbt signature over the probe transaction
 * is what beignet's receiver verifies as the ownership proof, and its
 * signature over the negotiated funding verifies as the input's witness.
 */

import { expect } from 'chai';
import { execSync } from 'child_process';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { DfTransportType } from '../../node_modules/beignet/src/lightning/direct-funding/types';
import { DfDirectPeerLaneFactory } from '../../node_modules/beignet/src/lightning/direct-funding/transport/direct-peer';
import type { IDfTestCoin } from '../../node_modules/beignet/tests/lightning/helpers/df-receiver';
import { BeignetClient, ClnWallet, NoisePeerLink } from '../../src';
import { waitFor } from '../helpers';
import {
	AMOUNT,
	FEE_CEILING,
	expectedOffer,
	startReceiver
} from '../df-harness';

bitcoin.initEccLib(ecc);

const CLN_PORT = Number(process.env.CLN_REST_PORT ?? 3010);
const CLN_HOST = process.env.CLN_REST_HOST ?? '127.0.0.1';

function loadRune(): string | null {
	try {
		return JSON.parse(
			execSync('docker exec cln lightning-cli --network=regtest createrune', {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore']
			})
		).rune;
	} catch {
		return null;
	}
}

describe('A real Core Lightning node pays a beignet direct-funding request (docker)', function () {
	this.timeout(120_000);

	let wallet: ClnWallet | null = null;

	before(async function () {
		const rune = loadRune();
		if (!rune) {
			console.log('    [skip] docker cln not available');
			this.skip();
			return;
		}
		wallet = new ClnWallet({
			host: CLN_HOST,
			port: CLN_PORT,
			rune,
			rejectUnauthorized: false,
			network: 'regtest'
		});
		try {
			await wallet.refresh();
		} catch (err) {
			console.log('    [skip] clnrest not reachable:', String(err));
			this.skip();
		}
	});

	for (const kind of ['p2wpkh', 'p2tr'] as const) {
		it(`pays with a ${kind} coin: CLN signs the probe proof and the witness`, async function () {
			await wallet!.refresh();
			const spendable = wallet!
				.listSpendable()
				.filter(
					(c) =>
						(kind === 'p2tr' ? c.script[0] === 0x51 : c.script[0] === 0x00) &&
						c.valueSat > AMOUNT + 5_000n
				)
				.slice(0, 1);
			if (spendable.length === 0) {
				console.log(
					`    [skip] CLN has no confirmed ${kind} coin large enough`
				);
				this.skip();
				return;
			}
			// Offer the engine only this kind: a wallet view narrowed to it, so
			// the test proves each signing path on its own.
			const narrowed = Object.create(wallet!) as ClnWallet;
			narrowed.listSpendable = (): typeof spendable => spendable;
			const side = await startReceiver(
				`cln-${kind}`,
				(port) => [
					{ type: DfTransportType.DIRECT_PEER, host: '127.0.0.1', port }
				],
				(peers, registry) =>
					registry.register({
						type: DfTransportType.DIRECT_PEER,
						enabled: true,
						load: () => new DfDirectPeerLaneFactory(peers)
					})
			);
			// The receiver's chain view must resolve whichever coin the engine
			// picks: publish them all, from CLN's own raw transactions.
			const published = new Map<string, IDfTestCoin>();
			for (const c of spendable) {
				const raw = await wallet!.getTransaction(c.txidHex);
				const coin: IDfTestCoin = {
					prevTx: bitcoin.Transaction.fromBuffer(raw),
					txidHex: c.txidHex,
					vout: c.vout,
					valueSat: c.valueSat,
					script: c.script,
					privkey: Buffer.alloc(32),
					pubkey: Buffer.alloc(33),
					kind
				};
				side.node.publish(coin);
				published.set(`${c.txidHex}:${c.vout}`, coin);
			}
			const client = new BeignetClient({
				allowEphemeralStorage: true,
				link: new NoisePeerLink({ network: 'regtest' }),
				network: 'regtest',
				wallet: narrowed,
				sender: {
					offerResendDelaysMs: [],
					offerTimeoutMs: 30_000,
					receiptTimeoutMs: 5_000
				}
			});
			// Offer one known coin so cleanup can release it even if the exchange
			// fails before the receiver reports its selected contribution.
			const chosen = published.get(
				`${spendable[0].txidHex}:${spendable[0].vout}`
			)!;
			try {
				const paying = client.directFunding.pay(side.bip21, {
					amountSat: AMOUNT,
					maxTotalFeeSat: FEE_CEILING
				});
				paying.catch(() => undefined);
				await waitFor(
					() => side.node.opens.length === 1,
					'the receiver to start an open',
					30_000
				);
				const input = side.node.opens[0].params.contribution.inputs[0];
				const prevTxid = bitcoin.Transaction.fromBuffer(input.prevTx).getId();
				expect(
					published.get(`${prevTxid}:${input.prevOutputIndex}`),
					'the engine offered a coin the test did not publish'
				).to.equal(chosen);
				const change = side.node.opens[0].params.contribution.changeScript;
				const offer = expectedOffer(chosen, change, side.record.receiptHash);
				offer.ownership.pubkey =
					kind === 'p2tr' ? chosen.script.subarray(2, 34) : Buffer.alloc(33);
				const { tx } = side.node.completeNegotiation(chosen, offer, {
					fundingScript: side.fundingScript
				});
				const result = await paying;
				expect(result.attested).to.equal(true);
				expect(result.status).to.equal('SIGNED_PENDING');
				expect(result.receiptPreimageHex).to.equal(side.record.preimageHex);
				expect(result.spentTxid).to.equal(chosen.txidHex);
				expect(side.node.witnesses).to.have.length(1);
				const witness = side.node.witnesses[0].witness;
				if (kind === 'p2tr') {
					expect(witness).to.have.length(1);
					const sighash = tx.hashForWitnessV1(
						0,
						[chosen.script],
						[Number(chosen.valueSat)],
						0
					);
					expect(
						ecc.verifySchnorr(
							sighash,
							chosen.script.subarray(2, 34),
							witness[0].subarray(0, 64)
						)
					).to.equal(true);
				} else {
					expect(witness).to.have.length(2);
					const decoded = bitcoin.script.signature.decode(witness[0]);
					const scriptCode = bitcoin.payments.p2pkh({ pubkey: witness[1] })
						.output!;
					const sighash = tx.hashForWitnessV0(
						0,
						scriptCode,
						Number(chosen.valueSat),
						decoded.hashType
					);
					expect(ecc.verify(sighash, witness[1], decoded.signature)).to.equal(
						true
					);
					expect(bitcoin.crypto.hash160(witness[1])).to.deep.equal(
						chosen.script.subarray(2, 22)
					);
				}
			} finally {
				try {
					await client.close();
				} finally {
					try {
						side.stop();
					} finally {
						// Nothing was broadcast. Verify both the release response and a
						// fresh CLN snapshot, so an unmatched reservation fails the test.
						const released = await wallet!.unfreezeUtxo(
							chosen.txidHex,
							chosen.vout
						);
						await wallet!.refresh();
						expect(released, 'CLN did not release the selected coin').to.equal(
							true
						);
						expect(
							wallet!
								.listSpendable()
								.some(
									(c) => c.txidHex === chosen.txidHex && c.vout === chosen.vout
								),
							'the selected coin remains reserved in CLN after cleanup'
						).to.equal(true);
					}
				}
			}
		});
	}
});
