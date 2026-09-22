#!/usr/bin/env node
/**
 * roux-boltzd: stop boltzd, start this on the same data directory, and
 * boltzcli (or any boltzrpc client) keeps working, now against a beignet
 * provider. See config.ts for the configuration and README.md for what
 * differs.
 */

import { consoleLog } from '../types';
import {
	BOLTZ_DAEMON_USAGE,
	loadBoltzDaemonConfig,
	parseFlags
} from './config';
import { packageVersion, startBoltzDaemon } from './daemon';

async function main(argv: string[]): Promise<void> {
	const flags = parseFlags(argv);
	if (flags.help) {
		process.stdout.write(BOLTZ_DAEMON_USAGE);
		return;
	}
	const version = packageVersion();
	if (flags.version) {
		console.log(version);
		return;
	}
	const config = loadBoltzDaemonConfig(argv);
	const daemon = await startBoltzDaemon(config, {
		log: consoleLog('roux-boltzd'),
		version
	});
	console.error(
		`roux-boltzd: ${config.network}, ${config.node}, serving ${
			config.rpc.host
		}:${daemon.port} (${daemon.tls ? 'TLS' : 'plaintext'}), provider ${
			config.provider
		}, swaps in ${config.storePath}`
	);
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
		void daemon.stopRequested.then(resolve);
	});
	console.error('roux-boltzd: stopping');
	await daemon.close();
}

main(process.argv.slice(2)).then(
	() => process.exit(0),
	(err) => {
		console.error(
			`roux-boltzd: ${err instanceof Error ? err.message : String(err)}`
		);
		process.exit(1);
	}
);
