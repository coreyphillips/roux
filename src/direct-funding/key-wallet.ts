/**
 * A payer wallet for direct funding, built from coins and keys you hand it.
 *
 * beignet's payer engine wants an `IDfSenderWallet`: coins it may offer, a
 * signer per coin, a change script, a chain lookup and a freeze. A wallet
 * that already has all that (a beignet Wallet, LDK, bdk) adapts itself in a
 * few lines. For everything else, this: give it P2WPKH or P2TR coins with
 * their private keys and a way to fetch a raw transaction, and it is a
 * complete payer.
 *
 * What the signer can produce is deliberately narrow, the same two things
 * beignet's own adapter allows: an ownership proof over a digest, and a
 * witness for ONE input of ONE transaction the engine has already verified
 * (the funding output the receiver's node key attested, our change back to
 * our own script, the fee inside our ceiling). Key material never leaves
 * this file.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import type { directFunding } from 'beignet/lightning';
import { RouxNetwork, Sats, toSats } from '../types';

bitcoin.initEccLib(ecc);

export type CoinKind = 'p2wpkh' | 'p2tr';

export interface IKeyedCoin {
	/** Display (big-endian) txid, the order every explorer prints. */
	txid: string;
	vout: number;
	valueSat: Sats;
	/** The scriptPubKey, OR its address; one of the two. */
	script?: Buffer;
	address?: string;
	/** Confirmation height; 0 or omitted means unconfirmed. */
	height?: number;
	/** 32-byte private key for the coin's key. For P2TR, the INTERNAL key (BIP 86). */
	privateKey: Buffer;
}

export interface IKeyedUtxoWalletOptions {
	network: RouxNetwork;
	coins: IKeyedCoin[];
	/** Where change goes: a script or an address of yours. */
	changeScript?: Buffer;
	changeAddress?: string;
	/** Raw previous transaction for a display txid (Electrum, Esplora, Core...). */
	getTransaction: (txid: string) => Promise<Buffer>;
	/** Current chain tip, or 0 when unknown (a future-locked tx is then refused). */
	blockHeight?: () => number;
	/** What this wallet knows about a txid; null when unknown. */
	txStatus?: (txid: string) => { known: boolean; confirmed: boolean } | null;
	/** A CONFIRMED txid of ours spending this outpoint, or null. */
	confirmedSpendOf?: (txid: string, vout: number) => string | null;
	/** Outpoints (`txid:vout`) frozen before this process started. */
	frozen?: Iterable<string>;
	/** Persist the freeze set whenever it changes. */
	onFreezeChange?: (outpoints: string[]) => void;
}

interface IResolvedCoin extends directFunding.IDfSenderCoin {
	kind: CoinKind;
	privateKey: Buffer;
	pubkey: Buffer;
}

export function bitcoinNetwork(network: RouxNetwork): bitcoin.Network {
	switch (network) {
		case 'mainnet':
			return bitcoin.networks.bitcoin;
		case 'regtest':
			return bitcoin.networks.regtest;
		default:
			// testnet and signet share address formats.
			return bitcoin.networks.testnet;
	}
}

/** P2WPKH is `0014{20}`, P2TR key path is `5120{32}`. Nothing else is offered. */
export function coinKindOf(script: Buffer): CoinKind | null {
	if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14)
		return 'p2wpkh';
	if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20)
		return 'p2tr';
	return null;
}

/**
 * BIP 86 / BIP 341 key-path tweak: the private key for the OUTPUT key, given
 * the internal key. The internal key is negated first when its point has an
 * odd y, which is what makes the x-only arithmetic line up.
 */
export function taprootTweakPrivateKey(
	privateKey: Buffer,
	pubkey: Buffer
): Buffer {
	const xonly = pubkey.subarray(1, 33);
	const tweak = bitcoin.crypto.taggedHash('TapTweak', xonly);
	const base = pubkey[0] === 0x03 ? ecc.privateNegate(privateKey) : privateKey;
	const tweaked = ecc.privateAdd(base, tweak);
	if (!tweaked) throw new Error('taproot tweak produced an invalid key');
	return Buffer.from(tweaked);
}

