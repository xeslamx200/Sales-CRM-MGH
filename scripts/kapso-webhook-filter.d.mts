import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
export const ALLOWED_PATH: string;
export const MAX_BODY_BYTES: number;
export const FORWARDED_HEADERS: string[];
export function createFilter(opts?: { upstreamPort?: number; upstreamTimeoutMs?: number; log?: (line: string) => void }): Server;
export function listenLoopback(server: Server, port?: number): Promise<AddressInfo | string | null>;
