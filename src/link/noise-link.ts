/**
 * A standalone BOLT 8 link: roux dials the beignet node itself.
 *
 * Built on beignet's own `Peer` (Noise_XK handshake, BOLT 1 init, ping/pong,
 * message framing), so the bytes on the wire are the ones a beignet node
 * already accepts. No channel machinery is involved: this is a peer
 * connection that speaks exactly one application message type.
 *
 * Identity: pass a 32-byte `privateKey` to be a stable, recognisable peer
 * (a receiver can pair a payer it trusts by that key); omit it for a fresh
 * ephemeral identity per process. For a JIT receive the identity MUST be the
 * node that will accept the channel the LSP opens, because the LSP opens it
 * to whoever registered the intent; use `LndPeerLink` or `ClnPeerLink` for
 * those nodes, or this link from inside the node process that holds the key.
 */

import crypto from 'crypto';
import {
	crypto as lnCrypto,
	directFunding,
	features,
	message,
	transport
} from 'beignet/lightning';
import { RouxLog, RouxNetwork, noopLog, toBeignetNetwork } from '../types';
import { ICustomMessage, IPeerLink, deliverIsolated } from './types';

export interface INoisePeerLinkOptions {
	network: RouxNetwork;
	/** 32-byte secp256k1 private key. Omitted: a random ephemeral identity. */
	privateKey?: Buffer;
	/**
	 * Socket factory for every dial: SOCKS5/Tor, or a WebSocket transport.
	 * `connectUri` with a ws:// URI builds one from beignet's WebSocket client
	 * automatically; this override wins when set.
	 */
	createSocket?: (
		host: string,
		port: number
	) => Promise<transport.IDuplexTransport>;
	/** TCP connect timeout (default 15 s). */
	connectTimeoutMs?: number;
	/** Noise handshake plus init exchange timeout (default 30 s). */
	handshakeTimeoutMs?: number;
	log?: RouxLog;
}

export class NoisePeerLink implements IPeerLink {
	private readonly privateKey: Buffer;
	private readonly nodeId: string;
	private readonly chainHash: Buffer;
	private readonly peers = new Map<string, transport.Peer>();
	/** Dials in flight, so two concurrent connects share one handshake. */
	private readonly dialing = new Map<string, Promise<void>>();
	private readonly listeners = new Set<(msg: ICustomMessage) => void>();
	private readonly log: RouxLog;
	private closed = false;

	constructor(private readonly options: INoisePeerLinkOptions) {
		if (options.privateKey !== undefined && options.privateKey.length !== 32) {
			throw new Error('privateKey must be 32 bytes');
		}
		this.privateKey = options.privateKey ?? crypto.randomBytes(32);
		this.nodeId = lnCrypto.getPublicKey(this.privateKey).toString('hex');
		this.chainHash = directFunding.chainHashForNetwork(
			toBeignetNetwork(options.network)
		);
		this.log = options.log ?? noopLog;
	}

	nodeIdHex(): string {
		return this.nodeId;
	}

	isPeerConnected(peerPubkeyHex: string): boolean {
		return this.peers.get(peerPubkeyHex.toLowerCase())?.getState() === 'ready';
	}

	connectedPeers(): string[] {
		return [...this.peers.entries()]
			.filter(([, p]) => p.getState() === 'ready')
			.map(([hex]) => hex);
	}

	async connectPeer(
		peerPubkeyHex: string,
		host: string,
		port: number,
		createSocket?: (h: string, p: number) => Promise<transport.IDuplexTransport>
	): Promise<void> {
		if (this.closed) throw new Error('link is closed');
		const hex = peerPubkeyHex.toLowerCase();
		if (this.isPeerConnected(hex)) return;
		const inFlight = this.dialing.get(hex);
		if (inFlight) return inFlight;

		const peer = new transport.Peer({
			localPrivateKey: this.privateKey,
			remotePublicKey: Buffer.from(hex, 'hex'),
			host,
			port,
			// No channel features: roux opens no channels. An empty init is
			// what BOLT 1 says a peer that speaks only optional things sends.
			localFeatures: features.FeatureFlags.empty(),
			networks: [this.chainHash],
			createSocket: createSocket ?? this.options.createSocket,
			connectTimeout: this.options.connectTimeoutMs,
			handshakeTimeout: this.options.handshakeTimeoutMs
		});
		peer.on('message', (type: number, payload: Buffer) =>
			this.dispatch(hex, type, payload)
		);
		peer.on('error', (err: Error) => {
			this.log('peer_error', { pubkey: hex, error: err.message });
		});
		peer.on('close', () => {
			if (this.peers.get(hex) === peer) this.peers.delete(hex);
			this.log('peer_closed', { pubkey: hex });
		});

		const dial = (async (): Promise<void> => {
			try {
				await peer.connect();
				// A concurrent dial cannot exist (the map above), so this slot is ours.
				this.peers.set(hex, peer);
				this.log('peer_connected', { pubkey: hex, host, port });
			} finally {
				this.dialing.delete(hex);
			}
		})();
		this.dialing.set(hex, dial);
		return dial;
	}

	sendCustomMessage(
		peerPubkeyHex: string,
		subtype: number,
		payload: Buffer
	): void {
		const peer = this.peers.get(peerPubkeyHex.toLowerCase());
		if (!peer || peer.getState() !== 'ready') {
			throw new Error(`Not connected to peer ${peerPubkeyHex}`);
		}
		peer.sendMessage(
			message.BEIGNET_CUSTOM_MESSAGE_TYPE,
			message.encodeCustomMessage(subtype, payload)
		);
	}

	onCustomMessage(cb: (msg: ICustomMessage) => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	disconnectPeer(peerPubkeyHex: string): void {
		const hex = peerPubkeyHex.toLowerCase();
		const peer = this.peers.get(hex);
		this.peers.delete(hex);
		peer?.disconnect();
	}

	close(): void {
		this.closed = true;
		for (const [hex, peer] of this.peers) {
			this.peers.delete(hex);
			peer.disconnect();
		}
		this.listeners.clear();
	}

	// ─────────────── Internals ───────────────

	private dispatch(peerHex: string, type: number, payload: Buffer): void {
		if (type !== message.BEIGNET_CUSTOM_MESSAGE_TYPE) return;
		let decoded: message.ICustomMessage;
		try {
			decoded = message.decodeCustomMessage(payload);
		} catch (err) {
			// The node's rule: an undecodable envelope is logged and dropped
			// without disconnecting the peer.
			this.log('custom_message_decode_failed', {
				pubkey: peerHex,
				error: err instanceof Error ? err.message : String(err)
			});
			return;
		}
		deliverIsolated(
			this.listeners,
			{
				peerPubkey: peerHex,
				version: decoded.version,
				subtype: decoded.subtype,
				payload: decoded.payload
			},
			(err) =>
				this.log('listener_failed', {
					pubkey: peerHex,
					subtype: decoded.subtype,
					error: err instanceof Error ? err.message : String(err)
				})
		);
	}
}

/**
 * A socket factory for a `pubkey@ws://host:port` peer, using beignet's own
 * RFC-cased Node WebSocket client so the handshake matches what beignet's
 * (and CLN's) listeners expect.
 */
export function webSocketSocketFactory(
	url: string
): (host: string, port: number) => Promise<transport.IDuplexTransport> {
	return async (): Promise<transport.IDuplexTransport> =>
		transport.connectWebSocket(url, {
			webSocketImpl:
				transport.NodeWebSocket as unknown as transport.WebSocketConstructor
		});
}
