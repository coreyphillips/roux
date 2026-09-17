/**
 * Pure checks a client runs before it pays and before it claims. No I/O:
 * the caller supplies what it sent, what came back, its own height and its
 * policy, and gets a verdict or a typed SwapError.
 */

import * as bitcoin from 'bitcoinjs-lib';
import { crypto as bcrypto, swaps } from 'beignet/lightning';
import { RouxNetwork, toBeignetNetwork } from '../types';
import { ISwapChainOutput, ISwapClientPolicy, SwapError } from './types';
import { invoice as beignetInvoice } from 'beignet/lightning';

export interface IVerifiedReverseTerms {
	htlc: swaps.ISwapHtlc;
	address: string;
	outputScript: Buffer;
	invoiceAmountMsat: bigint;
	invoiceExpiresAt: number;
	totalFeeSat: bigint;
}

export interface IVerifyReverseAckParams {
	create: swaps.ISwapCreate;
	ack: swaps.ISwapCreateAck;
	currentHeight: number;
	network: RouxNetwork;
	policy: ISwapClientPolicy;
	/** The most this client will pay above the on-chain amount. */
	maxTotalFeeSat: bigint;
}

/**
 * The ack must describe the swap the client asked for and nothing else:
 * beignet's own verifier rebuilds the contract and checks the invoice and
 * amounts; this adds the swap id, the refund key and the client's policy.
 */
export function verifyReverseAck(
	params: IVerifyReverseAckParams
): IVerifiedReverseTerms {
	const { ack, create } = params;
	if (!ack.accepted || !ack.terms) {
		throw new SwapError(
			`provider declined: ${swaps.SwapRefusalReason[ack.reason] ?? ack.reason}${
				ack.reasonText ? ` (${ack.reasonText})` : ''
			}`,
			'provider_declined'
		);
	}
	const terms = ack.terms;
	if (terms.swapId.length !== 16 || terms.swapId.equals(Buffer.alloc(16))) {
		throw new SwapError('ack carries no swap id', 'ack_mismatch');
	}
	if (!bcrypto.isValidPublicKey(terms.refundPubkey)) {
		throw new SwapError('refund key is not a valid public key', 'ack_mismatch');
	}
	const delta = terms.refundHeight - params.currentHeight;
	if (delta < params.policy.minRefundDeltaBlocks) {
		throw new SwapError(
			`refund height ${terms.refundHeight} is only ${delta} blocks away (policy minimum ${params.policy.minRefundDeltaBlocks})`,
			'refund_too_soon'
		);
	}
	if (delta > params.policy.maxRefundDeltaBlocks) {
		throw new SwapError(
			`refund height ${terms.refundHeight} is ${delta} blocks away (policy maximum ${params.policy.maxRefundDeltaBlocks})`,
			'refund_too_late'
		);
	}
	const verdict = swaps.verifyReverseSwapTerms({
		create,
		ack,
		currentHeight: params.currentHeight,
		network: toBeignetNetwork(params.network),
		minRefundDelta: params.policy.minRefundDeltaBlocks,
		maxRefundDelta: params.policy.maxRefundDeltaBlocks,
		maxTotalFeeSat: params.maxTotalFeeSat
	});
	if (!verdict.ok) {
		throw new SwapError(verdict.reason, 'ack_mismatch');
	}
	return {
		htlc: verdict.htlc,
		address: verdict.address,
		outputScript: verdict.outputScript,
		invoiceAmountMsat: verdict.invoice.amountMsat,
		invoiceExpiresAt: verdict.invoice.expiresAt,
		totalFeeSat: terms.totalFeeSat
	};
}

export interface IVerifiedSubmarineTerms {
	htlc: swaps.ISwapHtlc;
	address: string;
	outputScript: Buffer;
	invoiceAmountMsat: bigint;
	totalFeeSat: bigint;
	minerFeeSat: bigint;
	fundingConfirmations: number;
	/** The provider stops watching for funding after this (unix seconds). */
	expiresAt: number;
	invoiceExpiresAt: number;
	invoiceMinFinalCltv: number;
	paymentCeilingHeight?: number;
}

export interface IVerifySubmarineAckParams {
	create: swaps.ISwapSubmarineCreate;
	ack: swaps.ISwapSubmarineCreateAck;
	currentHeight: number;
	network: RouxNetwork;
	policy: ISwapClientPolicy;
	/** The most this client will give up below the on-chain amount. */
	maxTotalFeeSat: bigint;
}

