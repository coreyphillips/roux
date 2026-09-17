/**
 * A Core Lightning node's on-chain wallet as a direct-funding payer, over
 * clnrest, with no key leaving the node.
 *
 * CLN's only coin-key signing primitive is `signpsbt`, so the ownership
 * proof is the probe-transaction form (beignet PR: odd TLV 23): a real
 * signature over a transaction that spends the coin and can never be
 * broadcast, because its second input spends an outpoint with no preimage.
 * CLN signs it like any PSBT (checked against v26.06 for P2WPKH and P2TR),
 * and the same call signs the real funding input later.
 *
 *   coins      listfunds                       confirmed, unreserved outputs
 *   proof      reserveinputs + signpsbt        the probe PSBT, input 0 only
 *   witness    signpsbt                        the negotiated funding, our input only
 *   freeze     reserveinputs / unreserveinputs CLN's own reservation, which also keeps
 *                                              its coin selection off the coin
 *   change     newaddr bech32
 *   chain      listtransactions (raw tx, confirmations, inputs), getinfo
 *
 * CLN reveals a P2WPKH coin's public key only in the signature it makes
 * (the PSBT's partial signature), which is why the probe form hands the key
 * back to the engine together with the signature.
 *
 * Reads are synchronous in the engine's wallet surface, so this works from
 * a snapshot: `refresh()` is called by `DirectFundingClient.pay`.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import type { directFunding } from 'beignet/lightning';
import { RouxLog, RouxNetwork, noopLog } from '../types';
import { IHttpEndpoint, requestJson } from '../link/http';
import { bitcoinNetwork, coinKindOf } from './key-wallet';

bitcoin.initEccLib(ecc);

export interface IClnWalletOptions {
	host: string;
	/** clnrest port (default 3010). */
	port?: number;
	/** A rune allowing getinfo, listfunds, listtransactions, newaddr, reserveinputs, unreserveinputs, signpsbt. */
	rune: string;
	network: RouxNetwork;
	https?: boolean;
	ca?: IHttpEndpoint['ca'];
	rejectUnauthorized?: boolean;
	/**
	 * Raw transaction lookup for transactions CLN's wallet did not see (the
	 * LSP's inputs in the negotiated funding). Optional: without it only
	 * fundings whose every input is a CLN transaction can be verified.
	 */
	getTransaction?: (txidHex: string) => Promise<Buffer>;
	/** Blocks a reservation lasts (default 144; CLN's own default is 72). */
	reserveBlocks?: number;
	log?: RouxLog;
}

interface IClnOutput {
	txid: string;
	output: number;
	amount_msat: number | string;
	scriptpubkey: string;
	address?: string;
	status: 'unconfirmed' | 'confirmed' | 'spent' | 'immature';
	reserved: boolean;
	blockheight?: number;
}

interface IClnReservation {
	txid: string;
	vout: number;
	reserved: boolean;
	reserved_to_block?: number;
}

interface IClnTransaction {
	hash: string;
	rawtx: string;
	blockheight: number;
	inputs: Array<{ txid: string; index: number }>;
}

interface ICoin extends directFunding.IDfSenderCoin {
	kind: 'p2wpkh' | 'p2tr';
	reserved: boolean;
}

export class ClnWallet implements directFunding.IDfSenderWallet {
	private readonly ep: IHttpEndpoint;
	private readonly network: bitcoin.Network;
	private readonly log: RouxLog;
	private readonly coins = new Map<string, ICoin>();
	private transactions = new Map<string, IClnTransaction>();
	private tip = 0;
	private walletQueue: Promise<void> = Promise.resolve();

	constructor(private readonly options: IClnWalletOptions) {
		if (
			options.reserveBlocks !== undefined &&
			(!Number.isInteger(options.reserveBlocks) ||
				options.reserveBlocks < 1 ||
				options.reserveBlocks > 0x7fffffff)
		) {
			throw new Error('reserveBlocks must be a positive block count');
		}
		this.ep = {
			host: options.host,
			port: options.port ?? 3010,
			https: options.https,
			ca: options.ca,
			rejectUnauthorized: options.rejectUnauthorized,
			headers: { Rune: options.rune }
		};
		this.network = bitcoinNetwork(options.network);
		this.log = options.log ?? noopLog;
	}

	async refresh(): Promise<void> {
		return this.serialize(() => this.refreshSnapshot());
	}

