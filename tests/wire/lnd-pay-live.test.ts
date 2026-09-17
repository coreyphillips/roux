/**
 * A REAL LND node pays a beignet direct-funding request, through roux,
 * with one of its own coins and without any key leaving it.
 *
 * Needs the beignet interop docker stack (the `lnd` container, REST on
 * 8091) with a confirmed P2WPKH and a confirmed P2TR coin in LND's wallet;
 * skips cleanly otherwise. The receiver is beignet's real engine and lanes
 * on a real listening PeerManager (tests/df-harness.ts) with the channel
 * stubbed, so nothing is broadcast: LND's coin is leased for the exchange
 * and released at the end.
 *
 * What is proven, per coin kind: LND's SignMessageWithAddr proof is what
 * beignet's receiver verifies (PR #735); LND's SignPsbt witness verifies
 * against the negotiated transaction's sighash under the coin's own key;
 * the receiver attests, the payer verifies the attestation, and the
 * receipt preimage opens the request's hash.
 */

import { expect } from 'chai';
import { execSync } from 'child_process';
import https from 'https';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { DfTransportType } from '../../node_modules/beignet/src/lightning/direct-funding/types';
import { DfDirectPeerLaneFactory } from '../../node_modules/beignet/src/lightning/direct-funding/transport/direct-peer';
import type { IDfTestCoin } from '../../node_modules/beignet/tests/lightning/helpers/df-receiver';
import { BeignetClient, LndWallet, NoisePeerLink } from '../../src';
import { waitFor } from '../helpers';
import {
	AMOUNT,
	FEE_CEILING,
	expectedOffer,
	startReceiver
} from '../df-harness';

bitcoin.initEccLib(ecc);

const LND_REST_PORT = Number(process.env.LND_REST_PORT ?? 8091);
const LND_HOST = process.env.LND_REST_HOST ?? '127.0.0.1';

function loadMacaroon(): string | null {
	try {
		return execSync(
			'docker exec lnd cat /root/.lnd/data/chain/bitcoin/regtest/admin.macaroon',
			{ encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] }
		).toString('hex');
	} catch {
		return null;
	}
}

function lnd<T>(
	macaroon: string,
	method: string,
	path: string,
	body?: unknown
): Promise<T> {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const req = https.request(
			{
				hostname: LND_HOST,
				port: LND_REST_PORT,
				path,
				method,
				rejectUnauthorized: false,
				headers: {
					'Grpc-Metadata-macaroon': macaroon,
					'Content-Type': 'application/json',
					...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
				}
			},
			(res) => {
				let text = '';
				res.on('data', (c) => (text += c));
				res.on('end', () => {
					if ((res.statusCode ?? 0) >= 400) {
						reject(
							new Error(`${method} ${path}: HTTP ${res.statusCode} ${text}`)
						);
						return;
					}
					resolve(JSON.parse(text) as T);
				});
			}
		);
		req.on('error', reject);
		req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
		if (data) req.write(data);
		req.end();
	});
}

interface ILndUtxo {
	address_type: string;
	address: string;
	amount_sat: string;
	pk_script: string;
	outpoint: { txid_str: string; output_index: number };
}

