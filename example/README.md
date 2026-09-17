# Running the examples

Roux supports JIT inbound liquidity, paying beignet direct-funding requests, and reverse swaps from Lightning to on-chain bitcoin. The reverse provider is merged into beignet master. Submarine swaps from on-chain funds to a Lightning invoice still need provider and client implementations, tracked in [beignet #737](https://github.com/coreyphillips/beignet/issues/737).

| Instance                     | JIT receive                                                                          | Pay a direct-funding request                              | Reverse swap                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| LND                          | Supplied REST link and invoice script; configure channel acceptance                  | Supplied wallet adapter; keys stay in LND                 | Supplied link, payer and runnable example                                                 |
| CLN                          | Supplied clnrest link; application invoice and channel integration required          | Supplied wallet adapter; keys stay in CLN                 | Supplied link, payer and runnable example                                                 |
| rust-lightning application   | Integrate the reference handler, HTTP bridge, invoice builder and channel acceptance | Export test coins and keys, or implement a wallet adapter | Integrate the bridge and implement ISwapLightningPayer; no runnable swap example supplied |
| Existing `ldk-node` instance | No ready-made adapter supplied                                                       | No ready-made node wallet adapter supplied                | No ready-made adapter supplied                                                            |

## Local setup

Use Node 18 or later. Build the local beignet master checkout containing merged PRs #734 to #736 and #738 to #740 (included in the local 0.15.0 checkout), then install and build roux:

```bash
cd /path/to/beignet
npm install
npm run build
cd /path/to/roux
npm install
npm run build
```

The local dependency in `package.json` points to `../synonym/beignet`. Adjust it if your directory layout differs. These commands use that checkout and do not assume an npm release.

The commands below use regtest. Replace values in angle brackets with your instance's values. All participating nodes, coins, requests and chain backends must use the same network. The beignet provider must enable the relevant service and accept the requested amount and fee policy.

The LND scripts disable TLS certificate verification for local testing. For a deployed integration, pass LND's certificate through the adapters' `ca` option, enable certificate verification and apply the same settings to invoice RPC calls. HTTPS is the default. The JIT and direct-funding scripts accept `LND_TLS=false` for local HTTP endpoints. The reverse-swap script currently uses HTTPS; an HTTP integration must set `https: false` on both its LndPeerLink and LndPayer options.

## LND: receive with JIT liquidity

[lnd-jit-invoice.ts](lnd-jit-invoice.ts) connects LND to the beignet LSP, requests a quote, registers a receive intent and creates a BOLT 11 invoice on LND using the returned route hint. The opening fee uses hop mode, so the payer pays it through the hint.

Before running it:

1. Enable LND's REST API and supply a macaroon authorized for node info, peer operations, custom messages and invoice creation. An admin macaroon covers the local example.
2. Enable `--protocol.option-scid-alias` and `--protocol.zero-conf` on LND.
3. Run a ChannelAcceptor that accepts a zero-conf channel from your trusted LSP, with `zero_conf: true` and `min_accept_depth: 0`. The script does not install an acceptor. See [LND's acceptor guide](https://github.com/lightninglabs/docs.lightning.engineering/blob/master/lightning-network-tools/lnd/channel-acceptor.md) and [response fields](https://lightning.engineering/api-docs/api/lnd/lightning/channel-acceptor/).

```bash
LND_REST='127.0.0.1:8080' \
LND_MACAROON='<macaroon hex>' \
BEIGNET_LSP='<compressed node pubkey>@<host>:<port>' \
NETWORK=regtest AMOUNT_SATS=100000 \
npm run example:lnd-jit
```

The output contains the invoice and payment hash. Pay that invoice from another node with a route to the LSP. Keep LND and its acceptor running while the LSP opens the channel and forwards the payment. Printing an invoice does not establish that the payment settled.

## LND: Lightning to on-chain (reverse swap)

[lnd-reverse-swap.ts](lnd-reverse-swap.ts) moves Lightning balance to LND's own on-chain wallet through a beignet provider. roux verifies the provider's terms, writes the swap record (claim key and preimage included) to `~/.roux/swaps.json` before LND pays, waits for one confirmation of the provider's funding, claims the contract to an LND address through Bitcoin Core, and prints the final swap state and confirmed claim transaction ID.

The beignet provider needs `BEIGNET_SWAPS=true` and spendable on-chain funds. Your node needs enough outbound Lightning liquidity and a route to the provider. Bitcoin Core must track the same network and provide the RPC used to verify and broadcast the claim. No JIT channel acceptor is needed for this flow over existing channels. The on-chain claim pays a miner fee, in addition to the provider's quoted swap fees.

```bash
LND_REST='127.0.0.1:8080' LND_MACAROON='<macaroon hex>' \
BEIGNET_PROVIDER='<compressed node pubkey>@<host>:<port>' \
BITCOIN_RPC='127.0.0.1:18443' BITCOIN_RPC_USER=u BITCOIN_RPC_PASS=p \
NETWORK=regtest AMOUNT_SATS=100000 npm run example:lnd-reverse-swap
```

`RESUME=1` re-checks every unresolved swap in the file instead of opening a new one. Treat `~/.roux/swaps.json` as a wallet file.

## CLN: Lightning to on-chain (reverse swap)

[cln-reverse-swap.ts](cln-reverse-swap.ts) is the CLN twin (`CLN_REST`, `CLN_RUNE`; the rune needs getinfo, listpeers, connect, sendcustommsg, pay, listpays and newaddr; the `ws` package must be installed for clnrest's notifications).

```bash
CLN_REST='127.0.0.1:3010' CLN_RUNE='<rune>' BEIGNET_PROVIDER='<pubkey>@<host>:<port>' \
BITCOIN_RPC='127.0.0.1:18443' BITCOIN_RPC_USER=u BITCOIN_RPC_PASS=p \
NETWORK=regtest AMOUNT_SATS=100000 npm run example:cln-reverse-swap
```

Both reverse examples use `~/.roux/swaps.json`. Use a separate storage path for independent nodes or networks. On regtest, mine blocks to confirm the provider's funding and your claim. Live tests sharing the same Docker node should run sequentially, including Roux and beignet CLN suites.

## LND: on-chain to Lightning (submarine swap)

[lnd-submarine-swap.ts](lnd-submarine-swap.ts) moves an on-chain coin from LND's wallet into LND's own Lightning balance through a beignet provider running the submarine role (`BEIGNET_SWAP_SUBMARINE=true`). roux quotes, has LND mint the invoice (or takes `INVOICE=<bolt11>` of your own for exactly the quoted amount), verifies the provider's terms and the CLTV fit, writes the record (refund key included) to `~/.roux/swaps.json` before anything is funded, pays the contract from LND's wallet through `sendcoins`, and follows the swap: SETTLED once the provider pays the invoice and claims, or REFUNDED after the refund height. The refund never goes out while LND holds the provider's HTLC, and the process (or `RESUME=1`) must be running past the refund height for it to happen.

The provider needs outbound Lightning liquidity toward your node and a route to it. Your node needs a channel already; a swap into a channel the provider would open for you at the same time is refused. LND needs `invoices:read`, `invoices:write` and `onchain:write` on top of the reverse permissions.

```bash
LND_REST='127.0.0.1:8080' LND_MACAROON='<macaroon hex>' \
BEIGNET_PROVIDER='<compressed node pubkey>@<host>:<port>' \
BITCOIN_RPC='127.0.0.1:18443' BITCOIN_RPC_USER=u BITCOIN_RPC_PASS=p \
NETWORK=regtest AMOUNT_SATS=100000 npm run example:lnd-submarine-swap
```

`RESUME=1` re-checks every unresolved swap in the file; a swap whose funding call was made and its reply lost is reported and never funded again by the tool, since the coins may be on chain: check the wallet, then `attachFunding(txid)` or `fund({ force: true })`.

## CLN: on-chain to Lightning (submarine swap)

[cln-submarine-swap.ts](cln-submarine-swap.ts) is the CLN twin (`CLN_REST`, `CLN_RUNE`; the rune needs getinfo, listpeers, connect, sendcustommsg, invoice, listinvoices, listpeerchannels (CLN 23.02 or later, to see an HTLC parked on an unpaid invoice), withdraw, listtransactions and newaddr; the `ws` package must be installed for clnrest's notifications).

```bash
CLN_REST='127.0.0.1:3010' CLN_RUNE='<rune>' BEIGNET_PROVIDER='<pubkey>@<host>:<port>' \
BITCOIN_RPC='127.0.0.1:18443' BITCOIN_RPC_USER=u BITCOIN_RPC_PASS=p \
NETWORK=regtest AMOUNT_SATS=100000 npm run example:cln-submarine-swap
```

## LND: pay a beignet direct-funding request

[lnd-pay-request.ts](lnd-pay-request.ts) spends one confirmed P2WPKH or P2TR coin from LND's on-chain wallet. LND signs the ownership proof and funding witness without exporting a private key. Its wallet lease protects the selected coin during signing.

Obtain a fresh BIP 21 request containing `bgnq` from a beignet receiver configured for direct funding. Fund LND's wallet with enough for the requested amount and fees. Use a macaroon permitting the wallet, address, message-signing and node-info RPCs used by `LndWallet`.

```bash
LND_REST='127.0.0.1:8080' \
LND_MACAROON='<macaroon hex>' \
REQUEST='bitcoin:<regtest address>?amount=0.001&bgnq=<request>' \
NETWORK=regtest MAX_FEE_SATS=1000 \
npm run example:lnd-pay
```

Use the complete request issued by the receiver, rather than assembling one from the placeholders. Set `AMOUNT_SATS` when the request leaves the amount to the payer. This script uses an ephemeral peer identity for the payment; it does not require a Lightning channel from LND to the receiver.

The result prints the status, funding transaction id and receipt or caveat. Payment records are stored at `~/.roux/lnd-payments.json`. A released funding witness can still be broadcast even if the receipt is missing. Preserve the records and use `client.directFunding.reconcile()` and `payments()` in the continuing application to track confirmation. The example exits after the payment attempt; its output alone is not confirmation.

## LDK: receive with JIT liquidity

[ldk-jit-invoice.ts](ldk-jit-invoice.ts) targets an application built directly on rust-lightning. The supplied [Rust handler](ldk-bridge/README.md) is a library reference with unit tests. It does not include an HTTP server or a runnable LDK node.

The application needs to:

1. Register `BeignetBridge` as the `PeerManager` custom-message handler for type 44069.
2. Serve the five HTTP/SSE routes documented in [ldk-bridge](ldk-bridge/README.md), bound locally and protected with a bearer token. Forward outbound messages through `process_events()` and drain inbound messages into the SSE stream.
3. Build the invoice in Rust with the returned route hint and final CLTV, plus the application's payment hash and secret.
4. Configure inbound channel handling to accept zero-conf from the trusted LSP, using `manually_accept_inbound_channels` and `accept_inbound_channel_from_trusted_peer_0conf`.

Once the bridge is running:

```bash
BRIDGE='127.0.0.1:7777' \
BRIDGE_TOKEN='<local bridge token>' \
BEIGNET_LSP='<compressed node pubkey>@<host>:<port>' \
NETWORK=regtest AMOUNT_SATS=100000 \
npm run example:ldk-jit
```

This prints the grant's route hint, intercept short channel id, fee mode and minimum final CLTV. Feed them into the Rust invoice builder as illustrated in the script. The script does not create or pay the invoice itself. There is no live LDK settlement fixture or ready-made integration for an existing `ldk-node` instance.

## LDK/BDK: pay from exported test coins

[ldk-pay-request.ts](ldk-pay-request.ts) demonstrates a generic keyed-wallet payment using coins exported by a Rust application. It does not call an existing LDK node's wallet RPC. A signing bridge that keeps private keys inside the Rust application remains application work.

Prepare `coins.json` as an array with these fields for each eligible coin:

| Field        | Value                                              |
| ------------ | -------------------------------------------------- |
| `txid`       | Funding transaction id, displayed hex              |
| `vout`       | Output index                                       |
| `valueSat`   | Output value in satoshis                           |
| `script`     | Output script hex: P2WPKH or BIP 86 P2TR           |
| `height`     | Positive block height at which the coin confirmed  |
| `privateKey` | 32-byte private key hex; the internal key for P2TR |

Derive the key using the full wallet descriptor path, including keychain and index. The adapter checks that the key controls the output script. The key file remains on disk after the payment, so use a dedicated test wallet for this example.

Reserve exported coins in the originating wallet until payment resolution. `KeyedUtxoWallet` freezes only its own in-memory coin selection; it does not reserve coins in BDK or persist that freeze across processes. A production `IDfSenderWallet` adapter must connect to the wallet's real coin discovery, signing, reservation/release, change and chain lookup operations, with durable recovery through the payer ledger.

```bash
REQUEST='bitcoin:<regtest address>?amount=0.001&bgnq=<request>' \
COINS='./coins.json' \
CHANGE='<regtest change address controlled by the wallet>' \
ESPLORA='http://127.0.0.1:3002' \
TIP='<current regtest block height>' \
NETWORK=regtest MAX_FEE_SATS=1000 \
npm run example:ldk-pay
```

Use the receiver's complete request. `ESPLORA` must serve raw transactions at `/tx/<txid>/hex` for verification. Set `AMOUNT_SATS` for an amountless request. One coin must cover the payment and fees. Records are stored at `~/.roux/payments.json`; preserve them and reconcile pending funding before reusing a coin.