	private async refreshSnapshot(): Promise<void> {
		const [info, funds, txs] = await Promise.all([
			this.rpc<{ blockheight: number }>('getinfo', {}),
			this.rpc<{ outputs?: IClnOutput[] }>('listfunds', {}),
			this.rpc<{ transactions?: IClnTransaction[] }>('listtransactions', {})
		]);
		this.tip = Number(info.blockheight);
		this.coins.clear();
		for (const o of funds.outputs ?? []) {
			if (o.status === 'spent') {
				this.coins.delete(`${o.txid}:${o.output}`);
				continue;
			}
			const script = Buffer.from(o.scriptpubkey, 'hex');
			const kind = coinKindOf(script);
			if (!kind) continue;
			this.coins.set(`${o.txid}:${o.output}`, {
				txidHex: o.txid,
				vout: o.output,
				valueSat: BigInt(o.amount_msat) / 1000n,
				script,
				height: o.status === 'confirmed' ? Number(o.blockheight ?? 0) : 0,
				kind,
				reserved: o.reserved
			});
		}
		this.transactions = new Map(
			(txs.transactions ?? []).map((t) => [t.hash, t])
		);
	}

	// ─────────────── IDfSenderWallet ───────────────

	listSpendable(): directFunding.IDfSenderCoin[] {
		return [...this.coins.values()]
			.filter((c) => !c.reserved && c.height > 0)
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
		const known = this.transactions.get(txidHex);
		if (known?.rawtx) return Buffer.from(known.rawtx, 'hex');
		if (this.options.getTransaction)
			return this.options.getTransaction(txidHex);
		throw new Error(
			`CLN does not hold transaction ${txidHex} and no getTransaction was given`
		);
	}

	async changeScript(): Promise<Buffer> {
		const res = await this.rpc<{ bech32: string }>('newaddr', {
			addresstype: 'bech32'
		});
		return bitcoin.address.toOutputScript(res.bech32, this.network);
	}

	signerFor(
		coin: directFunding.IDfSenderCoin
	): directFunding.IDfCoinSigner | null {
		const known = this.coins.get(`${coin.txidHex}:${coin.vout}`);
		if (!known) return null;
		return {
			kind: known.kind,
			// For P2TR the output key is in the script. For P2WPKH the key is
			// only learned from the probe signature; the engine takes it from
			// there (signOwnershipProbe) and this placeholder is never sent.
			ownershipPubkey:
				known.kind === 'p2tr' ? known.script.subarray(2, 34) : Buffer.alloc(33),
			signOwnership: (): Buffer => {
				throw new Error(
					'CLN signs transactions, not digests; the probe proof is used'
				);
			},
			signOwnershipProbe: (
				tx,
				prevouts
			): Promise<{ pubkey: Buffer; signature: Buffer }> =>
				this.signProbe(known, tx, prevouts),
			signInput: (tx, inputIndex, prevouts): Promise<Buffer[]> =>
				this.signFunding(known, tx, inputIndex, prevouts)
		};
	}

	async freezeUtxo(txidHex: string, vout: number): Promise<boolean> {
		return this.serialize(() => this.reserveCoin(txidHex, vout));
	}

	private async reserveCoin(txidHex: string, vout: number): Promise<boolean> {
		const coin = this.coins.get(`${txidHex}:${vout}`);
		if (!coin) return false;
		try {
			const res = await this.rpc<{ reservations: IClnReservation[] }>(
				'reserveinputs',
				{
					psbt: this.onlyInputPsbt(coin).toBase64(),
					exclusive: true,
					reserve: this.options.reserveBlocks ?? 144
				}
			);
			if (
				!res.reservations.some(
					(r) => r.txid === txidHex && r.vout === vout && r.reserved
				)
			) {
				throw new Error('CLN did not reserve the requested input');
			}
		} catch (err) {
			this.log('cln_reserve_failed', {
				outpoint: `${txidHex}:${vout}`,
				error: String(err)
			});
			return false;
		}
		coin.reserved = true;
		return true;
	}

	async unfreezeUtxo(txidHex: string, vout: number): Promise<boolean> {
		return this.serialize(async () => {
			// Startup recovery may run before the first wallet refresh.
			if (!this.coins.has(`${txidHex}:${vout}`)) await this.refreshSnapshot();
			return this.releaseCoin(txidHex, vout);
		});
	}

	private async releaseCoin(txidHex: string, vout: number): Promise<boolean> {
		const coin = this.coins.get(`${txidHex}:${vout}`);
		if (!coin) return false;
		try {
			const res = await this.rpc<{ reservations: IClnReservation[] }>(
				'unreserveinputs',
				{
					psbt: this.onlyInputPsbt(coin).toBase64(),
					reserve: this.options.reserveBlocks ?? 144
				}
			);
			const state = res.reservations.find(
				(r) => r.txid === txidHex && r.vout === vout
			);
			if (!state) throw new Error('CLN did not report the released input');
			coin.reserved = state.reserved;
			return !state.reserved;
		} catch (err) {
			this.log('cln_unreserve_failed', {
				outpoint: `${txidHex}:${vout}`,
				error: String(err)
			});
			return false;
		}
	}

