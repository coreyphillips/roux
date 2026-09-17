import { expect } from 'chai';

/**
 * The receiver half of a direct-funding exchange, on real beignet code over a
 * real Noise connection, shared by the wire tests: beignet's
 * DirectFundingReceiver engine and lanes on a listening PeerManager with the
 * receiver's real node key, and the FakeDfNode channel stub beignet's own
 * end-to-end suite uses in place of the interactive-tx machinery.
 */

import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import type { directFunding as dfDist } from 'beignet/lightning';
// The receiver side runs on beignet's SOURCE tree through its own test
// harness; the payer side on the published `beignet/lightning` build. They
// share nothing but the wire, which is the point.
import { PeerManager } from '../node_modules/beignet/src/lightning/transport/peer-manager';
import { FeatureFlags } from '../node_modules/beignet/src/lightning/features/flags';
import {
	BEIGNET_CUSTOM_MESSAGE_TYPE,
	decodeCustomMessage,
	encodeCustomMessage
} from '../node_modules/beignet/src/lightning/message/custom';
import { getPublicKey } from '../node_modules/beignet/src/lightning/crypto/ecdh';
import { signMessageWithKey } from '../node_modules/beignet/src/lightning/crypto/message-signing';
import { createFundingScript } from '../node_modules/beignet/src/lightning/script/funding';
import {
	bip21WithRequest,
	encodeRequestEnvelope,
	mintRequestEnvelope
} from '../node_modules/beignet/src/lightning/direct-funding/envelope';
import { requestEncryptionPublicKey } from '../node_modules/beignet/src/lightning/direct-funding/requests';
import {
	chainHashForNetwork,
	DfTransportDescriptor
} from '../node_modules/beignet/src/lightning/direct-funding/types';
import { IDfOffer } from '../node_modules/beignet/src/lightning/direct-funding/messages';
import { DirectFundingReceiver } from '../node_modules/beignet/src/lightning/direct-funding/receiver/engine';
import { DfTransportRegistry } from '../node_modules/beignet/src/lightning/direct-funding/transport/registry';
import {
	IDfCustomMessage,
	IDfPeerMessaging
} from '../node_modules/beignet/src/lightning/direct-funding/transport/types';
import { Network } from '../node_modules/beignet/src/lightning/invoice/types';
import {
	FakeDfNode,
	memoryStorage
} from '../node_modules/beignet/tests/lightning/helpers/df-receiver';
import { makeCoin } from '../node_modules/beignet/tests/lightning/helpers/df-sender';
import { BeignetClient, KeyedUtxoWallet, NoisePeerLink } from '../src';
import { freePort, sha, waitFor } from './helpers';

export const AMOUNT = 100_000n;
export const FEE_CEILING = 2_000n;
export const CHAIN = chainHashForNetwork(Network.REGTEST);

/** A receiver stub that attests with the key its peer identity uses. */
export class SigningDfNode extends FakeDfNode {
	readonly nodeId: Buffer;

	constructor(
		storage: ConstructorParameters<typeof FakeDfNode>[0],
		readonly nodePrivkey: Buffer
	) {
		super(storage);
		this.nodeId = getPublicKey(nodePrivkey);
	}

	signMessage(message?: string): string {
		return signMessageWithKey(message ?? '', this.nodePrivkey);
	}
}

/** A beignet node's peer surface, over a real listening PeerManager. */
export async function listeningPeer(privkey: Buffer): Promise<{
	pm: PeerManager;
	peers: IDfPeerMessaging;
	port: number;
	idHex: string;
}> {
	const pm = new PeerManager({
		localPrivateKey: privkey,
		localFeatures: FeatureFlags.empty(),
		networks: [CHAIN]
	});
	pm.on('peer:error', () => {});
	const port = await freePort();
	await pm.listen(port, '127.0.0.1');
	const idHex = getPublicKey(privkey).toString('hex');
	const peers: IDfPeerMessaging = {
		nodeIdHex: () => idHex,
		isPeerConnected: (hex) => pm.getPeer(hex)?.getState() === 'ready',
		connectPeer: (hex, host, p) => pm.connectPeer(hex, host, p),
		sendCustomMessage: (hex, subtype, payload) =>
			pm.sendToPeer(
				hex,
				BEIGNET_CUSTOM_MESSAGE_TYPE,
				encodeCustomMessage(subtype, payload)
			),
		onCustomMessage: (cb) => {
			const handler = (pubkey: string, type: number, payload: Buffer): void => {
				if (type !== BEIGNET_CUSTOM_MESSAGE_TYPE) return;
				let msg: IDfCustomMessage;
				try {
					const d = decodeCustomMessage(payload);
					msg = {
						peerPubkey: pubkey,
						version: d.version,
						subtype: d.subtype,
						payload: d.payload
					};
				} catch {
					return;
				}
				try {
					cb(msg);
				} catch {
					// The node's dispatch swallows listener errors; so does this.
				}
			};
			pm.on('message', handler);
			return () => {
				pm.off('message', handler);
			};
		}
	};
	return { pm, peers, port, idHex };
}

export interface IReceiverSide {
	node: SigningDfNode;
	receiver: DirectFundingReceiver;
	pm: PeerManager;
	peers: IDfPeerMessaging;
	port: number;
	request: string;
	bip21: string;
	record: ReturnType<FakeDfNode['mintRequest']>;
	fundingScript: Buffer;
	stop(): void;
}

