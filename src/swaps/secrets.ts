/**
 * Swap secrets the record does not hold.
 *
 * A reverse swap needs a preimage and a claim key, a submarine swap a
 * refund key, and a claim or refund after a crash needs exactly those. The
 * plain way to survive the crash is to write them next to the terms, which
 * makes the swap document a wallet file. The other way is this seam: the
 * host's wallet derives them from a seed it already protects, the record
 * keeps only the 16-byte id they were derived from, and roux asks again
 * whenever it has to sign.
 *
 * What comes back is always checked against the public material the record
 * does hold, the payment hash and the claim or refund public key. A seed
 * file pointed at the wrong swap document derives keys that are valid and
 * useless, and the check turns that into an error instead of a transaction
 * that pays nobody.
 *
 * One preimage still reaches the record either way: the one the node
 * reports on a settled payment, under `payment.preimageHex`. By then the
 * claim has disclosed it on chain, which is how the provider settled the
 * hold, so it is a receipt rather than a secret.
 *
 * `FileSecretProvider` is the implementation roux ships, because neither
 * `LndWallet` nor `ClnWallet` can hand out a scalar from the node's seed
 * over REST. Its seed file is the thing to guard now: mode 0600, backed up
 * with the swap document, and worth as much as the swaps in flight.
 */

import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { crypto as bcrypto } from 'beignet/lightning';
import {
	IReverseSwapRecord,
	ISubmarineSwapRecord,
	ISwapRecordSecrets,
	ISwapSecretProvider,
	SwapError
} from './types';

/** Bytes in the id a swap's secrets are derived from (beignet's swap id size). */
export const SWAP_SECRET_ID_BYTES = 16;

/** A fresh, non-secret id for one swap's secrets. */
export function newSwapSecretId(): string {
	return crypto.randomBytes(SWAP_SECRET_ID_BYTES).toString('hex');
}

const FILE_SECRET_SALT = Buffer.from('roux-swap-secrets-v1');

/**
 * Secrets derived from a seed file of 32 random bytes, created with mode
 * 0600 on first use. HKDF-SHA256 over the seed with the swap's id and the
 * role as info; the counter only matters for the astronomically unlikely
 * out-of-range scalar.
 *
 * Losing this file loses every swap that has not resolved: the contract can
 * no longer be claimed or refunded. Back it up with the swap document, and
 * on a host whose wallet can derive from a seed of its own, implement
 * `ISwapSecretProvider` over that instead.
 */
export class FileSecretProvider implements ISwapSecretProvider {
	readonly id: string;
	private seed: Buffer | null = null;

	constructor(
		private readonly filePath: string,
		/** Recorded on every swap, so `resume()` can recognise it; default `file`. */
		opts: { id?: string } = {}
	) {
		this.id = opts.id ?? 'file';
	}

	derivePreimage(idHex: string): Buffer {
		return this.expand(idHex, 'preimage', 0);
	}

	deriveClaimKey(idHex: string): Buffer {
		return this.scalar(idHex, 'claim');
	}

	deriveRefundKey(idHex: string): Buffer {
		return this.scalar(idHex, 'refund');
	}

	private scalar(idHex: string, role: string): Buffer {
		for (let counter = 0; counter < 256; counter++) {
			const candidate = this.expand(idHex, role, counter);
			if (bcrypto.isValidPrivateKey(candidate)) return candidate;
		}
		throw new SwapError(
			`${role} key derivation exhausted its counter`,
			'secrets'
		);
	}

	private expand(idHex: string, role: string, counter: number): Buffer {
		const id = Buffer.from(idHex, 'hex');
		if (id.length !== SWAP_SECRET_ID_BYTES || id.toString('hex') !== idHex) {
			throw new SwapError(
				`a swap secret id must be ${SWAP_SECRET_ID_BYTES} bytes of hex`,
				'secrets'
			);
		}
		const info = Buffer.concat([
			id,
			Buffer.from(role, 'utf8'),
			Buffer.from([counter])
		]);
		return Buffer.from(
			crypto.hkdfSync('sha256', this.load(), FILE_SECRET_SALT, info, 32)
		);
	}

