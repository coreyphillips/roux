/**
 * Where the swap records live: one JSON document per direction under the
 * keys `swaps:reverse` and `swaps:submarine` of the host's
 * IWalletDataStorage.
 *
 * Unlike the direct-funding payment record, a swap record is key material
 * by default: a reverse record holds the claim private key and the
 * preimage, a submarine record the refund private key, because a claim or
 * refund after a crash needs exactly those. A host must then treat the
 * storage it hands roux as it would a wallet file (encrypt at rest,
 * restrict its mode). With an ISwapSecretProvider (`swaps.secrets`, see
 * secrets.ts) the records hold only public material and the id the secrets
 * derive from, and the provider's seed is what needs the wallet file's
 * care; the records still have to be durable, since losing the id loses
 * the secrets with it.
 */

import { IWalletDataStorage } from '../storage';
import { IReverseSwapRecord, ISubmarineSwapRecord, SwapError } from './types';

export const REVERSE_SWAP_STORAGE_KEY = 'swaps:reverse';
export const SUBMARINE_SWAP_STORAGE_KEY = 'swaps:submarine';

interface IDocument<T> {
	version: 1;
	swaps: Record<string, T>;
}

interface ISwapRecordLike {
	swapIdHex: string;
	paymentHashHex: string;
}

export class SwapStore<T extends ISwapRecordLike> {
	private doc: IDocument<T> | null = null;

	constructor(
		private readonly storage: IWalletDataStorage,
		private readonly key: string,
		private readonly label: string
	) {}

	/**
	 * Read the document. A damaged one (not JSON, or not this shape) is
	 * NEVER treated as empty: it may hold the only copy of a key, and
	 * starting fresh would let the next write bury it. The bytes are kept
	 * under a dated `<key>.damaged.<time>` key and the error names that
	 * key, so an operator can recover the records by hand.
	 */
	restore(): T[] {
		const raw = this.storage.loadWalletData(this.key);
		let doc: IDocument<T> = { version: 1, swaps: {} };
		if (raw) {
			let problem: string | null = null;
			try {
				const parsed = JSON.parse(raw) as Partial<IDocument<T>>;
				if (
					parsed &&
					parsed.version === 1 &&
					parsed.swaps &&
					typeof parsed.swaps === 'object'
				) {
					doc = { version: 1, swaps: parsed.swaps };
				} else {
					problem = 'not a version 1 swap document';
				}
			} catch (err) {
				problem = err instanceof Error ? err.message : String(err);
			}
			if (problem) {
				const kept = `${this.key}.damaged.${Date.now()}`;
				try {
					this.storage.saveWalletData(kept, raw);
				} catch {
					/* the original stays where it is */
				}
				throw new SwapError(
					`${this.label} swap store is damaged (${problem}); the bytes were kept ` +
						`under "${kept}" and nothing was overwritten`,
					'storage'
				);
			}
		}
		this.doc = doc;
		return this.list();
	}

	private load(): IDocument<T> {
		if (!this.doc) this.restore();
		return this.doc!;
	}

	list(): T[] {
		return Object.values(this.load().swaps).map((r) => ({ ...r }));
	}

	get(swapIdHex: string): T | null {
		const r = this.load().swaps[swapIdHex];
		return r ? { ...r } : null;
	}

	has(paymentHashHex: string): boolean {
		return this.list().some((r) => r.paymentHashHex === paymentHashHex);
	}

	/** Write the record; synchronous, and FileStorage makes it atomic. */
	upsert(record: T & { updatedAt?: number }): T {
		const doc = this.load();
		const stored = { ...record, updatedAt: Date.now() };
		doc.swaps[record.swapIdHex] = stored;
		this.storage.saveWalletData(this.key, JSON.stringify(doc));
		return { ...stored };
	}
}

export class ReverseSwapStore extends SwapStore<IReverseSwapRecord> {
	constructor(storage: IWalletDataStorage) {
		super(storage, REVERSE_SWAP_STORAGE_KEY, 'reverse');
	}
}

export class SubmarineSwapStore extends SwapStore<ISubmarineSwapRecord> {
	constructor(storage: IWalletDataStorage) {
		super(storage, SUBMARINE_SWAP_STORAGE_KEY, 'submarine');
	}
}
