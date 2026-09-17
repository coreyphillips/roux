/**
 * roux pays a beignet direct-funding request over a REAL Noise
 * connection, on both lanes roux serves.
 *
 * The receiver half (tests/df-harness.ts) is beignet's own engine and lanes
 * on a real listening PeerManager; the channel is the one thing stubbed.
 * The payer half is roux: a standalone Noise link with an identity the
 * receiver has never seen, and a KeyedUtxoWallet holding one P2WPKH coin.
 */

import { expect } from 'chai';
import type { directFunding as dfDist } from 'beignet/lightning';
import { getPublicKey } from '../../node_modules/beignet/src/lightning/crypto/ecdh';
import { DfTransportType } from '../../node_modules/beignet/src/lightning/direct-funding/types';
import { DfDirectPeerLaneFactory } from '../../node_modules/beignet/src/lightning/direct-funding/transport/direct-peer';
import {
	DfRelayForwarder,
	DfRelayLaneFactory
} from '../../node_modules/beignet/src/lightning/direct-funding/transport/relay';
import { makeCoin } from '../../node_modules/beignet/tests/lightning/helpers/df-sender';
import { BeignetClient } from '../../src';
import { sha } from '../helpers';
import {
	AMOUNT,
	assertPaid,
	listeningPeer,
	payerSide,
	runExchange,
	startReceiver
} from '../df-harness';

describe('Direct funding against a real beignet receiver over TCP', function () {
	this.timeout(60_000);

	it('inspects a BIP 21 request before touching the network', async () => {
		const side = await startReceiver(
			'inspect',
			(port) => [
				{ type: DfTransportType.DIRECT_PEER, host: '127.0.0.1', port }
			],
			(peers, registry) =>
				registry.register({
					type: DfTransportType.DIRECT_PEER,
					enabled: true,
					load: () => new DfDirectPeerLaneFactory(peers)
				})
		);
		const payer = payerSide(makeCoin(300_000));
		try {
			const info = payer.client.directFunding.inspect(side.bip21);
			expect(info.receiverNodeIdHex).to.equal(side.node.nodeId.toString('hex'));
			expect(info.requestIdHex).to.equal(side.record.requestId);
			expect(info.amountSat).to.equal(undefined);
			expect(info.reachable).to.equal(true);
			expect(info.transports).to.deep.equal([
				{
					type: 'direct_peer',
					supported: true,
					host: '127.0.0.1',
					port: side.port
				}
			]);
			const quote = payer.client.directFunding.quote(side.bip21, {
				amountSat: AMOUNT
			});
			expect(quote).to.deep.equal({
				amountSat: AMOUNT,
				maxTotalFeeSat: 1_000n
			});
			// A request minted for another chain is refused by name.
			const mainnetClient = new BeignetClient({
				allowEphemeralStorage: true,
				link: payer.link,
				network: 'mainnet',
				wallet: payer.wallet
			});
			expect(() => mainnetClient.directFunding.inspect(side.bip21)).to.throw(
				/chain/i
			);
			mainnetClient.directFunding.stop();
		} finally {
			await payer.client.close();
			side.stop();
		}
	});

	it('pays over the direct-peer lane: one exchange, one spend, a verified receipt', async () => {
		const side = await startReceiver(
			'direct',
			(port) => [
				{ type: DfTransportType.DIRECT_PEER, host: '127.0.0.1', port }
			],
			(peers, registry) =>
				registry.register({
					type: DfTransportType.DIRECT_PEER,
					enabled: true,
					load: () => new DfDirectPeerLaneFactory(peers)
				})
		);
		const coin = makeCoin(300_000);
		side.node.publish(coin);
		const payer = payerSide(coin);
		try {
			const result = await runExchange(side, payer, coin);
			assertPaid(result, side, payer, coin);
			// The receiver saw the payer on an authenticated connection.
			expect(side.pm.listPeers().map((p) => p.pubkey)).to.include(
				payer.link.nodeIdHex()
			);
			// Paying the same request again replays the outcome; nothing is spent twice.
			const again = await payer.client.directFunding.pay(side.bip21, {
				amountSat: AMOUNT
			});
			expect(again.offerId).to.equal(result.offerId);
			expect(side.node.witnesses).to.have.length(1);
		} finally {
			await payer.client.close();
			side.stop();
		}
	});

	it('pays through a blind relay when the receiver is only reachable via its LSP', async () => {
		// The relay: a third node, opted into forwarding for others.
		const relayKey = sha('roux-df-relay');
		const relay = await listeningPeer(relayKey);
		const forwarder = new DfRelayForwarder(relay.peers, {});
		forwarder.start();

		const side = await startReceiver(
			'relayed',
			() => [
				{
					type: DfTransportType.LSP_RELAY,
					relayNodeId: getPublicKey(relayKey),
					host: '127.0.0.1',
					port: relay.port
				}
			],
			(peers, registry) =>
				registry.register({
					type: DfTransportType.LSP_RELAY,
					enabled: true,
					load: () => new DfRelayLaneFactory(peers)
				})
		);
		// The receiver, like a mobile wallet, dials its LSP and waits behind it.
		await side.pm.connectPeer(relay.idHex, '127.0.0.1', relay.port);

		const coin = makeCoin(300_000);
		side.node.publish(coin);
		const payer = payerSide(coin);
		try {
			const info = payer.client.directFunding.inspect(side.bip21);
			expect(info.transports[0]).to.include({
				type: 'lsp_relay',
				supported: true,
				relayNodeIdHex: relay.idHex
			});
			const result = await runExchange(side, payer, coin);
			assertPaid(result, side, payer, coin);
			// The payer only ever connected to the relay, never to the receiver.
			expect(payer.link.connectedPeers()).to.deep.equal([relay.idHex]);
			expect(side.pm.listPeers().map((p) => p.pubkey)).to.not.include(
				payer.link.nodeIdHex()
			);
		} finally {
			await payer.client.close();
			side.stop();
			forwarder.stop();
			relay.pm.destroy();
		}
	});

	it('a request whose only lane roux cannot carry is reported, and refused without spending', async () => {
		const side = await startReceiver(
			'onion-only',
			() => [
				{
					type: DfTransportType.ONION_MESSAGE,
					host: '127.0.0.1',
					port: 1,
					introNodeId: getPublicKey(sha('intro')),
					pathKey: getPublicKey(sha('pathkey')),
					hops: [
						{
							blindedNodeId: getPublicKey(sha('hop')),
							encryptedData: Buffer.alloc(8)
						}
					]
				}
			],
			() => undefined
		);
		const coin = makeCoin(300_000);
		const payer = payerSide(coin);
		try {
			const info = payer.client.directFunding.inspect(side.bip21);
			expect(info.reachable).to.equal(false);
			expect(info.transports[0]).to.include({
				type: 'onion_message',
				supported: false
			});
			let caught: unknown;
			try {
				await payer.client.directFunding.pay(side.bip21, { amountSat: AMOUNT });
			} catch (err) {
				caught = err;
			}
			expect((caught as dfDist.DirectFundingError).code).to.equal(
				'UNREACHABLE'
			);
			expect(payer.wallet.listSpendable()).to.have.length(1);
		} finally {
			await payer.client.close();
			side.stop();
		}
	});
});
