/**
 * The peer link: how roux reaches a beignet node.
 *
 * beignet's own liquidity engines talk to peers through a five-method seam
 * (`IDfPeerMessaging`: who am I, send a custom message, hear custom messages,
 * am I connected, connect). roux reuses that seam verbatim, so beignet's
 * direct-funding lanes and payer engine run unchanged on top of ANY of the
 * links below. A link is where the identity lives:
 *
 *  - `NoisePeerLink`  a standalone BOLT 8 connection with a key roux holds
 *                     (ephemeral or yours). Right for paying direct-funding
 *                     requests from any wallet, and for JIT when this process
 *                     IS the node that will accept the channel.
 *  - `LndPeerLink`    LND's own connection to the beignet node, driven over
 *                     its REST custom-message API. The beignet node sees your
 *                     LND identity, so a JIT channel it opens lands on LND.
 *  - `ClnPeerLink`    the same for Core Lightning over clnrest.
 *
 * Anything that implements this interface is a link: a host that already
 * has a peer connection of its own (an LDK app, an Eclair plugin) adapts it
 * in a few lines.
 */

import type { directFunding } from 'beignet/lightning';

/** One decoded beignet custom message, as the node's own event carries it. */
export type ICustomMessage = directFunding.IDfCustomMessage;

export interface IPeerLink extends directFunding.IDfPeerMessaging {
	/**
	 * Bring the link up: learn our own node id, subscribe to inbound custom
	 * messages. Idempotent. `nodeIdHex()` is only meaningful afterwards on
	 * links whose identity lives in another process.
	 */
	open?(): Promise<void>;
	/** Drop a peer connection (a hint; a node-backed link may keep it). */
	disconnectPeer?(peerPubkeyHex: string): void;
	/** Release every connection, subscription and timer. */
	close(): Promise<void> | void;
}

/**
 * Deliver one message to every listener, each in its own try/catch. The node
 * runs its listeners inside ONE try/catch, so a throwing listener there
 * skips the ones after it; beignet's lanes are written to survive that, and
 * isolating here is strictly safer.
 */
export function deliverIsolated(
	listeners: Iterable<(msg: ICustomMessage) => void>,
	msg: ICustomMessage,
	onError: (err: unknown) => void
): void {
	for (const listener of [...listeners]) {
		try {
			listener(msg);
		} catch (err) {
			onError(err);
		}
	}
}
