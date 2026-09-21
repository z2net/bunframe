import { defineSchema, s } from "@z2net/bunframe/schema";

/** The ONE typed RPC contract: the backend validates through it,
 * the frontend types through it. */
export const rpc = defineSchema({
  bun: {
    requests: {
      greet: {
        params: s.object({ name: s.string() }),
        response: s.object({ message: s.string() }),
      },
    },
  },
});

export type AppRpc = typeof rpc;