/**
 * The CLTV fit, the client's own principal rule for a submarine swap: our
 * node may hold the provider's HTLC for the invoice's final CLTV plus the
 * route budget, and no such HTLC may live past refundHeight minus the
 * claim margin, since past that our refund and the provider's claim race.
 */
export function submarineCltvProblem(params: {
	currentHeight: number;
	refundHeight: number;
	fundingConfirmations: number;
	invoiceMinFinalCltv: number;
	policy: ISwapClientPolicy;
}): string | null {
	const latest =
		params.currentHeight +
		params.fundingConfirmations +
		params.invoiceMinFinalCltv +
		params.policy.routeBudgetBlocks;
	const limit = params.refundHeight - params.policy.claimSafetyBlocks;
	if (latest > limit) {
		return (
			`an HTLC for this invoice could be held until ${latest}, past the ` +
			`refund height ${params.refundHeight} minus the ${params.policy.claimSafetyBlocks} block safety margin`
		);
	}
	return null;
}

/**
 * The ack must describe the swap the client asked for and nothing else:
 * beignet's own verifier rebuilds the contract from OUR refund key and the
 * provider's claim key and checks our invoice and the amounts; this adds
 * the swap id, the claim key, the provider's funding depth, the client's
 * refund window and the CLTV fit.
 */
export function verifySubmarineAck(
	params: IVerifySubmarineAckParams
): IVerifiedSubmarineTerms {
	const { ack, create } = params;
	if (!ack.accepted || !ack.terms) {
		throw new SwapError(
			`provider declined: ${swaps.SwapRefusalReason[ack.reason] ?? ack.reason}${
				ack.reasonText ? ` (${ack.reasonText})` : ''
			}`,
			'provider_declined'
		);
	}
	const terms = ack.terms;
	if (terms.swapId.length !== 16 || terms.swapId.equals(Buffer.alloc(16))) {
		throw new SwapError('ack carries no swap id', 'ack_mismatch');
	}
	if (!bcrypto.isValidPublicKey(terms.claimPubkey)) {
		throw new SwapError('claim key is not a valid public key', 'ack_mismatch');
	}
	if (terms.claimPubkey.equals(create.refundPubkey)) {
		throw new SwapError('claim key equals our refund key', 'ack_mismatch');
	}
	const delta = terms.refundHeight - params.currentHeight;
	if (delta < params.policy.minRefundDeltaBlocks) {
		throw new SwapError(
			`refund height ${terms.refundHeight} is only ${delta} blocks away (policy minimum ${params.policy.minRefundDeltaBlocks})`,
			'refund_too_soon'
		);
	}
	if (delta > params.policy.maxRefundDeltaBlocks) {
		throw new SwapError(
			`refund height ${terms.refundHeight} is ${delta} blocks away (policy maximum ${params.policy.maxRefundDeltaBlocks})`,
			'refund_too_late'
		);
	}
	if (
		terms.fundingConfirmations < 1 ||
		terms.fundingConfirmations > params.policy.maxProviderFundingConfirmations
	) {
		throw new SwapError(
			`provider wants ${terms.fundingConfirmations} funding confirmations (policy allows 1 to ${params.policy.maxProviderFundingConfirmations})`,
			'ack_mismatch'
		);
	}
	const verdict = swaps.verifySubmarineSwapTerms({
		create,
		ack,
		currentHeight: params.currentHeight,
		network: toBeignetNetwork(params.network),
		minRefundDelta: params.policy.minRefundDeltaBlocks,
		maxRefundDelta: params.policy.maxRefundDeltaBlocks,
		maxTotalFeeSat: params.maxTotalFeeSat
	});
	if (!verdict.ok) {
		throw new SwapError(verdict.reason, 'ack_mismatch');
	}
	const cltv = submarineCltvProblem({
		currentHeight: params.currentHeight,
		refundHeight: terms.refundHeight,
		fundingConfirmations: terms.fundingConfirmations,
		invoiceMinFinalCltv: verdict.invoice.minFinalCltvExpiry,
		policy: params.policy
	});
	if (cltv) throw new SwapError(cltv, 'cltv_unsafe');
	return {
		htlc: verdict.htlc,
		address: verdict.address,
		outputScript: verdict.outputScript,
		invoiceAmountMsat: verdict.invoice.amountMsat,
		totalFeeSat: terms.totalFeeSat,
		minerFeeSat: terms.minerFeeSat,
		fundingConfirmations: terms.fundingConfirmations,
		expiresAt: terms.expiresAt,
		invoiceExpiresAt: verdict.invoice.expiresAt,
		invoiceMinFinalCltv: verdict.invoice.minFinalCltvExpiry,
		paymentCeilingHeight: terms.paymentCeilingHeight
	};
}

