/**
 * A link over a small HTTP bridge that a node written in another language
 * exposes: the way an LDK (rust-lightning) application, which holds its own
 * node key and peer connections, lets roux speak the beignet protocol
 * through them.
 *
 * rust-lightning routes unknown message types to a `CustomMessageHandler`;
 * ldk-node does not expose one, so this is for applications built on
 * rust-lightning directly. The application implements five routes (the
 * reference handler in `example/ldk-bridge/` is about 200 lines of Rust)
 * and roux does the rest:
 *
 *   GET  /info                 -> { "nodeId": "<hex>" }
 *   GET  /peers                -> { "peers": ["<hex>", ...] }   connected now
 *   POST /connect              <- { "pubkey": "<hex>", "host": "...", "port": n }
 *   POST /send                 <- { "peer": "<hex>", "type": 44069, "payload": "<hex>" }
 *   GET  /events  (SSE)        -> data: { "peer": "<hex>", "type": 44069, "payload": "<hex>" }
 *
 * `payload` is the message body after the two-byte type, i.e. exactly what
 * rust-lightning's `CustomMessageReader` is handed and what `Writeable`
 * writes. The bridge is trusted: it runs on the same machine as the node,
 * authenticates with a bearer token, and carries nothing but these frames.
 */

import { message } from 'beignet/lightning';
import { RouxLog, noopLog } from '../types';
import { ICustomMessage, IPeerLink, deliverIsolated } from './types';
import { IHttpEndpoint, IStreamHandle, requestJson, streamLines } from './http';

export interface IBridgePeerLinkOptions {
	host: string;
	port: number;
	/** Sent as `Authorization: Bearer <token>` when set. */
	token?: string;
	/** Default false: a bridge on localhost speaks plain HTTP. */
	https?: boolean;
	ca?: IHttpEndpoint['ca'];
	rejectUnauthorized?: boolean;
	/** How often the connected-peer cache is refreshed (default 10 s). */
	peerRefreshMs?: number;
	/** Pause before re-opening a dropped event stream (default 2 s). */
	resubscribeDelayMs?: number;
	log?: RouxLog;
}

interface IBridgeFrame {
	peer: string;
	type: number;
	payload: string;
}

export class BridgePeerLink implements IPeerLink {
	private readonly ep: IHttpEndpoint;
	private readonly log: RouxLog;
	private readonly listeners = new Set<(msg: ICustomMessage) => void>();
	private readonly connected = new Set<string>();
	private nodeId: string | null = null;
	private stream: IStreamHandle | null = null;
	private refreshTimer: NodeJS.Timeout | null = null;
	private opening: Promise<void> | null = null;
	private closed = false;

	constructor(private readonly options: IBridgePeerLinkOptions) {
		this.ep = {
			host: options.host,
			port: options.port,
			https: options.https === true,
			ca: options.ca,
			rejectUnauthorized: options.rejectUnauthorized,
			headers: options.token ? { Authorization: `Bearer ${options.token}` } : {}
		};
		this.log = options.log ?? noopLog;
	}

	async open(): Promise<void> {
		if (this.closed) throw new Error('link is closed');
		if (this.nodeId) return;
		if (this.opening) return this.opening;
		this.opening = (async (): Promise<void> => {
			const info = await requestJson<{ nodeId: string }>(
				this.ep,
				'GET',
				'/info'
			);
			this.nodeId = info.nodeId.toLowerCase();
			await this.refreshPeers();
			this.subscribe();
			const every = this.options.peerRefreshMs ?? 10_000;
			this.refreshTimer = setInterval(() => {
				void this.refreshPeers().catch((err) =>
					this.log('bridge_peer_refresh_failed', { error: String(err) })
				);
			}, every);
			this.refreshTimer.unref?.();
		})();
		try {
			await this.opening;
		} finally {
			this.opening = null;
		}
	}

	nodeIdHex(): string {
		if (!this.nodeId)
			throw new Error('BridgePeerLink.open() has not completed');
		return this.nodeId;
	}

	isPeerConnected(peerPubkeyHex: string): boolean {
		return this.connected.has(peerPubkeyHex.toLowerCase());
	}

	async connectPeer(
		peerPubkeyHex: string,
		host: string,
		port: number
	): Promise<void> {
		await this.open();
		const hex = peerPubkeyHex.toLowerCase();
		await requestJson(this.ep, 'POST', '/connect', { pubkey: hex, host, port });
		await this.refreshPeers();
		if (!this.connected.has(hex)) {
			throw new Error(
				`the bridge did not report ${hex} as connected after the dial`
			);
		}
	}

	sendCustomMessage(
		peerPubkeyHex: string,
		subtype: number,
		payload: Buffer
	): void {
		const hex = peerPubkeyHex.toLowerCase();
		if (!this.connected.has(hex)) {
			throw new Error(`Not connected to peer ${hex}`);
		}
		const envelope = message.encodeCustomMessage(subtype, payload);
		// Synchronous seam, detached call, logged failure: see LndPeerLink.
		void requestJson(this.ep, 'POST', '/send', {
			peer: hex,
			type: message.BEIGNET_CUSTOM_MESSAGE_TYPE,
			payload: envelope.toString('hex')
		}).catch((err) =>
			this.log('bridge_send_failed', {
				pubkey: hex,
				subtype,
				error: String(err)
			})
		);
	}

	onCustomMessage(cb: (msg: ICustomMessage) => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = null;
		this.stream?.close();
		this.stream = null;
		this.listeners.clear();
	}

	// ─────────────── Internals ───────────────

	private async refreshPeers(): Promise<void> {
		const res = await requestJson<{ peers?: string[] }>(
			this.ep,
			'GET',
			'/peers'
		);
		this.connected.clear();
		for (const p of res.peers ?? []) this.connected.add(p.toLowerCase());
	}

	private subscribe(): void {
		if (this.closed) return;
		this.stream = streamLines(this.ep, 'GET', '/events', (line) =>
			this.onLine(line)
		);
		this.stream.done
			.catch((err) => this.log('bridge_events_error', { error: String(err) }))
			.then(() => {
				this.stream = null;
				if (this.closed) return;
				const delay = this.options.resubscribeDelayMs ?? 2_000;
				const t = setTimeout(() => this.subscribe(), delay);
				t.unref?.();
			});
	}

	private onLine(line: string): void {
		// SSE: `data: {...}`; comment and event-name lines are skipped.
		if (!line.startsWith('data:')) return;
		let frame: IBridgeFrame;
		try {
			frame = JSON.parse(line.slice(5).trim());
		} catch {
			return;
		}
		if (Number(frame.type) !== message.BEIGNET_CUSTOM_MESSAGE_TYPE) return;
		const peerHex = String(frame.peer).toLowerCase();
		let decoded: message.ICustomMessage;
		try {
			decoded = message.decodeCustomMessage(Buffer.from(frame.payload, 'hex'));
		} catch (err) {
			this.log('custom_message_decode_failed', {
				pubkey: peerHex,
				error: String(err)
			});
			return;
		}
		this.connected.add(peerHex);
		deliverIsolated(
			this.listeners,
			{
				peerPubkey: peerHex,
				version: decoded.version,
				subtype: decoded.subtype,
				payload: decoded.payload
			},
			(err) =>
				this.log('listener_failed', { pubkey: peerHex, error: String(err) })
		);
	}
}
