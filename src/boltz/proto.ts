/**
 * boltz-client's gRPC service, loaded from the vendored proto at runtime.
 *
 * Field names stay snake_case as the proto spells them, enums arrive as
 * their names, 64-bit integers as numbers (satoshi amounts fit), and unset
 * fields stay undefined, so a handler can tell "absent" from "zero" for
 * the proto3 `optional` fields boltzcli relies on.
 */

import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

/** proto/ sits at the package root, beside src/ and dist/. */
export const BOLTZRPC_PROTO_PATH = path.join(
	__dirname,
	'..',
	'..',
	'proto',
	'boltzrpc.proto'
);

/** The boltz-client release the proto was vendored from. */
export const BOLTZRPC_PROTO_VERSION = 'v2.12.5';

export const BOLTZRPC_LOADER_OPTIONS: protoLoader.Options = {
	keepCase: true,
	longs: Number,
	enums: String,
	defaults: false,
	oneofs: true
};

let cached: grpc.GrpcObject | null = null;

function load(): grpc.GrpcObject {
	if (!cached) {
		const definition = protoLoader.loadSync(
			BOLTZRPC_PROTO_PATH,
			BOLTZRPC_LOADER_OPTIONS
		);
		cached = grpc.loadPackageDefinition(definition);
	}
	return cached;
}

type BoltzClientConstructor = grpc.ServiceClientConstructor;

function boltzConstructor(): BoltzClientConstructor {
	const pkg = load().boltzrpc as grpc.GrpcObject;
	return pkg.Boltz as BoltzClientConstructor;
}

/** The `boltzrpc.Boltz` service definition, for `server.addService`. */
export function boltzServiceDefinition(): grpc.ServiceDefinition {
	return boltzConstructor().service;
}

/** A generic client for the service (tests, scripts). */
export function boltzClient(
	address: string,
	credentials: grpc.ChannelCredentials
): grpc.Client & Record<string, (...args: unknown[]) => unknown> {
	const Ctor = boltzConstructor();
	return new Ctor(address, credentials) as grpc.Client &
		Record<string, (...args: unknown[]) => unknown>;
}
