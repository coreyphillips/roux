/**
 * boltz-client counts a swap by its Lightning amount (the invoice), roux
 * by its on-chain amount (the contract). These find the on-chain amount
 * whose quote lands on a given invoice amount, asking the provider rather
 * than re-deriving its fee schedule: the fee is a non-decreasing step
 * function of the amount (flat, rounded-up ppm, miner), so a fixed-point
 * iteration from below settles in a few quotes.
 */

/** The provider's total fee (sat) for an on-chain amount (sat). */
export type FeeQuote = (onchainSat: bigint) => Promise<bigint>;

const MAX_STEPS = 16;

function memo(feeOf: FeeQuote): FeeQuote {
	const seen = new Map<bigint, Promise<bigint>>();
	return (amount) => {
		let fee = seen.get(amount);
		if (!fee) {
			fee = feeOf(amount);
			seen.set(amount, fee);
		}
		return fee;
	};
}

/**
 * Submarine: roux mints the invoice for onchain - fee(onchain) - slack.
 * Returns the on-chain amount whose invoice is exactly `invoiceSat`.
 */
export async function submarineOnchainFor(
	invoiceSat: bigint,
	feeQuote: FeeQuote,
	slackSat: bigint
): Promise<bigint> {
	if (invoiceSat <= 0n) throw new Error('amount must be positive');
	const feeOf = memo(feeQuote);
	// g(x) = invoice + slack + fee(x) rises by at most one per unit of x, so
	// iterating it from below reaches its least fixed point exactly.
	let onchain = invoiceSat + slackSat;
	for (let step = 0; step < MAX_STEPS; step++) {
		const next = invoiceSat + slackSat + (await feeOf(onchain));
		if (next === onchain) return onchain;
		onchain = next;
	}
	throw new Error(
		`the provider's fee did not settle for a ${invoiceSat} sat invoice`
	);
}

/**
 * Reverse: the provider mints the invoice for onchain + fee(onchain).
 * Returns the largest on-chain amount whose invoice does not exceed
 * `invoiceSat` (exact whenever the fee's steps allow it).
 */
export async function reverseOnchainFor(
	invoiceSat: bigint,
	feeQuote: FeeQuote
): Promise<bigint> {
	const feeOf = memo(feeQuote);
	const fits = async (x: bigint): Promise<boolean> =>
		x > 0n && x + (await feeOf(x)) <= invoiceSat;
	let onchain = invoiceSat - (await feeOf(invoiceSat));
	if (!(await fits(onchain))) {
		throw new Error(`a ${invoiceSat} sat invoice does not cover the fee`);
	}
	for (let step = 0; step < MAX_STEPS; step++) {
		const candidate = invoiceSat - (await feeOf(onchain));
		if (candidate <= onchain) return onchain;
		if (await fits(candidate)) {
			onchain = candidate;
			continue;
		}
		// The candidate overshoots a fee step: the largest fit lies between.
		for (let y = candidate - 1n; y > onchain; y--) {
			if (await fits(y)) return y;
		}
		return onchain;
	}
	return onchain;
}
