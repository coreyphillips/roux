/**
 * A beignet provider as the client sees it: beignet's REAL codecs, a real
 * hold invoice minted with beignet's encoder under the provider's key, and a
 * real contract, with knobs to answer wrongly in every way the client must
 * catch. It can also fund the contract on a MockChain and refund it, using
 * beignet's own transaction builders.
 */

import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { crypto as bcrypto, invoice, message, swaps } from 'beignet/lightning';
import { FakeLink } from './fake-link';
import { MockChain } from './mock-chain';
import { FakePayer } from './fake-payer';

export interface IFakeProviderKnobs {
	flatFeeSat?: bigint;
	feePpm?: number;
	minerFeeSat?: bigint;
	refundDelta?: number;
	silent?: boolean;
	refuse?: swaps.SwapRefusalReason;
	wrongInvoiceHash?: boolean;
	wrongInvoiceAmount?: boolean;
	foreignNetwork?: boolean;
	wrongScript?: boolean;
	refundKeyEqualsClaimKey?: boolean;
	overstateFee?: boolean;
	height?: number;
	// Submarine knobs.
	/** The ack's claim key equals the client's refund key. */
	wrongClaimKey?: boolean;
	/** The ack demands 500 confirmations of the funding. */
	demandDeepFunding?: boolean;
	/** The provider's own claim and resolution margins (fit check). */
	claimSafetyBlocks?: number;
	resolutionSafetyBlocks?: number;
	/** Funding depth before it pays (ack.fundingConfirmations). */
	fundingConfirmations?: number;
	/** The limits it quotes, and refuses an amount outside (defaults 10k, 1M). */
	minSwapSat?: bigint;
	maxSwapSat?: bigint;
}

export interface IFakeSwap {
	direction: 'reverse' | 'submarine';
	swapId: Buffer;
	paymentHash: Buffer;
	claimPubkey: Buffer;
	/** Reverse: the provider's refund key. */
	refundKey: Buffer;
	/** Submarine: the provider's claim key and the client's refund key. */
	claimKey?: Buffer;
	refundPubkey?: Buffer;
	/** Submarine: learned by paying the client's invoice. */
	preimage?: Buffer;
	refundHeight: number;
	onchainAmountSat: bigint;
	outputScript: Buffer;
	address: string;
	bolt11: string;
	fundingTxid?: string;
	fundingVout?: number;
	state: swaps.SwapWireState;
	resolutionTxid?: string;
	resolutionKind?: swaps.SwapWireResolutionKind;
}

export class FakeProvider {
	readonly privkey = crypto.randomBytes(32);
	readonly swaps = new Map<string, IFakeSwap>();
	readonly received: number[] = [];
	knobs: IFakeProviderKnobs = {};
	private readonly off: () => void;

	constructor(readonly link: FakeLink) {
		this.off = link.onCustomMessage((msg) =>
			this.handle(msg.peerPubkey, msg.subtype, msg.payload)
		);
	}

	get id(): string {
		return this.link.id;
	}

	get minSwapSat(): bigint {
		return this.knobs.minSwapSat ?? 10_000n;
	}

	get maxSwapSat(): bigint {
		return this.knobs.maxSwapSat ?? 1_000_000n;
	}

	stop(): void {
		this.off();
	}

	private height(): number {
		return this.knobs.height ?? 1000;
	}

	private fee(amountSat: bigint): { total: bigint; miner: bigint } {
		const miner = this.knobs.minerFeeSat ?? 400n;
		const total = swaps.reverseSwapFee(amountSat, {
			flatFeeSat: this.knobs.flatFeeSat ?? 100n,
			feePpm: this.knobs.feePpm ?? 1_000,
			minerFeeSat: miner
		});
		return { total, miner };
	}

