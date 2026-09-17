/**
 * An LND node's on-chain wallet as a direct-funding payer, over REST, with
 * no key leaving the node.
 *
 * beignet's payer engine asks a wallet for five things: coins, a signer per
 * coin, a change script, chain facts, and a freeze. LND has all of them:
 *
 *   coins        POST /v2/wallet/utxos                (ListUnspent)
 *   keys, paths  GET  /v2/wallet/addresses            (public key and BIP 32 path per address)
 *   ownership    POST /v2/wallet/address/signmessage  (SignMessageWithAddr: a Bitcoin signed
 *                                                      message by the address key; for P2TR
 *                                                      the internal key, beignet PR #735)
 *   witness      POST /v2/wallet/psbt/sign            (SignPsbt over a one-input PSBT)
 *   change       GET  /v1/newaddress                  (an unused P2WPKH address)
 *   chain facts  GET  /v1/transactions, GET /v1/getinfo
 *   freeze       POST /v2/wallet/utxos/lease, /release, /leases
 *
 * Every shape here was checked against lnd 0.20. Two of them are not
 * obvious: SignPsbt reads the plain BIP 32 derivation record even for a
 * taproot input and wants the taproot record beside it, which bitcoinjs
 * refuses to put on one input, so the records are written at the bip174
 * layer; and a P2WPKH input must ask for SIGHASH_ALL explicitly or LND
 * signs with hash type 0, which is not a standard signature.
 *
 * The engine's wallet surface is synchronous for reads (coins, facts), so
 * this adapter works from a snapshot: call `refresh()` before a payment
 * (`DirectFundingClient.pay` does) and the snapshot is what the engine
 * reads. Leases are tagged with one fixed id so this adapter only ever
 * releases its own.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import crypto from 'crypto';
import type { directFunding } from 'beignet/lightning';
import { RouxLog, RouxNetwork, noopLog } from '../types';
import { IHttpEndpoint, requestJson } from '../link/http';
import { bitcoinNetwork, coinKindOf } from './key-wallet';

bitcoin.initEccLib(ecc);

export interface ILndWalletOptions {
	host: string;
	/** REST port (default 8080). */
	port?: number;
	/**
	 * Hex macaroon with onchain:read, onchain:write (leases, PSBT signing),
	 * address:read, address:write (change addresses), message:write
	 * (SignMessageWithAddr) and info:read.
	 */
	macaroonHex: string;
	network: RouxNetwork;
	https?: boolean;
	ca?: IHttpEndpoint['ca'];
	rejectUnauthorized?: boolean;
	/** Confirmations a coin needs to be offered (default 1). */
	minConfs?: number;
	/** How long a lease lasts (default 30 days); the engine releases it earlier. */
	leaseSeconds?: number;
	log?: RouxLog;
}

/** The lease id this adapter tags its own reservations with. */
export const LND_WALLET_LEASE_ID = crypto
	.createHash('sha256')
	.update('roux-direct-funding-lease', 'utf8')
	.digest();

interface ILndUtxo {
	address_type: string;
	address: string;
	amount_sat: string;
	pk_script: string;
	outpoint: { txid_str: string; output_index: number };
	confirmations: string;
}

interface ILndAddressProperty {
	address: string;
	public_key?: string;
	derivation_path?: string;
}

interface ILndTransaction {
	tx_hash: string;
	num_confirmations: number;
	block_height: number;
	raw_tx_hex: string;
	previous_outpoints?: Array<{ outpoint: string; is_our_output: boolean }>;
}

interface ICoin extends directFunding.IDfSenderCoin {
	address: string;
	kind: 'p2wpkh' | 'p2tr';
	pubkey: Buffer;
	derivationPath: string;
}

export class LndWallet implements directFunding.IDfSenderWallet {
	private readonly ep: IHttpEndpoint;
	private readonly network: bitcoin.Network;
	private readonly log: RouxLog;
	/** Every coin seen, leased ones included; keyed by `txid:vout`. */
	private readonly coins = new Map<string, ICoin>();
	/** Outpoints leased right now (ours or anyone's). */
	private leased = new Set<string>();
	private transactions = new Map<string, ILndTransaction>();
	private tip = 0;

	constructor(private readonly options: ILndWalletOptions) {
		this.ep = {
			host: options.host,
			port: options.port ?? 8080,
			https: options.https,
			ca: options.ca,
			rejectUnauthorized: options.rejectUnauthorized,
			headers: { 'Grpc-Metadata-macaroon': options.macaroonHex }
		};
		this.network = bitcoinNetwork(options.network);
		this.log = options.log ?? noopLog;
	}

	// ─────────────── The snapshot ───────────────

