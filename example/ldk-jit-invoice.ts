/**
 * LDK (rust-lightning): get inbound liquidity from a beignet LSP.
 *
 *   BRIDGE=127.0.0.1:7777 BRIDGE_TOKEN=<token> BEIGNET_LSP=<pubkey@host:port> \
 *   NETWORK=mainnet AMOUNT_SATS=100000 npm run example:ldk-jit
 *
 * An LDK application holds its own node key and peer connections, so
 * roux talks to the beignet LSP THROUGH the application: the app implements
 * the five HTTP routes documented in `example/ldk-bridge/` around its
 * supplied CustomMessageHandler for message type 44069, and roux's
 * BridgePeerLink drives the protocol over it. The LSP sees the LDK node's
 * identity, so the channel it opens lands on the LDK node.
 *
 * What comes back is the route hint for the invoice. Build the invoice on
 * the Rust side with `lightning-invoice`'s builder:
 *
 *   let hop = RouteHintHop {
 *       src_node_id: lsp_pubkey,
 *       short_channel_id: u64::from_str_radix(grant.interceptScidHex, 16),
 *       fees: RoutingFees { base_msat: grant.routeHint.feeBaseMsat,
 *                           proportional_millionths: grant.routeHint.feeProportionalMillionths },
 *       cltv_expiry_delta: grant.routeHint.cltvExpiryDelta as u16,
 *       htlc_minimum_msat: None, htlc_maximum_msat: None,
 *   };
 *   InvoiceBuilder::new(currency)
 *       .amount_milli_satoshis(amount_msat)
 *       .private_route(RouteHint(vec![hop]))
 *       .min_final_cltv_expiry_delta(grant.minFinalCltvExpiry as u64)
 *       ... (payment hash and secret from ChannelManager::create_inbound_payment)
 *
 * and have the ChannelManager accept a zero-conf channel from the LSP
 * (`manually_accept_inbound_channels` plus
 * `accept_inbound_channel_from_trusted_peer_0conf` for the LSP's pubkey).
 * The fee is in hop mode: the sender pays it through the hint, and the
 * forward is the full amount, so no final-hop allowance is needed. (A
 * rust-lightning app that DOES implement the allowance can pass
 * `acceptsSkimmedFee: true` and take the fee off the delivery instead.)
 */

import { BeignetClient, BridgePeerLink, consoleLog } from '../src';

async function main(): Promise<void> {
	const [host, port] = (process.env.BRIDGE ?? '127.0.0.1:7777').split(':');
	const amountSats = Number(process.env.AMOUNT_SATS ?? 100_000);
	const client = new BeignetClient({
		network: (process.env.NETWORK as 'mainnet' | 'regtest') ?? 'regtest',
		link: new BridgePeerLink({
			host,
			port: Number(port),
			token: process.env.BRIDGE_TOKEN,
			log: consoleLog('ldk-bridge')
		}),
		log: consoleLog('roux')
	});
	try {
		const lsp = await client.connect(process.env.BEIGNET_LSP ?? '');
		console.log('LDK node', client.nodeIdHex(), 'connected to', lsp.pubkeyHex);
		const quote = await client.jit.quote(lsp.pubkeyHex, {
			maxAmountSat: amountSats
		});
		if (!quote.accepted) {
			console.log('declined:', quote.reason);
			return;
		}
		const grant = await client.jit.authorize(lsp.pubkeyHex, {
			maxAmountSat: amountSats,
			expectedTotalSat: amountSats
		});
		// Everything the Rust side needs for RouteHintHop and the builder.
		console.log(
			JSON.stringify(
				{
					feeMode: grant.feeMode,
					lspPubkey: grant.lspPubkeyHex,
					interceptScidHex: grant.interceptScidHex,
					interceptScidU64: grant.interceptScid.readBigUInt64BE(0).toString(),
					routeHint: grant.routeHint,
					minFinalCltvExpiry: grant.minFinalCltvExpiry,
					senderPaysSats: grant.openingFeeSats(amountSats).toString()
				},
				null,
				2
			)
		);
	} finally {
		await client.close();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
