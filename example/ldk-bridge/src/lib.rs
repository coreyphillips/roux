//! Reference bridge for rust-lightning applications.
//!
//! roux (TypeScript) speaks the beignet peer protocol: one custom BOLT 1
//! message type, 44069, on an ordinary peer connection. An LDK application
//! holds its own node key and its own connections, so roux does not dial
//! the beignet node itself; it asks the application to carry the frames.
//! This crate is the application's half: a `CustomMessageHandler` that
//! accepts type 44069 from any peer and queues outbound frames, exposed to
//! roux's `BridgePeerLink` through five HTTP routes the application
//! serves however it likes (axum, warp, tiny_http, ...):
//!
//! ```text
//! GET  /info      -> { "nodeId": "<hex>" }
//! GET  /peers     -> { "peers": ["<hex>", ...] }
//! POST /connect   <- { "pubkey": "<hex>", "host": "...", "port": n }
//! POST /send      <- { "peer": "<hex>", "type": 44069, "payload": "<hex>" }
//! GET  /events    -> SSE, one `data: {"peer","type","payload"}` per inbound frame
//! ```
//!
//! `payload` is the message body after the two-byte type: exactly the bytes
//! `CustomMessageReader::read` is handed, and exactly what `Writeable`
//! writes. Nothing here interprets them.
//!
//! Wiring: pass a `BeignetBridge` as the custom message handler of your
//! `PeerManager` (`MessageHandler { custom_message_handler: bridge.clone(),
//! .. }`), serve the routes over it, and call
//! `peer_manager.process_events()` after `send` so the queued frame leaves.
//! `/info` is `channel_manager.get_our_node_id()`, `/peers` is
//! `peer_manager.list_peers()`, `/connect` is your usual
//! `lightning_net_tokio::connect_outbound`.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use bitcoin::secp256k1::PublicKey;
use lightning::io;
use lightning::ln::msgs::{DecodeError, Init, LightningError};
use lightning::ln::peer_handler::CustomMessageHandler;
use lightning::ln::wire::{CustomMessageReader, Type};
use lightning::types::features::{InitFeatures, NodeFeatures};
use lightning::util::ser::{Writeable, Writer};

/// The one wire type every beignet liquidity protocol rides.
pub const BEIGNET_CUSTOM_MESSAGE_TYPE: u16 = 44069;

/// A beignet frame: the body after the wire type, uninterpreted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BeignetMessage(pub Vec<u8>);

impl Type for BeignetMessage {
	fn type_id(&self) -> u16 {
		BEIGNET_CUSTOM_MESSAGE_TYPE
	}
}

impl Writeable for BeignetMessage {
	fn write<W: Writer>(&self, w: &mut W) -> Result<(), io::Error> {
		w.write_all(&self.0)
	}
}

/// One inbound frame, as the `/events` stream reports it.
#[derive(Clone, Debug)]
pub struct InboundFrame {
	pub peer: PublicKey,
	pub payload: Vec<u8>,
}

/// The handler. Clone it (it is an `Arc` inside) and hand one clone to the
/// `PeerManager`, keep the other for the HTTP routes.
#[derive(Clone, Default)]
pub struct BeignetBridge {
	inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
	/// Frames roux asked us to send, drained by the PeerManager.
	outbound: VecDeque<(PublicKey, BeignetMessage)>,
	/// Frames peers sent us, drained by the `/events` route.
	inbound: VecDeque<InboundFrame>,
}

impl BeignetBridge {
	pub fn new() -> Self {
		Self::default()
	}

	/// `POST /send`: queue a frame for `peer`. Call
	/// `peer_manager.process_events()` afterwards so it leaves promptly.
	pub fn send(&self, peer: PublicKey, payload: Vec<u8>) {
		self.inner
			.lock()
			.unwrap()
			.outbound
			.push_back((peer, BeignetMessage(payload)));
	}

	/// `GET /events`: everything that arrived since the last call.
	pub fn drain_inbound(&self) -> Vec<InboundFrame> {
		self.inner.lock().unwrap().inbound.drain(..).collect()
	}
}

