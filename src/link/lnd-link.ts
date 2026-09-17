/**
 * A link that rides LND's own connection to the beignet node.
 *
 * LND lets an authorized client send and receive arbitrary custom messages
 * on behalf of the node (`SendCustomMessage` / `SubscribeCustomMessages`,
 * lnd 0.15+), and the beignet type 44069 is in the range LND passes through
 * without configuration (>= 32768). So the beignet node sees YOUR LND
 * identity, and a JIT channel it opens lands on your LND, which is the whole
 * point for JIT: the LSP opens to whoever registered the intent.
 *
 * What LND cannot do is settle an HTLC short of the onion amount, so a JIT
 * intent from this link must say `acceptsSkimmedFee: false` (the default)
 * and will only be accepted by an LSP that charges no opening fee. See
 * jit/client.ts.
 *
 * REST only, over Node's https so the node's self-signed tls.cert can be
 * pinned (`ca`) or, on localhost, ignored (`rejectUnauthorized: false`).
 */

import { message } from 'beignet/lightning';
import { RouxLog, noopLog } from '../types';
import { ICustomMessage, IPeerLink, deliverIsolated } from './types';
import { IHttpEndpoint, IStreamHandle, requestJson, streamLines } from './http';

export interface ILndPeerLinkOptions {
	host: string;
	/** REST port (default 8080). */
	port?: number;
	/** Hex-encoded macaroon with peers:write, peers:read, info:read and offchain:write. */
	macaroonHex: string;
	https?: boolean;
	ca?: IHttpEndpoint['ca'];
	rejectUnauthorized?: boolean;
	/** How often the connected-peer cache is refreshed (default 10 s). */
	peerRefreshMs?: number;
	/** Pause before re-opening a dropped subscription (default 2 s). */
	resubscribeDelayMs?: number;
	log?: RouxLog;
}

interface ILndCustomMessage {
	peer: string;
	type: number;
	data: string;
}

export class LndPeerLink implements IPeerLink {
	private readonly ep: IHttpEndpoint;
	private readonly log: RouxLog;
	private readonly listeners = new Set<(msg: ICustomMessage) => void>();
	private readonly connected = new Set<string>();
	private nodeId: string | null = null;
	private stream: IStreamHandle | null = null;
	private refreshTimer: NodeJS.Timeout | null = null;
	private opening: Promise<void> | null = null;
	private closed = false;

	constructor(private readonly options: ILndPeerLinkOptions) {
		this.ep = {
			host: options.host,
			port: options.port ?? 8080,
			https: options.https,
			ca: options.ca,
			rejectUnauthorized: options.rejectUnauthorized,
			headers: { 'Grpc-Metadata-macaroon': options.macaroonHex }
		};
		this.log = options.log ?? noopLog;
	}

	async open(): Promise<void> {
		if (this.closed) throw new Error('link is closed');
		if (this.nodeId) return;
		if (this.opening) return this.opening;
		this.opening = (async (): Promise<void> => {
			const info = await requestJson<{ identity_pubkey: string }>(
				this.ep,
				'GET',
				'/v1/getinfo'
			);
			this.nodeId = info.identity_pubkey.toLowerCase();
			await this.refreshPeers();
			this.subscribe();
			const every = this.options.peerRefreshMs ?? 10_000;
			this.refreshTimer = setInterval(() => {
				void this.refreshPeers().catch((err) =>
					this.log('lnd_peer_refresh_failed', { error: String(err) })
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
		if (!this.nodeId) throw new Error('LndPeerLink.open() has not completed');
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
		try {
			await requestJson(this.ep, 'POST', '/v1/peers', {
				addr: { pubkey: hex, host: `${host}:${port}` },
				perm: false,
				timeout: '15'
			});
		} catch (err) {
			// LND answers a dial to a peer it already holds with an error.
			if (!/already connected/i.test(String((err as Error).message))) throw err;
		}
		await this.refreshPeers();
		if (!this.connected.has(hex)) {
			throw new Error(`LND did not report ${hex} as connected after the dial`);
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
		// The seam is synchronous (beignet's engines send from timers and
		// message handlers), so the HTTP call runs detached and a failure is
		// logged. Delivery is at-least-once by protocol design: the payer
		// engine re-sends an unanswered offer.
		void requestJson(this.ep, 'POST', '/v1/custommessage', {
			peer: Buffer.from(hex, 'hex').toString('base64'),
			type: message.BEIGNET_CUSTOM_MESSAGE_TYPE,
			data: envelope.toString('base64')
		}).catch((err) =>
			this.log('lnd_send_failed', { pubkey: hex, subtype, error: String(err) })
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
		const res = await requestJson<{ peers?: Array<{ pub_key: string }> }>(
			this.ep,
			'GET',
			'/v1/peers'
		);
		this.connected.clear();
		for (const p of res.peers ?? [])
			this.connected.add(p.pub_key.toLowerCase());
	}

	private subscribe(): void {
		if (this.closed) return;
		this.stream = streamLines(
			this.ep,
			'GET',
			'/v1/custommessage/subscribe',
			(line) => this.onLine(line)
		);
		this.stream.done
			.catch((err) => this.log('lnd_subscribe_error', { error: String(err) }))
			.then(() => {
				this.stream = null;
				if (this.closed) return;
				const delay = this.options.resubscribeDelayMs ?? 2_000;
				const t = setTimeout(() => this.subscribe(), delay);
				t.unref?.();
			});
	}

	private onLine(line: string): void {
		let parsed: { result?: ILndCustomMessage; error?: unknown };
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (parsed.error) {
			this.log('lnd_subscribe_error', { error: parsed.error });
			return;
		}
		const m = parsed.result;
		if (!m || Number(m.type) !== message.BEIGNET_CUSTOM_MESSAGE_TYPE) return;
		const peerHex = Buffer.from(m.peer, 'base64').toString('hex');
		let decoded: message.ICustomMessage;
		try {
			decoded = message.decodeCustomMessage(Buffer.from(m.data, 'base64'));
		} catch (err) {
			this.log('custom_message_decode_failed', {
				pubkey: peerHex,
				error: String(err)
			});
			return;
		}
		// A message from a peer proves the connection; the cache may lag.
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