describe('A real LND node pays a beignet direct-funding request (docker)', function () {
	this.timeout(120_000);

	let macaroon: string | null = null;
	let utxos: ILndUtxo[] = [];
	let pubkeyOf = new Map<string, Buffer>();

	before(async function () {
		macaroon = loadMacaroon();
		if (!macaroon) {
			console.log('    [skip] docker lnd not available');
			this.skip();
			return;
		}
		try {
			const res = await lnd<{ utxos?: ILndUtxo[] }>(
				macaroon,
				'POST',
				'/v2/wallet/utxos',
				{
					min_confs: 1,
					max_confs: 999_999_999
				}
			);
			utxos = res.utxos ?? [];
			const addrs = await lnd<{
				account_with_addresses?: Array<{
					addresses?: Array<{ address: string; public_key?: string }>;
				}>;
			}>(macaroon, 'GET', '/v2/wallet/addresses');
			pubkeyOf = new Map();
			for (const a of addrs.account_with_addresses ?? []) {
				for (const x of a.addresses ?? []) {
					if (x.public_key)
						pubkeyOf.set(x.address, Buffer.from(x.public_key, 'base64'));
				}
			}
		} catch (err) {
			console.log('    [skip] lnd REST not reachable:', String(err));
			this.skip();
		}
	});

	for (const [label, addressType, kind] of [
		['P2WPKH', 'WITNESS_PUBKEY_HASH', 'p2wpkh'],
		['P2TR', 'TAPROOT_PUBKEY', 'p2tr']
	] as const) {
		it(`pays with a ${label} coin: LND signs the proof and the witness, the receiver serves it`, async function () {
			const candidates = utxos.filter(
				(u) =>
					u.address_type === addressType &&
					Number(u.amount_sat) > Number(AMOUNT) + 5_000 &&
					pubkeyOf.has(u.address)
			);
			if (candidates.length === 0) {
				console.log(
					`    [skip] LND has no confirmed ${label} coin large enough`
				);
				this.skip();
				return;
			}
			const wallet = new LndWallet({
				host: LND_HOST,
				port: LND_REST_PORT,
				macaroonHex: macaroon!,
				rejectUnauthorized: false,
				network: 'regtest'
			});
			await wallet.refresh();
			const outpoints = new Set(
				candidates.map(
					(u) => `${u.outpoint.txid_str}:${u.outpoint.output_index}`
				)
			);
			// Offer the engine only this kind, so each signing path is proven alone.
			const narrowed = Object.create(wallet) as LndWallet;
			narrowed.listSpendable = (): ReturnType<LndWallet['listSpendable']> =>
				wallet
					.listSpendable()
					.filter((c) => outpoints.has(`${c.txidHex}:${c.vout}`));
			const side = await startReceiver(
				`lnd-${label}`,
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
			// picks: publish every candidate, from LND's own raw transactions.
			const published = new Map<string, IDfTestCoin>();
			for (const u of candidates) {
				const raw = await wallet.getTransaction(u.outpoint.txid_str);
				const coin: IDfTestCoin = {
					prevTx: bitcoin.Transaction.fromBuffer(raw),
					txidHex: u.outpoint.txid_str,
					vout: u.outpoint.output_index,
					valueSat: BigInt(u.amount_sat),
					script: Buffer.from(u.pk_script, 'hex'),
					privkey: Buffer.alloc(32),
					pubkey: pubkeyOf.get(u.address)!,
					kind
				};
				side.node.publish(coin);
				published.set(`${coin.txidHex}:${coin.vout}`, coin);
			}
			const link = new NoisePeerLink({ network: 'regtest' });
			const client = new BeignetClient({
				allowEphemeralStorage: true,
				link,
				network: 'regtest',
				wallet: narrowed,
				sender: {
					offerResendDelaysMs: [],
					offerTimeoutMs: 30_000,
					receiptTimeoutMs: 5_000
				}
			});
			let chosen: IDfTestCoin | null = null;
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
				chosen = published.get(`${prevTxid}:${input.prevOutputIndex}`)!;
				expect(
					chosen,
					'the engine offered a coin the test did not publish'
				).to.not.equal(undefined);
				const script = chosen.script;
				const pubkey = chosen.pubkey;
				const change = side.node.opens[0].params.contribution.changeScript;
				const offer = expectedOffer(chosen, change, side.record.receiptHash);
				offer.ownership.pubkey =
					kind === 'p2tr' ? script.subarray(2, 34) : pubkey;
				const { tx } = side.node.completeNegotiation(chosen, offer, {
					fundingScript: side.fundingScript
				});
				const result = await paying;

				expect(result.attested).to.equal(true);
				expect(result.status).to.equal('SIGNED_PENDING');
				expect(result.receiptPreimageHex).to.equal(side.record.preimageHex);
				expect(result.spentTxid).to.equal(chosen.txidHex);

				// The witness LND produced verifies against the negotiated transaction.
				expect(side.node.witnesses).to.have.length(1);
				const witness = side.node.witnesses[0].witness;
				if (kind === 'p2tr') {
					expect(witness).to.have.length(1);
					const sighash = tx.hashForWitnessV1(
						0,
						[script],
						[Number(chosen.valueSat)],
						bitcoin.Transaction.SIGHASH_DEFAULT
					);
					expect(
						ecc.verifySchnorr(
							sighash,
							script.subarray(2, 34),
							witness[0].subarray(0, 64)
						)
					).to.equal(true);
				} else {
					expect(witness).to.have.length(2);
					expect(witness[1]).to.deep.equal(pubkey);
					const decoded = bitcoin.script.signature.decode(witness[0]);
					expect(decoded.hashType).to.equal(bitcoin.Transaction.SIGHASH_ALL);
					const scriptCode = bitcoin.payments.p2pkh({ pubkey }).output!;
					const sighash = tx.hashForWitnessV0(
						0,
						scriptCode,
						Number(chosen.valueSat),
						bitcoin.Transaction.SIGHASH_ALL
					);
					expect(ecc.verify(sighash, pubkey, decoded.signature)).to.equal(true);
				}
				// LND holds the coin under our lease until the funding resolves.
				const leases = await lnd<{
					locked_utxos?: Array<{ outpoint: { txid_str: string } }>;
				}>(macaroon!, 'POST', '/v2/wallet/utxos/leases', {});
				expect(
					(leases.locked_utxos ?? []).some(
						(l) => l.outpoint.txid_str === chosen!.txidHex
					)
				).to.equal(true);
			} finally {
				await client.close();
				side.stop();
				// Nothing was broadcast (the channel is a stub): give LND its coin back.
				if (chosen) await wallet.unfreezeUtxo(chosen.txidHex, chosen.vout);
			}
		});
	}
});
