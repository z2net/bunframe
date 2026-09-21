//! `defineSchema`: the typed identity for RPC definitions. It
//! exists so the app author's literal keeps its inferred types
//! (through the `const` generic) while being checked against the
//! `RpcDef` contract - one definition, typed on both sides.

import type { RpcDef } from "./types.ts";

/** Checks an RPC definition against the contract and passes it
 * through untouched. */
export function defineSchema<const T extends RpcDef>(def: T): T {
  return def;
}