	/** Re-read coins, keys, leases, transactions and the tip from LND. */
	async refresh(): Promise<void> {
		const [info, unspent, addresses, leases, txs] = await Promise.all([
			requestJson<{ block_height: number }>(this.ep, 'GET', '/v1/getinfo'),
			requestJson<{ utxos?: ILndUtxo[] }>(this.ep, 'POST', '/v2/wallet/utxos', {
				min_confs: 0,
				max_confs: 999_999_999
			}),
			requestJson<{
				account_with_addresses?: Array<{ addresses?: ILndAddressProperty[] }>;
			}>(this.ep, 'GET', '/v2/wallet/addresses'),
			requestJson<{
				locked_utxos?: Array<{
					outpoint: { txid_str: string; output_index: number };
				}>;
			}>(this.ep, 'POST', '/v2/wallet/utxos/leases', {}),
			requestJson<{ transactions?: ILndTransaction[] }>(
				this.ep,
				'GET',
				'/v1/transactions?start_height=0&end_height=-1'
			)
		]);
		this.tip = Number(info.block_height);
		const byAddress = new Map<string, ILndAddressProperty>();
		for (const account of addresses.account_with_addresses ?? []) {
			for (const a of account.addresses ?? []) byAddress.set(a.address, a);
		}
		for (const u of unspent.utxos ?? []) {
			const script = Buffer.from(u.pk_script, 'hex');
			const kind = coinKindOf(script);
			const props = byAddress.get(u.address);
			if (!kind || !props?.public_key || !props.derivation_path) continue;
			const pubkey = Buffer.from(props.public_key, 'base64');
			const confirmations = Number(u.confirmations);
			const key = `${u.outpoint.txid_str}:${u.outpoint.output_index}`;
			this.coins.set(key, {
				txidHex: u.outpoint.txid_str,
				vout: u.outpoint.output_index,
				valueSat: BigInt(u.amount_sat),
				script,
				height: confirmations > 0 ? this.tip - confirmations + 1 : 0,
				address: u.address,
				kind,
				pubkey,
				derivationPath: props.derivation_path
			});
		}
		this.leased = new Set(
			(leases.locked_utxos ?? []).map(
				(l) => `${l.outpoint.txid_str}:${l.outpoint.output_index}`
			)
		);
		this.transactions = new Map(
			(txs.transactions ?? []).map((t) => [t.tx_hash, t])
		);
	}

	// ─────────────── IDfSenderWallet ───────────────

	listSpendable(): directFunding.IDfSenderCoin[] {
		const minConfs = this.options.minConfs ?? 1;
		return [...this.coins.values()]
			.filter((c) => !this.leased.has(`${c.txidHex}:${c.vout}`))
			.filter(
				(c) =>
					minConfs === 0 ||
					(c.height > 0 && this.tip - c.height + 1 >= minConfs)
			)
			.map(publicView);
	}

	findCoin(txidHex: string, vout: number): directFunding.IDfSenderCoin | null {
		const c = this.coins.get(`${txidHex}:${vout}`);
		return c ? publicView(c) : null;
	}

	ownsOutpoint(txidHex: string, vout: number): boolean {
		return this.coins.has(`${txidHex}:${vout}`);
	}

	async getTransaction(txidHex: string): Promise<Buffer> {
		let tx = this.transactions.get(txidHex);
		if (!tx) {
			const res = await requestJson<{ transactions?: ILndTransaction[] }>(
				this.ep,
				'GET',
				'/v1/transactions?start_height=0&end_height=-1'
			);
			this.transactions = new Map(
				(res.transactions ?? []).map((t) => [t.tx_hash, t])
			);
			tx = this.transactions.get(txidHex);
		}
		if (!tx?.raw_tx_hex)
			throw new Error(`LND does not hold transaction ${txidHex}`);
		return Buffer.from(tx.raw_tx_hex, 'hex');
	}

	async changeScript(): Promise<Buffer> {
		const res = await requestJson<{ address: string }>(
			this.ep,
			'GET',
			'/v1/newaddress?type=UNUSED_WITNESS_PUBKEY_HASH'
		);
		return bitcoin.address.toOutputScript(res.address, this.network);
	}

	signerFor(
		coin: directFunding.IDfSenderCoin
	): directFunding.IDfCoinSigner | null {
		const known = this.coins.get(`${coin.txidHex}:${coin.vout}`);
		if (!known) return null;
		return {
			kind: known.kind,
			// The key the offer names: the address key for P2WPKH, the x-only
			// output key (from the script) for P2TR, as the digest form has it.
			ownershipPubkey:
				known.kind === 'p2tr' ? known.script.subarray(2, 34) : known.pubkey,
			signOwnership: (): Buffer => {
				throw new Error(
					'LND signs messages, not raw digests; the message proof is used'
				);
			},
			signOwnershipMessage: (
				message
			): Promise<{ pubkey: Buffer; signature: Buffer }> =>
				this.signMessage(known, message),
			signInput: (tx, inputIndex, prevouts): Promise<Buffer[]> =>
				this.signInput(known, tx, inputIndex, prevouts)
		};
	}

	async freezeUtxo(txidHex: string, vout: number): Promise<boolean> {
		if (!this.coins.has(`${txidHex}:${vout}`)) return false;
		try {
			await requestJson(this.ep, 'POST', '/v2/wallet/utxos/lease', {
				id: LND_WALLET_LEASE_ID.toString('base64'),
				outpoint: { txid_str: txidHex, output_index: vout },
				expiration_seconds: String(this.options.leaseSeconds ?? 30 * 24 * 3600)
			});
		} catch (err) {
			this.log('lnd_lease_failed', {
				outpoint: `${txidHex}:${vout}`,
				error: String(err)
			});
			return false;
		}
		this.leased.add(`${txidHex}:${vout}`);
		return true;
	}

