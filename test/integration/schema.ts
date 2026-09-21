//! The shared RPC schema of the integration e2e: ONE runtime
//! definition both sides compile against (the bun side validates
//! through it, the page side types through it).
import { defineSchema, s } from "@z2net/bunframe/schema";

export const rpc = defineSchema({
  bun: {
    requests: {
      // The bind barrier: the page probes until the backend ipc
      // callback is bound (bootstrap v2 drops pre-bind posts, the
      // view's maxRequestTime turns the silence into a retry).
      probe: { params: s.object({}), response: s.object({}) },
      greet: {
        params: s.object({ name: s.string() }),
        response: s.object({ message: s.string() }),
      },
    },
    messages: {
      tick: { payload: s.object({ n: s.number() }) },
    },
  },
  view: {
    messages: {
      ready: { payload: s.object({ title: s.string() }) },
      result: { payload: s.record(s.unknown()) },
    },
  },
});

export type AppRpc = typeof rpc;
