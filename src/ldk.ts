/**
 * `roux/ldk`: the link for a rust-lightning application that exposes
 * the HTTP bridge described in `example/ldk-bridge/`. The application
 * supplies the wallet and payer adapters itself.
 */

export { BridgePeerLink } from './link/bridge-link';
export type { IBridgePeerLinkOptions } from './link/bridge-link';