	async unfreezeUtxo(txidHex: string, vout: number): Promise<boolean> {
		try {
			await requestJson(this.ep, 'POST', '/v2/wallet/utxos/release', {
				id: LND_WALLET_LEASE_ID.toString('base64'),
				outpoint: { txid_str: txidHex, output_index: vout }
			});
		} catch (err) {
			// Releasing somebody else's lease, or one that lapsed, is refused by
			// LND; either way it is not ours to hold.
			this.log('lnd_release_failed', {
				outpoint: `${txidHex}:${vout}`,
				error: String(err)
			});
			return false;
		}
		this.leased.delete(`${txidHex}:${vout}`);
		return true;
	}

	blockHeight(): number {
		return this.tip;
	}

	txStatus(txidHex: string): { known: boolean; confirmed: boolean } | null {
		const tx = this.transactions.get(txidHex);
		if (!tx) return null;
		return { known: true, confirmed: Number(tx.num_confirmations) > 0 };
	}

	confirmedSpendOf(txidHex: string, vout: number): string | null {
		const outpoint = `${txidHex}:${vout}`;
		for (const tx of this.transactions.values()) {
			if (Number(tx.num_confirmations) <= 0) continue;
			if ((tx.previous_outpoints ?? []).some((p) => p.outpoint === outpoint)) {
				return tx.tx_hash;
			}
		}
		return null;
	}

	// ─────────────── Signing ───────────────

	private async signMessage(
		coin: ICoin,
		message: string
	): Promise<{ pubkey: Buffer; signature: Buffer }> {
		const res = await requestJson<{ signature: string }>(
			this.ep,
			'POST',
			'/v2/wallet/address/signmessage',
			{
				msg: Buffer.from(message, 'utf8').toString('base64'),
				addr: coin.address
			}
		);
		const signature = Buffer.from(res.signature, 'base64');
		if (signature.length !== 65) {
			throw new Error(
				`LND returned a ${signature.length}-byte message signature, expected 65`
			);
		}
		// For P2TR this is the internal key: LND signs messages with it, and
		// the receiver applies the BIP 86 tweak.
		return { pubkey: coin.pubkey, signature };
	}

	private async signInput(
		coin: ICoin,
		tx: bitcoin.Transaction,
		inputIndex: number,
		prevouts: { scripts: Buffer[]; values: bigint[] }
	): Promise<Buffer[]> {
		const psbt = new bitcoin.Psbt({ network: this.network });
		psbt.setVersion(tx.version);
		psbt.setLocktime(tx.locktime);
		tx.ins.forEach((input, i) => {
			psbt.addInput({
				hash: input.hash,
				index: input.index,
				sequence: input.sequence,
				witnessUtxo: {
					script: prevouts.scripts[i],
					value: Number(prevouts.values[i])
				}
			});
		});
		for (const out of tx.outs)
			psbt.addOutput({ script: out.script, value: out.value });
		const derivation = {
			masterFingerprint: Buffer.alloc(4),
			path: coin.derivationPath,
			pubkey: coin.pubkey
		};
		// Written at the bip174 layer: LND's SignPsbt reads the plain BIP 32
		// record for every input and wants the taproot record beside it, a
		// pairing bitcoinjs's input checks refuse.
		const target = psbt.data.inputs[inputIndex];
		target.bip32Derivation = [derivation];
		if (coin.kind === 'p2tr') {
			target.tapInternalKey = coin.pubkey.subarray(1, 33);
			target.tapBip32Derivation = [
				{ ...derivation, pubkey: coin.pubkey.subarray(1, 33), leafHashes: [] }
			];
		} else {
			target.sighashType = bitcoin.Transaction.SIGHASH_ALL;
		}
		const res = await requestJson<{
			signed_psbt: string;
			signed_inputs?: number[];
		}>(this.ep, 'POST', '/v2/wallet/psbt/sign', {
			funded_psbt: psbt.toBase64()
		});
		const signed = bitcoin.Psbt.fromBase64(res.signed_psbt, {
			network: this.network
		});
		const input = signed.data.inputs[inputIndex];
		if (coin.kind === 'p2tr') {
			if (!input.tapKeySig)
				throw new Error('LND did not sign the taproot input');
			return [Buffer.from(input.tapKeySig)];
		}
		const partial = (input.partialSig ?? []).find((p) =>
			Buffer.from(p.pubkey).equals(coin.pubkey)
		);
		if (!partial) throw new Error('LND did not sign the P2WPKH input');
		return [Buffer.from(partial.signature), coin.pubkey];
	}
}

function publicView(c: ICoin): directFunding.IDfSenderCoin {
	return {
		txidHex: c.txidHex,
		vout: c.vout,
		valueSat: c.valueSat,
		script: c.script,
		height: c.height
	};
}
