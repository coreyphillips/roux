/**
 * A link that rides Core Lightning's own connection to the beignet node.
 *
 * CLN sends arbitrary custom messages with `sendcustommsg` and reports the
 * ones it receives as the `custommsg` notification. Both are exposed by
 * clnrest: the RPC over HTTPS with a rune, the notifications over its
 * Socket.IO stream (`/socket.io/`, the rune in the handshake header; see
 * cln-socketio.ts). The beignet node then sees your CLN identity, so a JIT
 * channel it opens lands on CLN.
 *
 * CLN, like LND, cannot settle an HTLC short of the onion amount: a JIT
 * intent from this link must leave `acceptsSkimmedFee` false and needs a
 * zero-fee LSP. See jit/client.ts.
 *
 * The notification transport is pluggable (`notifications`) for an older
 * clnrest, a plugin of your own, or a test. The default needs the `ws`
 * package, an optional peer dependency, because Node's built-in WebSocket
 * cannot send the rune header clnrest authenticates with.
 */

import { message } from 'beignet/lightning';
import { RouxLog, noopLog } from '../types';
import { ICustomMessage, IPeerLink, deliverIsolated } from './types';
import { IHttpEndpoint, requestJson } from './http';
import { clnSocketIoNotifications } from './cln-socketio';

/** A source of CLN notification objects, e.g. `{ custommsg: {...} }`. */
export type ClnNotificationSource = (
	onEvent: (event: Record<string, unknown>) => void,
	onClose: (err?: unknown) => void
) => {
	close(): void;
	/**
	 * Resolves once the stream is attached to the node's notifications. A
	 * clnrest broadcast reaches only sockets already joined, so `open()`
	 * waits for this before the first message is sent (otherwise the reply
	 * to a message sent milliseconds after subscribing is lost).
	 */
	ready?: Promise<void>;
};

export interface IClnPeerLinkOptions {
	host: string;
	/** clnrest port (default 3010). */
	port?: number;
	/** A rune permitting getinfo, listpeers, connect and sendcustommsg. */
	rune: string;
	https?: boolean;
	ca?: IHttpEndpoint['ca'];
	rejectUnauthorized?: boolean;
	/** Override the WebSocket notification transport. */
	notifications?: ClnNotificationSource;
	/** How often the connected-peer cache is refreshed (default 10 s). */
	peerRefreshMs?: number;
	/** Pause before re-opening a dropped notification stream (default 2 s). */
	resubscribeDelayMs?: number;
	/** How long open() waits for the notification stream to attach (default 5 s). */
	notificationReadyMs?: number;
	log?: RouxLog;
}

export class ClnPeerLink implements IPeerLink {
	private readonly ep: IHttpEndpoint;
	private readonly log: RouxLog;
	private readonly listeners = new Set<(msg: ICustomMessage) => void>();
	private readonly connected = new Set<string>();
	private nodeId: string | null = null;
	private stream: { close(): void } | null = null;
	private refreshTimer: NodeJS.Timeout | null = null;
	private opening: Promise<void> | null = null;
	private closed = false;

	constructor(private readonly options: IClnPeerLinkOptions) {
		this.ep = {
			host: options.host,
			port: options.port ?? 3010,
			https: options.https,
			ca: options.ca,
			rejectUnauthorized: options.rejectUnauthorized,
			headers: { Rune: options.rune }
		};
		this.log = options.log ?? noopLog;
	}

	async open(): Promise<void> {
		if (this.closed) throw new Error('link is closed');
		if (this.nodeId) return;
		if (this.opening) return this.opening;
		this.opening = (async (): Promise<void> => {
			const info = await this.rpc<{ id: string }>('getinfo', {});
			this.nodeId = info.id.toLowerCase();
			await this.refreshPeers();
			await this.subscribe();
			const every = this.options.peerRefreshMs ?? 10_000;
			this.refreshTimer = setInterval(() => {
				void this.refreshPeers().catch((err) =>
					this.log('cln_peer_refresh_failed', { error: String(err) })
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
		if (!this.nodeId) throw new Error('ClnPeerLink.open() has not completed');
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
		await this.rpc('connect', { id: hex, host, port });
		await this.refreshPeers();
		if (!this.connected.has(hex)) {
			throw new Error(`CLN did not report ${hex} as connected after the dial`);
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
		const typeBytes = Buffer.alloc(2);
		typeBytes.writeUInt16BE(message.BEIGNET_CUSTOM_MESSAGE_TYPE, 0);
		// Synchronous seam, detached call, logged failure: see LndPeerLink.
		void this.rpc('sendcustommsg', {
			node_id: hex,
			msg: Buffer.concat([typeBytes, envelope]).toString('hex')
		}).catch((err) =>
			this.log('cln_send_failed', { pubkey: hex, subtype, error: String(err) })
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

	private rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
		return requestJson<T>(this.ep, 'POST', `/v1/${method}`, params);
	}

	private async refreshPeers(): Promise<void> {
		const res = await this.rpc<{
			peers?: Array<{ id: string; connected: boolean }>;
		}>('listpeers', {});
		this.connected.clear();
		for (const p of res.peers ?? []) {
			if (p.connected) this.connected.add(p.id.toLowerCase());
		}
	}

	private async subscribe(): Promise<void> {
		if (this.closed) return;
		const source = this.options.notifications ?? this.defaultNotifications();
		const stream = source(
			(event) => this.onEvent(event),
			(err) => {
				if (err) this.log('cln_notifications_closed', { error: String(err) });
				this.stream = null;
				if (this.closed) return;
				const delay = this.options.resubscribeDelayMs ?? 2_000;
				const t = setTimeout(() => void this.subscribe(), delay);
				t.unref?.();
			}
		);
		this.stream = stream;
		if (!stream.ready) return;
		// A stream that never attaches must not hold open() hostage: the
		// resubscribe path above retries it, and the link logs the wait.
		const patience = this.options.notificationReadyMs ?? 5_000;
		let timer: NodeJS.Timeout | undefined;
		const lapsed = new Promise<'lapsed'>((resolve) => {
			timer = setTimeout(() => resolve('lapsed'), patience);
			timer.unref?.();
		});
		const outcome = await Promise.race([
			stream.ready.then(
				() => 'ready' as const,
				() => 'failed' as const
			),
			lapsed
		]);
		clearTimeout(timer);
		if (outcome !== 'ready') {
			this.log('cln_notifications_not_ready', { outcome, waitedMs: patience });
		}
	}

	private defaultNotifications(): ClnNotificationSource {
		// clnrest's stream is Socket.IO at /socket.io/ (cln-socketio.ts).
		return clnSocketIoNotifications({
			host: this.ep.host,
			port: this.ep.port,
			rune: this.options.rune,
			https: this.ep.https,
			ca: this.options.ca,
			rejectUnauthorized: this.options.rejectUnauthorized
		});
	}

	private onEvent(event: Record<string, unknown>): void {
		const body = event.custommsg as
			| { peer_id?: string; payload?: string }
			| undefined;
		if (!body?.peer_id || !body.payload) return;
		const raw = Buffer.from(body.payload, 'hex');
		if (
			raw.length < 2 ||
			raw.readUInt16BE(0) !== message.BEIGNET_CUSTOM_MESSAGE_TYPE
		)
			return;
		const peerHex = body.peer_id.toLowerCase();
		let decoded: message.ICustomMessage;
		try {
			decoded = message.decodeCustomMessage(raw.subarray(2));
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
