# roux LDK bridge (reference)

The Rust half of running roux against a [rust-lightning](https://github.com/lightningdevkit/rust-lightning) node. roux (TypeScript) needs to put one custom message type, 44069, on the node's own peer connections and hear it back; rust-lightning routes unknown types to a `CustomMessageHandler`. `src/lib.rs` is that handler, about 150 lines, with unit tests (`cargo test`).

This directory is a library reference. It does not include an HTTP server,
a runnable LDK node, invoice creation, channel acceptance or a wallet signing
bridge. The embedding application implements those pieces. Start with the
[example setup guide](../README.md).

## Wire it into your node

```rust
let bridge = roux_ldk_bridge::BeignetBridge::new();
let peer_manager = PeerManager::new(
    MessageHandler {
        chan_handler: channel_manager.clone(),
        route_handler: gossip_sync.clone(),
        onion_message_handler: onion_messenger.clone(),
        custom_message_handler: bridge.clone(),   // <- here
        send_only_message_handler: ...,
    },
    ...
);
```

## Serve the five routes

With any HTTP framework, on localhost, behind a bearer token (`BridgePeerLink({ token })` sends `Authorization: Bearer ...`):

| Route | Does |
|---|---|
| `GET /info` | `{ "nodeId": hex(channel_manager.get_our_node_id()) }` |
| `GET /peers` | `{ "peers": [hex, ...] }` from `peer_manager.list_peers()` |
| `POST /connect` `{pubkey, host, port}` | your usual `lightning_net_tokio::connect_outbound`, then wait until the peer is in `list_peers()` |
| `POST /send` `{peer, type, payload}` | `bridge.send(peer, hex::decode(payload))`, then `peer_manager.process_events()` |
| `GET /events` (SSE) | on each `bridge.drain_inbound()` item, write `data: {"peer": hex, "type": 44069, "payload": hex}\n\n` |

`payload` is the message body after the two-byte type, in both directions. Drain inbound frames promptly (poll `drain_inbound()` on a short timer or hook it to a `Notify`), and keep the SSE response open; `BridgePeerLink` reconnects if it drops.

## Then, from TypeScript

```ts
const client = new BeignetClient({ network, link: new BridgePeerLink({ host, port, token }) });
await client.connect('02...@lsp.example:9735');
const grant = await client.jit.authorize(lspPubkey, { maxAmountSat: 100_000 });
```

`example/ldk-jit-invoice.ts` prints what the Rust side needs for `RouteHintHop` and the `lightning-invoice` builder. The channel the LSP opens is zero-conf: accept it with `manually_accept_inbound_channels` and `accept_inbound_channel_from_trusted_peer_0conf` for the LSP's pubkey.

This reference targets applications built directly on rust-lightning. Roux does not provide a ready-made adapter for an existing `ldk-node` instance.
