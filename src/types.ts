/**
 * Shared shapes for roux.
 *
 * roux is a client for the beignet peer protocol: everything a beignet
 * node says to another beignet node about liquidity rides ONE odd BOLT 1
 * message type (44069) that every other implementation ignores. roux puts
 * that same type on the wire from a wallet or node that is not beignet, so a
 * beignet node cannot tell the difference and serves it exactly as it would
 * serve a beignet peer.
 */

import { invoice } from 'beignet/lightning';

/** The networks beignet speaks, by their everyday names. */
export type RouxNetwork = 'mainnet' | 'testnet' | 'regtest' | 'signet';

/** Map an everyday network name onto beignet's bech32-prefix enum. */
export function toBeignetNetwork(network: RouxNetwork): invoice.Network {
	switch (network) {
		case 'mainnet':
			return invoice.Network.MAINNET;
		case 'testnet':
			return invoice.Network.TESTNET;
		case 'signet':
			return invoice.Network.SIGNET;
		case 'regtest':
			return invoice.Network.REGTEST;
		default:
			throw new Error(`unknown network: ${String(network)}`);
	}
}

/**
 * Structured log sink. Every lane, engine and link in roux reports
 * through one of these rather than to the console, so a host decides where
 * diagnostics go. The default is silence.
 */
export type RouxLog = (action: string, data: Record<string, unknown>) => void;

export const noopLog: RouxLog = () => undefined;

/** A console logger, for examples and debugging. */
export function consoleLog(prefix = 'roux'): RouxLog {
	return (action, data): void => {
		console.error(`[${prefix}] ${action}`, JSON.stringify(data, bigintSafe));
	};
}

function bigintSafe(_key: string, value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	if (Buffer.isBuffer(value)) return value.toString('hex');
	return value;
}

/** Satoshi amounts arrive as number or bigint; internally they are bigint. */
export type Sats = bigint | number;

export function toSats(value: Sats, what: string): bigint {
	if (typeof value === 'bigint') {
		if (value < 0n) throw new Error(`${what} must not be negative`);
		return value;
	}
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${what} must be a non-negative integer`);
	}
	return BigInt(value);
}

/** Validate a 33-byte compressed public key in hex. */
export function assertPubkeyHex(value: string, what: string): string {
	const hex = value.toLowerCase();
	if (!/^0[23][0-9a-f]{64}$/.test(hex)) {
		throw new Error(`${what} must be a 33-byte compressed public key in hex`);
	}
	return hex;
}
