import "server-only";
import { parseEnv, serverSchemas } from "@/env";
import type { z } from "zod";

type Group = keyof typeof serverSchemas;
type GroupEnv<G extends Group> = z.infer<(typeof serverSchemas)[G]>;

const cache = new Map<Group, unknown>();

/**
 * Server-only variables for one feature group. Throws EnvError naming the
 * missing variables (never values) the first time a misconfigured group is
 * used. The core group is checked at boot by src/instrumentation.ts.
 */
export function serverEnv<G extends Group>(group: G): GroupEnv<G> {
  if (!cache.has(group)) {
    cache.set(group, parseEnv(serverSchemas[group], process.env));
  }
  return cache.get(group) as GroupEnv<G>;
}
