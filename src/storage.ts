/**
 * Where roux keeps durable state.
 *
 * Two kinds of durable state live here. The direct-funding PAYMENT record
 * (which coin was offered to which request, the offer bytes, the witness
 * once it left, the receipt once it arrived) holds no private key: the
 * witness is public the moment the transaction is broadcast, though the
 * records do say what this device paid and to whom. The reverse SWAP record
 * (swaps/store.ts) is different: it holds the claim private key and the
 * preimage, because a claim after a crash needs exactly those. A host that
 * runs swaps must treat the storage it hands roux as a wallet file:
 * encrypt it at rest, restrict its mode, back it up. beignet keeps its own
 * records in its encrypted wallet store; roux has no wallet of its own,
 * so the host chooses.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The store shape beignet's engines persist through. */
export interface IWalletDataStorage {
	saveWalletData(key: string, value: string): void;
	loadWalletData(key: string): string | null;
}

/**
 * Records that live only as long as the process. Fine for quotes, tests and
 * a deliberate choice; refused by default for anything that moves funds,
 * since a crash would forget a payment record or a swap's claim key (see
 * `allowEphemeralStorage` on BeignetClient).
 */
export class MemoryStorage implements IWalletDataStorage {
	readonly ephemeral = true as const;
	private readonly rows = new Map<string, string>();

	saveWalletData(key: string, value: string): void {
		this.rows.set(key, value);
	}

	loadWalletData(key: string): string | null {
		return this.rows.get(key) ?? null;
	}
}

/**
 * One JSON file, written atomically (temp file, then rename) with mode 0600.
 * A crash mid-write leaves the previous file intact rather than a truncated
 * one, which matters because a payment record written BEFORE a witness leaves
 * the device is what stops a retry from paying twice.
 */
export class FileStorage implements IWalletDataStorage {
	private rows: Record<string, string> | null = null;

	constructor(private readonly filePath: string) {}

	private load(): Record<string, string> {
		if (this.rows) return this.rows;
		try {
			const raw = fs.readFileSync(this.filePath, 'utf8');
			const parsed = JSON.parse(raw) as unknown;
			this.rows =
				parsed && typeof parsed === 'object' && !Array.isArray(parsed)
					? (parsed as Record<string, string>)
					: {};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
			this.rows = {};
		}
		return this.rows;
	}

	saveWalletData(key: string, value: string): void {
		const rows = this.load();
		rows[key] = value;
		const dir = path.dirname(this.filePath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
		fs.renameSync(tmp, this.filePath);
	}

	loadWalletData(key: string): string | null {
		return this.load()[key] ?? null;
	}
}

/** True for storage that forgets everything when the process exits. */
export function isEphemeralStorage(storage: IWalletDataStorage): boolean {
	return (storage as { ephemeral?: boolean }).ephemeral === true;
}

/**
 * Thrown before any wire traffic when an operation that moves funds would
 * record its state in ephemeral storage it was never told to accept.
 */
export class EphemeralStorageError extends Error {
	constructor(what: string) {
		super(
			`${what} needs durable storage: pass \`storage\` (FileStorage, or your ` +
				"wallet's own) to BeignetClient, or set `allowEphemeralStorage: true` " +
				'to accept that a crash forgets in-flight records'
		);
		this.name = 'EphemeralStorageError';
	}
}