	private handle(peer: string, subtype: number, payload: Buffer): void {
		this.received.push(subtype);
		if (this.knobs.silent) return;
		if (subtype === message.BeignetCustomSubtype.SWAP_QUOTE_REQUEST) {
			const req = swaps.decodeSwapQuoteRequest(payload);
			const submarine = req.direction === swaps.SwapWireDirection.SUBMARINE;
			const { total, miner } = this.fee(req.amountSat);
			// An amount outside the limits is refused, as the real engines
			// refuse it; amount 0 asks for the limits themselves.
			const outOfRange =
				req.amountSat === 0n
					? undefined
					: req.amountSat < this.minSwapSat
					? swaps.SwapRefusalReason.AMOUNT_BELOW_MIN
					: req.amountSat > this.maxSwapSat
					? swaps.SwapRefusalReason.AMOUNT_ABOVE_MAX
					: undefined;
			const refuse = this.knobs.refuse ?? outOfRange;
			this.link.sendCustomMessage(
				peer,
				message.BeignetCustomSubtype.SWAP_QUOTE,
				swaps.encodeSwapQuote({
					requestId: req.requestId,
					direction: req.direction,
					accepted: refuse === undefined,
					reason: refuse ?? swaps.SwapRefusalReason.NONE,
					reasonText: refuse !== undefined ? 'no' : undefined,
					flatFeeSat: this.knobs.flatFeeSat ?? 100n,
					feePpm: this.knobs.feePpm ?? 1_000,
					minSwapSat: this.minSwapSat,
					maxSwapSat: this.maxSwapSat,
					refundDeltaBlocks: this.knobs.refundDelta ?? 144,
					fundingConfirmations: this.knobs.fundingConfirmations ?? 1,
					invoiceExpirySeconds: submarine ? 600 : 1800,
					currentHeight: this.height(),
					totalFeeSat: req.amountSat === 0n ? 0n : total,
					minerFeeSat: req.amountSat === 0n ? 0n : miner,
					invoiceAmountMsat:
						req.amountSat === 0n
							? 0n
							: submarine
							? (req.amountSat - total) * 1000n
							: (req.amountSat + total) * 1000n
				})
			);
			return;
		}
		if (subtype === message.BeignetCustomSubtype.SWAP_SUBMARINE_CREATE) {
			this.handleSubmarineCreate(peer, payload);
			return;
		}
		if (subtype === message.BeignetCustomSubtype.SWAP_CREATE) {
			const req = swaps.decodeSwapCreate(payload);
			const refuse = (reason: swaps.SwapRefusalReason): void =>
				this.link.sendCustomMessage(
					peer,
					message.BeignetCustomSubtype.SWAP_CREATE_ACK,
					swaps.encodeSwapCreateAck({
						requestId: req.requestId,
						accepted: false,
						paymentHash: req.paymentHash,
						reason,
						reasonText: 'no'
					})
				);
			if (this.knobs.refuse !== undefined) return refuse(this.knobs.refuse);
			const { total, miner } = this.fee(req.onchainAmountSat);
			if (total > req.maxTotalFeeSat)
				return refuse(swaps.SwapRefusalReason.FEE_CEILING);
			const refundKey = crypto.randomBytes(32);
			const refundPubkey = this.knobs.refundKeyEqualsClaimKey
				? req.claimPubkey
				: bcrypto.getPublicKey(refundKey);
			const refundHeight = this.height() + (this.knobs.refundDelta ?? 144);
			const contract = swaps.buildSwapHtlc(
				{
					paymentHash: req.paymentHash,
					claimPublicKey: req.claimPubkey,
					refundPublicKey: refundPubkey,
					refundHeight
				},
				bitcoin.networks.regtest
			);
			const invoiceAmountMsat = (req.onchainAmountSat + total) * 1000n;
			const timestamp = Math.floor(Date.now() / 1000);
			const bolt11 = invoice.encode({
				network: this.knobs.foreignNetwork
					? invoice.Network.TESTNET
					: invoice.Network.REGTEST,
				amountMsat: this.knobs.wrongInvoiceAmount
					? invoiceAmountMsat + 1000n
					: invoiceAmountMsat,
				timestamp,
				paymentHash: this.knobs.wrongInvoiceHash
					? crypto.randomBytes(32)
					: req.paymentHash,
				paymentSecret: crypto.randomBytes(32),
				description: 'reverse swap',
				expiry: 1800,
				minFinalCltvExpiry: 194,
				privateKey: this.privkey
			});
			FakePayer.hashes.set(bolt11, req.paymentHash.toString('hex'));
			const swapId = swaps.deriveSwapId(
				Buffer.from(peer, 'hex'),
				req.paymentHash
			);
			const record: IFakeSwap = {
				direction: 'reverse',
				swapId,
				paymentHash: req.paymentHash,
				claimPubkey: req.claimPubkey,
				refundKey,
				refundHeight,
				onchainAmountSat: req.onchainAmountSat,
				outputScript: contract.outputScript,
				address: contract.address,
				bolt11,
				state: swaps.SwapWireState.CREATED
			};
			this.swaps.set(swapId.toString('hex'), record);
			this.link.sendCustomMessage(
				peer,
				message.BeignetCustomSubtype.SWAP_CREATE_ACK,
				swaps.encodeSwapCreateAck({
					requestId: req.requestId,
					accepted: true,
					paymentHash: req.paymentHash,
					reason: swaps.SwapRefusalReason.NONE,
					terms: {
						swapId,
						bolt11,
						refundPubkey,
						refundHeight,
						outputScript: this.knobs.wrongScript
							? Buffer.concat([
									Buffer.from('0020', 'hex'),
									crypto.randomBytes(32)
							  ])
							: contract.outputScript,
						address: contract.address,
						invoiceAmountMsat,
						onchainAmountSat: req.onchainAmountSat,
						totalFeeSat: this.knobs.overstateFee ? total + 1n : total,
						minerFeeSat: miner,
						fundingConfirmations: 1,
						invoiceExpiresAt: timestamp + 1800,
						currentHeight: this.height()
					}
				})
			);
			return;
		}
		if (subtype === message.BeignetCustomSubtype.SWAP_STATUS_REQUEST) {
			const req = swaps.decodeSwapStatusRequest(payload);
			const s = this.swaps.get(req.swapId.toString('hex'));
			this.link.sendCustomMessage(
				peer,
				message.BeignetCustomSubtype.SWAP_STATUS,
				swaps.encodeSwapStatus({
					requestId: req.requestId,
					swapId: req.swapId,
					found: !!s,
					state: s?.state ?? swaps.SwapWireState.UNKNOWN,
					currentHeight: this.height(),
					refundHeight: s?.refundHeight,
					fundingTxid: s?.fundingTxid
						? Buffer.from(s.fundingTxid, 'hex')
						: undefined,
					fundingVout: s?.fundingTxid ? s.fundingVout : undefined,
					resolutionTxid: s?.resolutionTxid
						? Buffer.from(s.resolutionTxid, 'hex')
						: undefined,
					resolutionKind: s?.resolutionKind
				})
			);
		}
	}