export class KeyedUtxoWallet implements directFunding.IDfSenderWallet {
	private readonly network: bitcoin.Network;
	private readonly coins: IResolvedCoin[];
	private readonly frozen = new Set<string>();
	private readonly change: Buffer;

	constructor(private readonly options: IKeyedUtxoWalletOptions) {
		this.network = bitcoinNetwork(options.network);
		this.coins = options.coins.map((c) => this.resolve(c));
		for (const o of options.frozen ?? []) this.frozen.add(o);
		if (options.changeScript) {
			this.change = options.changeScript;
		} else if (options.changeAddress) {
			this.change = bitcoin.address.toOutputScript(
				options.changeAddress,
				this.network
			);
		} else {
			throw new Error('KeyedUtxoWallet needs changeScript or changeAddress');
		}
	}

	/** Add a coin after construction. */
	addCoin(coin: IKeyedCoin): void {
		this.coins.push(this.resolve(coin));
	}

	/** Forget a coin (spent elsewhere, or no longer offered). */
	removeCoin(txid: string, vout: number): void {
		const i = this.coins.findIndex(
			(c) => c.txidHex === txid && c.vout === vout
		);
		if (i >= 0) this.coins.splice(i, 1);
	}

	frozenOutpoints(): string[] {
		return [...this.frozen];
	}

	// ─────────────── IDfSenderWallet ───────────────

	listSpendable(): directFunding.IDfSenderCoin[] {
		return this.coins
			.filter((c) => !this.frozen.has(`${c.txidHex}:${c.vout}`))
			.map((c) => this.publicView(c));
	}

	findCoin(txidHex: string, vout: number): directFunding.IDfSenderCoin | null {
		// Frozen coins included: a resumed attempt has to find the coin it
		// froze before the run that took it died.
		const c = this.coins.find((x) => x.txidHex === txidHex && x.vout === vout);
		return c ? this.publicView(c) : null;
	}

	ownsOutpoint(txidHex: string, vout: number): boolean {
		return this.coins.some((x) => x.txidHex === txidHex && x.vout === vout);
	}

	getTransaction(txidHex: string): Promise<Buffer> {
		return this.options.getTransaction(txidHex);
	}

	async changeScript(): Promise<Buffer> {
		return this.change;
	}

	signerFor(
		coin: directFunding.IDfSenderCoin
	): directFunding.IDfCoinSigner | null {
		const known = this.coins.find(
			(x) => x.txidHex === coin.txidHex && x.vout === coin.vout
		);
		if (!known) return null;
		const { privateKey, pubkey, kind } = known;

		if (kind === 'p2tr') {
			const tweaked = taprootTweakPrivateKey(privateKey, pubkey);
			const outputKey = Buffer.from(
				ecc.pointFromScalar(tweaked, true)!
			).subarray(1, 33);
			return {
				kind,
				// The x-only OUTPUT key: the receiver lifts it from the scriptPubKey
				// and verifies the Schnorr proof under it. 32 bytes is also how the
				// receiver knows to verify under Schnorr rather than ECDSA.
				ownershipPubkey: outputKey,
				signOwnership: (digest): Buffer =>
					Buffer.from(ecc.signSchnorr(digest, tweaked)),
				signInput: (tx, inputIndex, prevouts): Buffer[] => [
					// SIGHASH_DEFAULT, 64-byte form: an ordinary wallet input.
					Buffer.from(
						ecc.signSchnorr(
							tx.hashForWitnessV1(
								inputIndex,
								prevouts.scripts,
								prevouts.values.map((v) => Number(v)),
								bitcoin.Transaction.SIGHASH_DEFAULT
							),
							tweaked
						)
					)
				]
			};
		}

		const scriptCode = bitcoin.payments.p2pkh({ pubkey, network: this.network })
			.output!;
		return {
			kind,
			ownershipPubkey: pubkey,
			signOwnership: (digest): Buffer =>
				Buffer.from(ecc.sign(digest, privateKey)),
			signInput: (tx, inputIndex): Buffer[] => {
				const sighash = tx.hashForWitnessV0(
					inputIndex,
					scriptCode,
					Number(known.valueSat),
					bitcoin.Transaction.SIGHASH_ALL
				);
				return [
					bitcoin.script.signature.encode(
						Buffer.from(ecc.sign(sighash, privateKey)),
						bitcoin.Transaction.SIGHASH_ALL
					),
					pubkey
				];
			}
		};
	}