	private load(): Buffer {
		if (this.seed) return this.seed;
		let raw: string | null = null;
		try {
			raw = fs.readFileSync(this.filePath, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
		if (raw === null) {
			const seed = crypto.randomBytes(32);
			fs.mkdirSync(path.dirname(this.filePath), {
				recursive: true,
				mode: 0o700
			});
			// wx: another process that created the seed between the read and
			// here wins, and we read its bytes rather than overwrite them.
			try {
				fs.writeFileSync(this.filePath, seed.toString('hex'), {
					mode: 0o600,
					flag: 'wx'
				});
				this.seed = seed;
				return this.seed;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
				raw = fs.readFileSync(this.filePath, 'utf8');
			}
		}
		this.assertPrivate();
		const seed = Buffer.from(raw.trim(), 'hex');
		if (seed.length < 32) {
			throw new SwapError(
				`the seed file "${this.filePath}" is not at least 32 bytes of hex`,
				'secrets'
			);
		}
		this.seed = seed;
		return this.seed;
	}

	/** A seed anyone on the box can read is not a seed. Windows fakes the bits. */
	private assertPrivate(): void {
		if (process.platform === 'win32') return;
		const mode = fs.statSync(this.filePath).mode & 0o777;
		if (mode & 0o077) {
			throw new SwapError(
				`the seed file "${this.filePath}" is readable beyond its owner ` +
					`(mode 0${mode.toString(8)}); run chmod 600 on it`,
				'secrets'
			);
		}
	}
}

/**
 * Why this record's secrets cannot be derived here, as text, or null when
 * they can. `resume()` asks per record so one record from another host's
 * wallet cannot sink the rest of the batch.
 */
export function swapSecretsProblem(
	record: { secrets?: ISwapRecordSecrets },
	provider?: ISwapSecretProvider
): string | null {
	const named = record.secrets;
	if (!named) return null;
	if (!provider) {
		return `its secrets are derived by "${named.provider}", which this client was not given (pass swaps.secrets)`;
	}
	if (provider.id !== named.provider) {
		return `its secrets are derived by "${named.provider}", but swaps.secrets is "${provider.id}"`;
	}
	return null;
}

function deriver(
	record: { secrets?: ISwapRecordSecrets },
	provider?: ISwapSecretProvider
): ISwapSecretProvider {
	const problem = swapSecretsProblem(record, provider);
	if (problem)
		throw new SwapError(`this swap cannot be signed: ${problem}`, 'secrets');
	return provider!;
}

function assertScalar(
	derived: Buffer,
	pubkeyHex: string,
	role: string,
	providerId: string
): Buffer {
	// A provider may answer with any Uint8Array; the copy is what beignet's
	// builders take, and it cannot change under them afterwards.
	const key = Buffer.from(derived);
	if (key.length !== 32 || !bcrypto.isValidPrivateKey(key)) {
		throw new SwapError(
			`"${providerId}" derived a ${role} key that is not a valid 32-byte scalar`,
			'secrets'
		);
	}
	if (bcrypto.getPublicKey(key).toString('hex') !== pubkeyHex) {
		throw new SwapError(
			`the ${role} key "${providerId}" derived is not this swap's ${role} key: the wrong seed?`,
			'secrets'
		);
	}
	return key;
}

/** The claim key and preimage: off the record, or derived and checked. */
export async function reverseSwapSecrets(
	record: IReverseSwapRecord,
	provider?: ISwapSecretProvider
): Promise<{ privateKey: Buffer; preimage: Buffer }> {
	if (!record.secrets) {
		if (!record.claimPrivkeyHex || !record.preimageHex) {
			throw new SwapError(
				'the record holds neither the claim key and preimage nor the provider that derives them',
				'secrets'
			);
		}
		return {
			privateKey: Buffer.from(record.claimPrivkeyHex, 'hex'),
			preimage: Buffer.from(record.preimageHex, 'hex')
		};
	}
	const secrets = deriver(record, provider);
	const idHex = record.secrets.idHex;
	const preimage = Buffer.from(await secrets.derivePreimage(idHex));
	const hash = crypto.createHash('sha256').update(preimage).digest('hex');
	if (hash !== record.paymentHashHex) {
		throw new SwapError(
			`the preimage "${secrets.id}" derived does not hash to this swap's payment hash: the wrong seed?`,
			'secrets'
		);
	}
	const privateKey = assertScalar(
		await secrets.deriveClaimKey(idHex),
		record.claimPubkeyHex,
		'claim',
		secrets.id
	);
	return { privateKey, preimage };
}

/** The refund key: off the record, or derived and checked. */
export async function submarineRefundKey(
	record: ISubmarineSwapRecord,
	provider?: ISwapSecretProvider
): Promise<Buffer> {
	if (!record.secrets) {
		if (!record.refundPrivkeyHex) {
			throw new SwapError(
				'the record holds neither the refund key nor the provider that derives it',
				'secrets'
			);
		}
		return Buffer.from(record.refundPrivkeyHex, 'hex');
	}
	const secrets = deriver(record, provider);
	return assertScalar(
		await secrets.deriveRefundKey(record.secrets.idHex),
		record.refundPubkeyHex,
		'refund',
		secrets.id
	);
}