	/**
	 * The submarine create, as beignet's engine judges it: the client's own
	 * invoice must carry the hash and leave a whole-sat fee at or above the
	 * floor and under the client's ceiling, and its final CLTV must fit
	 * under refundHeight minus the provider's margins.
	 */
	private handleSubmarineCreate(peer: string, payload: Buffer): void {
		const req = swaps.decodeSwapSubmarineCreate(payload);
		const refuse = (reason: swaps.SwapRefusalReason, reasonText = 'no'): void =>
			this.link.sendCustomMessage(
				peer,
				message.BeignetCustomSubtype.SWAP_SUBMARINE_CREATE_ACK,
				swaps.encodeSwapSubmarineCreateAck({
					requestId: req.requestId,
					accepted: false,
					paymentHash: req.paymentHash,
					reason,
					reasonText
				})
			);
		if (this.knobs.refuse !== undefined) return refuse(this.knobs.refuse);
		let decoded: ReturnType<typeof invoice.decode>;
		try {
			decoded = invoice.decode(req.bolt11);
		} catch {
			return refuse(swaps.SwapRefusalReason.INVOICE_MISMATCH, 'no decode');
		}
		if (!decoded.paymentHash.equals(req.paymentHash) || !decoded.amountMsat) {
			return refuse(swaps.SwapRefusalReason.INVOICE_MISMATCH, 'hash');
		}
		const onchainMsat = req.onchainAmountSat * 1000n;
		if (
			decoded.amountMsat >= onchainMsat ||
			(onchainMsat - decoded.amountMsat) % 1000n !== 0n
		) {
			return refuse(swaps.SwapRefusalReason.INVOICE_MISMATCH, 'fee');
		}
		const totalFeeSat = req.onchainAmountSat - decoded.amountMsat / 1000n;
		const { total: floor, miner } = this.fee(req.onchainAmountSat);
		if (totalFeeSat < floor)
			return refuse(swaps.SwapRefusalReason.FEE_CEILING, 'below floor');
		if (totalFeeSat > req.maxTotalFeeSat)
			return refuse(swaps.SwapRefusalReason.FEE_CEILING, 'above ceiling');
		const height = this.height();
		const refundHeight = height + (this.knobs.refundDelta ?? 144);
		const claimSafety = this.knobs.claimSafetyBlocks ?? 6;
		const resolutionSafety = this.knobs.resolutionSafetyBlocks ?? 6;
		const fitConfirmations = this.knobs.fundingConfirmations ?? 1;
		// The knob only lies in the ack; the fit is judged honestly.
		const fundingConfirmations = this.knobs.demandDeepFunding
			? 500
			: fitConfirmations;
		const ceiling = refundHeight - claimSafety - resolutionSafety;
		const finalCltv = decoded.minFinalCltvExpiry ?? 40;
		if (height + fitConfirmations + 6 + finalCltv + 3 > ceiling) {
			return refuse(swaps.SwapRefusalReason.CLTV_UNFITTABLE, 'cltv');
		}
		const claimKey = crypto.randomBytes(32);
		const claimPubkey = this.knobs.wrongClaimKey
			? req.refundPubkey
			: bcrypto.getPublicKey(claimKey);
		const contract = swaps.buildSwapHtlc(
			{
				paymentHash: req.paymentHash,
				claimPublicKey: claimPubkey,
				refundPublicKey: req.refundPubkey,
				refundHeight
			},
			bitcoin.networks.regtest
		);
		const swapId = swaps.deriveSwapId(
			Buffer.from(peer, 'hex'),
			req.paymentHash
		);
		const record: IFakeSwap = {
			direction: 'submarine',
			swapId,
			paymentHash: req.paymentHash,
			claimPubkey,
			refundKey: Buffer.alloc(32),
			claimKey,
			refundPubkey: req.refundPubkey,
			refundHeight,
			onchainAmountSat: req.onchainAmountSat,
			outputScript: contract.outputScript,
			address: contract.address,
			bolt11: req.bolt11,
			state: swaps.SwapWireState.CREATED
		};
		this.swaps.set(swapId.toString('hex'), record);
		const expiresAt =
			decoded.timestamp + (decoded.expiry ?? invoice.DEFAULT_EXPIRY);
		this.link.sendCustomMessage(
			peer,
			message.BeignetCustomSubtype.SWAP_SUBMARINE_CREATE_ACK,
			swaps.encodeSwapSubmarineCreateAck({
				requestId: req.requestId,
				accepted: true,
				paymentHash: req.paymentHash,
				reason: swaps.SwapRefusalReason.NONE,
				terms: {
					swapId,
					claimPubkey,
					refundHeight,
					outputScript: this.knobs.wrongScript
						? Buffer.concat([
								Buffer.from('0020', 'hex'),
								crypto.randomBytes(32)
						  ])
						: contract.outputScript,
					address: contract.address,
					invoiceAmountMsat: decoded.amountMsat,
					onchainAmountSat: req.onchainAmountSat,
					totalFeeSat: this.knobs.overstateFee ? totalFeeSat + 1n : totalFeeSat,
					minerFeeSat: miner,
					fundingConfirmations,
					expiresAt,
					currentHeight: height,
					paymentCeilingHeight: ceiling
				}
			})
		);
	}