impl CustomMessageReader for BeignetBridge {
	type CustomMessage = BeignetMessage;

	fn read<R: io::Read>(
		&self,
		message_type: u16,
		buffer: &mut R,
	) -> Result<Option<Self::CustomMessage>, DecodeError> {
		if message_type != BEIGNET_CUSTOM_MESSAGE_TYPE {
			// Not ours: the PeerManager treats an unknown odd type as
			// ignorable, exactly what BOLT 1 asks of a peer that does not
			// speak a protocol.
			return Ok(None);
		}
		// lightning::io::Read is the crate's own no_std-friendly trait: it has
		// `read` but no `read_to_end`, so drain the reader by hand.
		let mut payload = Vec::new();
		let mut chunk = [0u8; 1024];
		loop {
			let n = buffer.read(&mut chunk)?;
			if n == 0 {
				break;
			}
			payload.extend_from_slice(&chunk[..n]);
		}
		Ok(Some(BeignetMessage(payload)))
	}
}

impl CustomMessageHandler for BeignetBridge {
	fn handle_custom_message(
		&self,
		msg: BeignetMessage,
		sender_node_id: PublicKey,
	) -> Result<(), LightningError> {
		self.inner.lock().unwrap().inbound.push_back(InboundFrame {
			peer: sender_node_id,
			payload: msg.0,
		});
		Ok(())
	}

	fn get_and_clear_pending_msg(&self) -> Vec<(PublicKey, BeignetMessage)> {
		self.inner.lock().unwrap().outbound.drain(..).collect()
	}

	fn peer_disconnected(&self, _their_node_id: PublicKey) {}

	fn peer_connected(
		&self,
		_their_node_id: PublicKey,
		_msg: &Init,
		_inbound: bool,
	) -> Result<(), ()> {
		Ok(())
	}

	fn provided_node_features(&self) -> NodeFeatures {
		// The beignet protocol needs no feature bit: 44069 is odd, so a peer
		// that does not speak it ignores it.
		NodeFeatures::empty()
	}

	fn provided_init_features(&self, _their_node_id: PublicKey) -> InitFeatures {
		InitFeatures::empty()
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use bitcoin::secp256k1::{Secp256k1, SecretKey};

	fn peer() -> PublicKey {
		PublicKey::from_secret_key(&Secp256k1::new(), &SecretKey::from_slice(&[7u8; 32]).unwrap())
	}

	#[test]
	fn reads_only_the_beignet_type() {
		let bridge = BeignetBridge::new();
		let body = [0u8, 1, 0, 4, 0xaa, 0xbb];
		let read = bridge.read(BEIGNET_CUSTOM_MESSAGE_TYPE, &mut &body[..]).unwrap();
		assert_eq!(read, Some(BeignetMessage(body.to_vec())));
		assert_eq!(bridge.read(32768, &mut &body[..]).unwrap(), None);
	}

	#[test]
	fn queues_both_directions() {
		let bridge = BeignetBridge::new();
		bridge.send(peer(), vec![1, 2, 3]);
		let out = bridge.get_and_clear_pending_msg();
		assert_eq!(out.len(), 1);
		assert_eq!(out[0].1, BeignetMessage(vec![1, 2, 3]));
		assert!(bridge.get_and_clear_pending_msg().is_empty());

		bridge
			.handle_custom_message(BeignetMessage(vec![9]), peer())
			.unwrap();
		let inbound = bridge.drain_inbound();
		assert_eq!(inbound.len(), 1);
		assert_eq!(inbound[0].payload, vec![9]);
		assert_eq!(inbound[0].peer, peer());
	}

	#[test]
	fn writes_the_body_verbatim() {
		let mut out = Vec::new();
		BeignetMessage(vec![0, 1, 0, 16, 0xff]).write(&mut out).unwrap();
		assert_eq!(out, vec![0, 1, 0, 16, 0xff]);
	}
}
