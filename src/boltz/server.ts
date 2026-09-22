/**
 * The gRPC server: every method of `boltzrpc.Boltz` is registered, each
 * call authenticated first (auth.ts), the served ones dispatched to the
 * BoltzService and the rest answered UNIMPLEMENTED with the reason.
 */

import * as grpc from '@grpc/grpc-js';
import { RouxLog, noopLog } from '../types';
import { RpcAuth } from './auth';
import { boltzServiceDefinition } from './proto';
import {
	BoltzService,
	ICallContext,
	RpcError,
	UNIMPLEMENTED_RPCS,
	toRpcError
} from './service';

type Unary = (
	request: never,
	ctx: ICallContext,
	call: grpc.ServerUnaryCall<unknown, unknown>
) => Promise<unknown>;

function unaryHandlers(service: BoltzService): Record<string, Unary> {
	const cancelled = (
		call: grpc.ServerUnaryCall<unknown, unknown>
	): Promise<void> =>
		new Promise((resolve) => call.on('cancelled', () => resolve()));
	return {
		GetInfo: () => service.getInfo(),
		GetServiceInfo: () => service.getServiceInfo(),
		GetPairInfo: (req) => service.getPairInfo(req),
		GetPairs: () => service.getPairs(),
		GetSwapQuote: (req) => service.getSwapQuote(req),
		ListSwaps: (req, ctx) => service.listSwaps(req, ctx),
		GetStats: (req) => service.getStats(req),
		GetSwapInfo: (req, ctx) => service.getSwapInfo(req, ctx),
		CreateSwap: (req) => service.createSwap(req),
		CreateReverseSwap: (req, _ctx, call) =>
			service.createReverseSwap(req, cancelled(call)),
		RefundSwap: (req, ctx) => service.refundSwap(req, ctx),
		Stop: async (): Promise<object> => {
			service.stop();
			return {};
		}
	};
}

function statusOf(err: RpcError): Partial<grpc.StatusObject> {
	return { code: err.code, details: err.message };
}

/** The handler map for `server.addService(boltzServiceDefinition(), ...)`. */
export function boltzServiceImplementation(
	service: BoltzService,
	auth: RpcAuth,
	log: RouxLog = noopLog
): grpc.UntypedServiceImplementation {
	const unary = unaryHandlers(service);
	const implementation: grpc.UntypedServiceImplementation = {};
	for (const [name, method] of Object.entries(boltzServiceDefinition())) {
		const fail = (err: unknown): Partial<grpc.StatusObject> => {
			const rpc = toRpcError(err);
			log('boltz_rpc_failed', {
				method: name,
				code: rpc.code,
				error: rpc.message
			});
			return statusOf(rpc);
		};
		if (method.responseStream) {
			implementation[name] = (
				call: grpc.ServerWritableStream<unknown, unknown>
			): void => {
				const denied = auth.check(name, call.metadata);
				if (denied) {
					call.emit('error', denied);
					return;
				}
				const ctx: ICallContext = {
					permission: auth.permission(call.metadata)!
				};
				let off: (() => void) | null = null;
				let closed = false;
				const end = (): void => {
					if (closed) return;
					closed = true;
					off?.();
					call.end();
				};
				call.on('cancelled', () => {
					closed = true;
					off?.();
				});
				service
					.streamSwapInfo(
						call.request as never,
						(info) => {
							if (!closed) call.write(info);
						},
						end,
						ctx
					)
					.then((unsubscribe) => {
						off = unsubscribe;
						if (closed) unsubscribe();
					})
					.catch((err) => {
						closed = true;
						call.emit('error', fail(err));
					});
			};
			continue;
		}
		implementation[name] = (
			call: grpc.ServerUnaryCall<unknown, unknown>,
			callback: grpc.sendUnaryData<unknown>
		): void => {
			const denied = auth.check(name, call.metadata);
			if (denied) {
				callback(denied, null);
				return;
			}
			const handler = unary[name];
			if (!handler) {
				callback(
					{
						code: grpc.status.UNIMPLEMENTED,
						details: `roux-boltzd does not implement ${name}: ${
							UNIMPLEMENTED_RPCS[name] ?? 'not supported'
						}`
					},
					null
				);
				return;
			}
			const ctx: ICallContext = { permission: auth.permission(call.metadata)! };
			handler(call.request as never, ctx, call).then(
				(response) => callback(null, response),
				(err) => callback(fail(err), null)
			);
		};
	}
	return implementation;
}

export interface IBoltzServerOptions {
	service: BoltzService;
	auth: RpcAuth;
	host: string;
	port: number;
	credentials: grpc.ServerCredentials;
	log?: RouxLog;
}

export interface IBoltzServer {
	/** The port bound (useful when 0 was asked for). */
	port: number;
	/** Stop accepting calls; in-flight calls get a moment, then are cut. */
	close(graceMs?: number): Promise<void>;
}

export async function startBoltzServer(
	options: IBoltzServerOptions
): Promise<IBoltzServer> {
	const server = new grpc.Server();
	server.addService(
		boltzServiceDefinition(),
		boltzServiceImplementation(options.service, options.auth, options.log)
	);
	const address = options.host.includes(':')
		? `[${options.host.replace(/^\[|\]$/g, '')}]:${options.port}`
		: `${options.host}:${options.port}`;
	const port = await new Promise<number>((resolve, reject) =>
		server.bindAsync(address, options.credentials, (err, bound) =>
			err ? reject(err) : resolve(bound)
		)
	);
	return {
		port,
		close: (graceMs = 2_000): Promise<void> =>
			new Promise((resolve) => {
				const force = setTimeout(() => {
					server.forceShutdown();
					resolve();
				}, graceMs);
				force.unref?.();
				server.tryShutdown(() => {
					clearTimeout(force);
					resolve();
				});
			})
	};
}