	/** The provider paid the client's invoice: the fake node settles it. */
	pay(payer: FakePayer, swapIdHex: string): Buffer {
		const s = this.swaps.get(swapIdHex)!;
		const preimage = payer.settleInvoice(s.paymentHash.toString('hex'));
		s.preimage = preimage;
		s.state = swaps.SwapWireState.PREIMAGE_KNOWN;
		return preimage;
	}

	/** The provider's HTLC is parked at the client's node, not settled. */
	acceptOnly(payer: FakePayer, swapIdHex: string, parts = 1): void {
		const s = this.swaps.get(swapIdHex)!;
		payer.acceptInvoice(s.paymentHash.toString('hex'), parts);
		s.state = swaps.SwapWireState.PAYING;
	}

	/** The provider's claim of the client's funding with the preimage it learned. */
	claim(chain: MockChain, swapIdHex: string, height = 0): string {
		const s = this.swaps.get(swapIdHex)!;
		if (!s.preimage) throw new Error('the provider has no preimage yet');
		const funding = [...chain.txs.entries()].find(([, e]) =>
			e.tx.outs.some((o) => o.script.equals(s.outputScript))
		);
		if (!funding) throw new Error('no funding on the chain');
		const vout = funding[1].tx.outs.findIndex((o) =>
			o.script.equals(s.outputScript)
		);
		const claim = swaps.buildSwapClaimTx({
			htlc: {
				paymentHash: s.paymentHash,
				claimPublicKey: bcrypto.getPublicKey(s.claimKey!),
				refundPublicKey: s.refundPubkey!,
				refundHeight: s.refundHeight
			},
			fundingTransaction: funding[1].tx,
			outputIndex: vout,
			destinationScript: bitcoin.payments.p2wpkh({
				pubkey: bcrypto.getPublicKey(s.claimKey!)
			}).output!,
			feeSatoshis: 500n,
			privateKey: s.claimKey!,
			preimage: s.preimage
		});
		chain.add(claim, height);
		s.state = swaps.SwapWireState.CLAIM_BROADCAST;
		s.resolutionTxid = claim.getId();
		s.resolutionKind = swaps.SwapWireResolutionKind.CLAIM;
		return claim.getId();
	}