	async freezeUtxo(txidHex: string, vout: number): Promise<boolean> {
		if (!this.ownsOutpoint(txidHex, vout)) return false;
		this.frozen.add(`${txidHex}:${vout}`);
		this.options.onFreezeChange?.([...this.frozen]);
		return true;
	}

	async unfreezeUtxo(txidHex: string, vout: number): Promise<boolean> {
		const had = this.frozen.delete(`${txidHex}:${vout}`);
		if (had) this.options.onFreezeChange?.([...this.frozen]);
		return had;
	}

	blockHeight(): number {
		return this.options.blockHeight?.() ?? 0;
	}

	txStatus(txidHex: string): { known: boolean; confirmed: boolean } | null {
		return this.options.txStatus?.(txidHex) ?? null;
	}

	confirmedSpendOf(txidHex: string, vout: number): string | null {
		return this.options.confirmedSpendOf?.(txidHex, vout) ?? null;
	}

	// ─────────────── Internals ───────────────

	private resolve(coin: IKeyedCoin): IResolvedCoin {
		if (coin.privateKey.length !== 32 || !ecc.isPrivate(coin.privateKey)) {
			throw new Error(
				`coin ${coin.txid}:${coin.vout}: privateKey is not a valid 32-byte key`
			);
		}
		if (!/^[0-9a-f]{64}$/i.test(coin.txid)) {
			throw new Error(
				`coin ${coin.txid}:${coin.vout}: txid must be 64 hex characters`
			);
		}
		let script = coin.script;
		if (!script) {
			if (!coin.address) {
				throw new Error(
					`coin ${coin.txid}:${coin.vout}: script or address is required`
				);
			}
			script = bitcoin.address.toOutputScript(coin.address, this.network);
		}
		const kind = coinKindOf(script);
		if (!kind) {
			throw new Error(
				`coin ${coin.txid}:${coin.vout}: only P2WPKH and P2TR key-path coins can be offered`
			);
		}
		const pubkey = Buffer.from(ecc.pointFromScalar(coin.privateKey, true)!);
		// The key the caller gave must be the key the script commits to, or the
		// witness produced later cannot spend the coin and the failure would
		// only surface after the receiver broadcast.
		const expected =
			kind === 'p2wpkh'
				? bitcoin.payments.p2wpkh({ pubkey, network: this.network }).output!
				: bitcoin.payments.p2tr({
						internalPubkey: pubkey.subarray(1, 33),
						network: this.network
				  }).output!;
		if (!expected.equals(script)) {
			throw new Error(
				`coin ${coin.txid}:${coin.vout}: the private key does not control this ${kind} script`
			);
		}
		return {
			txidHex: coin.txid.toLowerCase(),
			vout: coin.vout,
			valueSat: toSats(coin.valueSat, 'valueSat'),
			script,
			height: coin.height ?? 0,
			kind,
			privateKey: coin.privateKey,
			pubkey
		};
	}

	private publicView(c: IResolvedCoin): directFunding.IDfSenderCoin {
		return {
			txidHex: c.txidHex,
			vout: c.vout,
			valueSat: c.valueSat,
			script: c.script,
			height: c.height
		};
	}
}