export async function startReceiver(
	label: string,
	transports: (port: number) => DfTransportDescriptor[],
	lanes: (peers: IDfPeerMessaging, registry: DfTransportRegistry) => void
): Promise<IReceiverSide> {
	const key = sha(`roux-df-receiver-${label}`);
	const node = new SigningDfNode(memoryStorage(), key);
	const { pm, peers, port } = await listeningPeer(key);
	const record = node.mintRequest(3_600_000);
	const request = encodeRequestEnvelope(
		mintRequestEnvelope(
			{
				requestId: Buffer.from(record.requestId, 'hex'),
				chainHash: CHAIN,
				receiverNodeId: node.nodeId,
				expiresAt: record.expiresAt,
				receiptHash: Buffer.from(record.receiptHash, 'hex'),
				encryptionKey: requestEncryptionPublicKey(record),
				transports: transports(port)
			},
			(message) => node.signMessage(message)
		)
	);
	const receiver = new DirectFundingReceiver(node, {
		allowSplice: false,
		allowZeroConf: false
	});
	receiver.start();
	const registry = new DfTransportRegistry();
	lanes(peers, registry);
	await receiver.attach(registry);
	const pubkeys = node.fundingPubkeys()!;
	return {
		node,
		receiver,
		pm,
		peers,
		port,
		request,
		bip21: bip21WithRequest(
			'bitcoin:bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.001',
			request
		),
		record,
		fundingScript: createFundingScript(pubkeys.local, pubkeys.remote)
			.p2wshOutput,
		stop: (): void => {
			receiver.stop();
			registry.destroy();
			pm.destroy();
		}
	};
}

export function payerSide(coin: ReturnType<typeof makeCoin>): {
	client: BeignetClient;
	wallet: KeyedUtxoWallet;
	changeScript: Buffer;
	link: NoisePeerLink;
} {
	const changeScript = bitcoin.payments.p2wpkh({ hash: crypto.randomBytes(20) })
		.output!;
	const wallet = new KeyedUtxoWallet({
		network: 'regtest',
		coins: [
			{
				txid: coin.txidHex,
				vout: coin.vout,
				valueSat: coin.valueSat,
				script: coin.script,
				height: 100,
				privateKey: coin.privkey
			}
		],
		changeScript,
		getTransaction: async (txid): Promise<Buffer> => {
			if (txid !== coin.txidHex) throw new Error(`unknown tx ${txid}`);
			return coin.prevTx.toBuffer();
		},
		blockHeight: () => 800_000
	});
	const link = new NoisePeerLink({ network: 'regtest' });
	const client = new BeignetClient({
		allowEphemeralStorage: true,
		link,
		network: 'regtest',
		wallet,
		sender: {
			offerResendDelaysMs: [],
			offerTimeoutMs: 15_000,
			receiptTimeoutMs: 5_000
		}
	});
	return { client, wallet, changeScript, link };
}

/** The offer the receiver's stub rebuilds the negotiated transaction from. */
export function expectedOffer(
	coin: { txidHex: string; vout: number; valueSat: bigint; pubkey: Buffer },
	changeScript: Buffer,
	receiptHashHex: string
): IDfOffer {
	return {
		offerId: Buffer.alloc(16),
		amountSat: AMOUNT,
		txid: Buffer.from(coin.txidHex, 'hex'),
		vout: coin.vout,
		valueSat: coin.valueSat,
		sequence: 0xfffffffd,
		changeScript,
		maxTotalFeeSat: FEE_CEILING,
		receiptHash: Buffer.from(receiptHashHex, 'hex'),
		ownership: { pubkey: coin.pubkey, signature: Buffer.alloc(64) }
	};
}

export async function runExchange(
	side: IReceiverSide,
	payer: ReturnType<typeof payerSide>,
	coin: ReturnType<typeof makeCoin>
): Promise<dfDist.IDfSendResult> {
	const paying = payer.client.directFunding.pay(side.bip21, {
		amountSat: AMOUNT,
		maxTotalFeeSat: FEE_CEILING
	});
	// The receiver admits the offer and starts the open; the stub stands in
	// for the interactive transaction and hands it the negotiated bytes.
	await waitFor(
		() => side.node.opens.length === 1,
		'the receiver to start an open'
	);
	expect(side.node.opens[0].params.fundingSatoshis).to.equal(AMOUNT);
	side.node.completeNegotiation(
		coin,
		expectedOffer(coin, payer.changeScript, side.record.receiptHash),
		{ fundingScript: side.fundingScript }
	);
	return paying;
}

export function assertPaid(
	result: dfDist.IDfSendResult,
	side: IReceiverSide,
	payer: ReturnType<typeof payerSide>,
	coin: ReturnType<typeof makeCoin>
): void {
	expect(result.attested, 'the payer did not verify the attestation').to.equal(
		true
	);
	expect(result.status).to.equal('SIGNED_PENDING');
	expect(result.caveat).to.equal(undefined);
	// The receipt is the receiver's proof of delivery, opening the hash the
	// request was minted with.
	expect(result.receiptPreimageHex).to.equal(side.record.preimageHex);
	expect(
		sha(Buffer.from(result.receiptPreimageHex!, 'hex')).toString('hex')
	).to.equal(side.record.receiptHash);
	// One witness, for the coin the payer offered, delivered to the channel.
	expect(side.node.witnesses).to.have.length(1);
	expect(side.node.witnesses[0].kind).to.equal('open');
	expect(result.spentTxid).to.equal(coin.txidHex);
	// The payer's coin is now held against its own selection.
	expect(payer.wallet.listSpendable()).to.deep.equal([]);
	const records = payer.client.directFunding.payments();
	expect(records).to.have.length(1);
	expect(records[0].status).to.equal('SIGNED_PENDING');
	expect(records[0].witnessSent).to.equal(true);
}