	blockHeight(): number {
		return this.tip;
	}

	txStatus(txidHex: string): { known: boolean; confirmed: boolean } | null {
		const tx = this.transactions.get(txidHex);
		if (!tx) return null;
		return { known: true, confirmed: Number(tx.blockheight) > 0 };
	}

	confirmedSpendOf(txidHex: string, vout: number): string | null {
		for (const tx of this.transactions.values()) {
			if (Number(tx.blockheight) <= 0) continue;
			if ((tx.inputs ?? []).some((i) => i.txid === txidHex && i.index === vout))
				return tx.hash;
		}
		return null;
	}

	// ─────────────── Signing ───────────────

	private async signProbe(
		coin: ICoin,
		tx: bitcoin.Transaction,
		prevouts: { scripts: Buffer[]; values: bigint[] }
	): Promise<{ pubkey: Buffer; signature: Buffer }> {
		// Reserve only this coin. Signing does not add another reservation.
		// A refused or malformed signature still releases the temporary hold.
		if (!(await this.freezeUtxo(coin.txidHex, coin.vout))) {
			throw new Error('Could not reserve the ownership proof input');
		}
		let signed: bitcoin.Psbt;
		let released = false;
		try {
			signed = await this.signWith(this.psbtFor(tx, prevouts), 0);
		} finally {
			released = await this.unfreezeUtxo(coin.txidHex, coin.vout);
		}
		if (!released) {
			throw new Error('Could not release the ownership proof reservation');
		}
		const input = signed.data.inputs[0];
		if (coin.kind === 'p2tr') {
			if (!input.tapKeySig)
				throw new Error('CLN did not sign the taproot probe input');
			return {
				pubkey: Buffer.alloc(33),
				signature: Buffer.from(input.tapKeySig).subarray(0, 64)
			};
		}
		const partial = input.partialSig?.[0];
		if (!partial) throw new Error('CLN did not sign the P2WPKH probe input');
		return {
			pubkey: Buffer.from(partial.pubkey),
			signature: Buffer.from(
				bitcoin.script.signature.decode(Buffer.from(partial.signature))
					.signature
			)
		};
	}

	private async signFunding(
		coin: ICoin,
		tx: bitcoin.Transaction,
		inputIndex: number,
		prevouts: { scripts: Buffer[]; values: bigint[] }
	): Promise<Buffer[]> {
		const signed = await this.signWith(this.psbtFor(tx, prevouts), inputIndex);
		const input = signed.data.inputs[inputIndex];
		if (coin.kind === 'p2tr') {
			if (!input.tapKeySig)
				throw new Error('CLN did not sign the taproot funding input');
			return [Buffer.from(input.tapKeySig)];
		}
		const partial = input.partialSig?.[0];
		if (!partial) throw new Error('CLN did not sign the P2WPKH funding input');
		return [Buffer.from(partial.signature), Buffer.from(partial.pubkey)];
	}

	private psbtFor(
		tx: bitcoin.Transaction,
		prevouts: { scripts: Buffer[]; values: bigint[] }
	): bitcoin.Psbt {
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
		return psbt;
	}

	private async signWith(
		psbt: bitcoin.Psbt,
		inputIndex: number
	): Promise<bitcoin.Psbt> {
		const b64 = psbt.toBase64();
		// The engine freezes before funding signing. The proof owns a separate
		// temporary reservation. Re-reserving here would extend CLN's deadline
		// and leave an unmatched reservation after cleanup.
		const res = await this.rpc<{ signed_psbt: string }>('signpsbt', {
			psbt: b64,
			signonly: [inputIndex]
		});
		return bitcoin.Psbt.fromBase64(res.signed_psbt, { network: this.network });
	}

	private onlyInputPsbt(coin: ICoin): bitcoin.Psbt {
		const psbt = new bitcoin.Psbt({ network: this.network });
		psbt.addInput({
			hash: coin.txidHex,
			index: coin.vout,
			sequence: 0xfffffffd,
			witnessUtxo: { script: coin.script, value: Number(coin.valueSat) }
		});
		psbt.addOutput({ script: Buffer.from([0x6a]), value: 0 });
		return psbt;
	}

	/** Keep snapshots and reservation mutations in RPC order. */
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.walletQueue.then(operation);
		this.walletQueue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	private rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
		return requestJson<T>(this.ep, 'POST', `/v1/${method}`, params);
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