	/** Fund the contract on the chain (a real 1-in-2-out transaction). */
	fund(
		chain: MockChain,
		swapIdHex: string,
		opts: { valueSat?: bigint; script?: Buffer; height?: number } = {}
	): string {
		const s = this.swaps.get(swapIdHex)!;
		const tx = new bitcoin.Transaction();
		tx.version = 2;
		tx.addInput(crypto.randomBytes(32), 0, 0xfffffffd);
		tx.addOutput(
			opts.script ?? s.outputScript,
			Number(opts.valueSat ?? s.onchainAmountSat)
		);
		tx.addOutput(
			bitcoin.payments.p2wpkh({
				pubkey: bcrypto.getPublicKey(crypto.randomBytes(32))
			}).output!,
			7_000
		);
		chain.add(tx, opts.height ?? 0);
		s.fundingTxid = tx.getId();
		s.fundingVout = 0;
		s.state = swaps.SwapWireState.FUNDING;
		return tx.getId();
	}

	/** The provider's refund of a funded contract, placed on the chain. */
	refund(chain: MockChain, swapIdHex: string, height = 0): string {
		const s = this.swaps.get(swapIdHex)!;
		const funding = chain.txs.get(s.fundingTxid!)!.tx;
		const refund = swaps.buildSwapRefundTx({
			htlc: {
				paymentHash: s.paymentHash,
				claimPublicKey: s.claimPubkey,
				refundPublicKey: bcrypto.getPublicKey(s.refundKey),
				refundHeight: s.refundHeight
			},
			fundingTransaction: funding,
			outputIndex: s.fundingVout!,
			destinationScript: bitcoin.payments.p2wpkh({
				pubkey: bcrypto.getPublicKey(s.refundKey)
			}).output!,
			feeSatoshis: 500n,
			privateKey: s.refundKey
		});
		chain.add(refund, height);
		s.state = swaps.SwapWireState.REFUND_PENDING;
		s.resolutionTxid = refund.getId();
		s.resolutionKind = swaps.SwapWireResolutionKind.REFUND;
		return refund.getId();
	}
}