/** Decode an invoice the host supplied for a submarine swap. */
export function decodeSuppliedInvoice(bolt11: string): {
	paymentHash: Buffer;
	amountMsat: bigint | undefined;
	minFinalCltvExpiry: number;
	expiresAt: number;
	network: ReturnType<typeof beignetInvoice.decode>['network'];
} {
	let decoded: ReturnType<typeof beignetInvoice.decode>;
	try {
		decoded = beignetInvoice.decode(bolt11);
	} catch (err) {
		throw new SwapError(
			`invoice does not decode: ${
				err instanceof Error ? err.message : String(err)
			}`,
			'invoice'
		);
	}
	return {
		paymentHash: decoded.paymentHash,
		amountMsat: decoded.amountMsat,
		minFinalCltvExpiry:
			decoded.minFinalCltvExpiry ??
			beignetInvoice.DEFAULT_MIN_FINAL_CLTV_EXPIRY,
		expiresAt:
			decoded.timestamp + (decoded.expiry ?? beignetInvoice.DEFAULT_EXPIRY),
		network: decoded.network
	};
}

export type FundingVerdict =
	| { ok: true; valueSat: bigint; confirmations: number; height: number }
	| {
			ok: false;
			reason: 'txid_mismatch' | 'wrong_script' | 'insufficient_value' | 'spent';
	  };

/**
 * A funding output counts only when the bytes hash to the txid the chain
 * named, the output pays the contract script exactly, its value covers the
 * amount, and it is still unspent.
 */
export function verifyFundingOutput(params: {
	txidHex: string;
	tx: bitcoin.Transaction;
	vout: number;
	outputScript: Buffer;
	onchainAmountSat: bigint;
	output: ISwapChainOutput | null;
}): FundingVerdict {
	if (params.tx.getId() !== params.txidHex)
		return { ok: false, reason: 'txid_mismatch' };
	const out = params.tx.outs[params.vout];
	if (!out || !out.script.equals(params.outputScript)) {
		return { ok: false, reason: 'wrong_script' };
	}
	if (BigInt(out.value) < params.onchainAmountSat) {
		return { ok: false, reason: 'insufficient_value' };
	}
	if (!params.output) return { ok: false, reason: 'spent' };
	if (!params.output.script.equals(params.outputScript)) {
		return { ok: false, reason: 'wrong_script' };
	}
	return {
		ok: true,
		valueSat: BigInt(out.value),
		confirmations: params.output.confirmations,
		height: params.output.height
	};
}

/** A native P2WPKH, P2WSH or P2TR script, the only claim destinations. */
export function assertNativeSegwit(script: Buffer): Buffer {
	const ok =
		(script.length === 22 && script[0] === 0x00 && script[1] === 0x14) ||
		(script.length === 34 &&
			(script[0] === 0x00 || script[0] === 0x51) &&
			script[1] === 0x20);
	if (!ok) {
		throw new SwapError(
			'claim destination must be a native P2WPKH, P2WSH or P2TR script',
			'destination'
		);
	}
	return script;
}

export function toOutputScript(address: string, network: RouxNetwork): Buffer {
	const net =
		network === 'mainnet'
			? bitcoin.networks.bitcoin
			: network === 'regtest'
			? bitcoin.networks.regtest
			: bitcoin.networks.testnet;
	return assertNativeSegwit(bitcoin.address.toOutputScript(address, net));
}

/** Is this witness the provider's refund branch of our contract? */
export function isRefundWitness(
	witness: Buffer[],
	witnessScript: Buffer
): boolean {
	return (
		witness.length === 3 &&
		witness[1].length === 0 &&
		witness[2].equals(witnessScript)
	);
}

/** Is this witness the preimage branch of our contract (a claim)? */
export function isClaimWitness(
	witness: Buffer[],
	witnessScript: Buffer
): boolean {
	return (
		witness.length === 4 &&
		witness[1].length === 32 &&
		witness[2].length === 1 &&
		witness[2][0] === 0x01 &&
		witness[3].equals(witnessScript)
	);
}
