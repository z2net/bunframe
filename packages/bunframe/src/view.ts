//! @z2net/bunframe-view - the page-side RPC shim over the bootstrap the
//! native core injects into every page. The schema definition is
//! TYPES ONLY: the page never validates (the bun side always does)
//! - a deliberate trust decision that keeps this package
//! dependency-free.

// oxlint-disable no-underscore-dangle -- the __bffiCall / __bfOn
// names are the frozen bootstrap contract, not a style choice.

import type {
  InferMessagePayload,
  InferRequestArgs,
  InferRequestResult,
  MessageFrame,
  ReplyFrame,
  RpcDef,
} from "#schema";

/** A call failed before or during the round trip. */
export class RpcError extends Error {
  /** Machine code: `NO_BRIDGE` / `TIMEOUT` are raised locally; a
   * failed reply forwards its own code (`VALIDATION`, `NOT_FOUND`,
   * `HANDLER`, `NATIVE`, ...). */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** The bootstrap injected into the page by the native core
 * (bootstrap v2). */
interface Bootstrap {
  __bffiCall(method: string, args: unknown): Promise<ReplyFrame>;
  /** evt frames (page -> bun messages); absent on cores older than
   * the evt bootstrap - send() falls back to a req round trip. */
  __bffiEvent?(method: string, args: unknown): Promise<ReplyFrame>;
  __bfOn(handler: (frame: MessageFrame) => void): () => void;
}

/** The page's window as bunframe sees it: the raw WebView host
 * bridge plus the bootstrap (injected shortly after load). */
interface HostWindow {
  readonly ipc?: { readonly postMessage?: unknown } | undefined;
  readonly __bffiCall?: Bootstrap["__bffiCall"] | undefined;
  readonly __bffiEvent?: Bootstrap["__bffiEvent"] | undefined;
  readonly __bfOn?: Bootstrap["__bfOn"] | undefined;
}

/** The window, read defensively - the shim also loads in plain
 * browsers and in tests with no window at all. */
function host(): HostWindow | undefined {
  return (globalThis as { readonly window?: HostWindow | undefined }).window;
}

/** The bootstrap, or NO_BRIDGE when the page is not running inside
 * bunframe (or the bootstrap has not been injected yet). */
function bridge(): Bootstrap {
  const w = host();
  if (
    w === undefined ||
    typeof w.__bffiCall !== "function" ||
    typeof w.__bfOn !== "function" ||
    typeof w.ipc?.postMessage !== "function"
  ) {
    throw new RpcError(
      "NO_BRIDGE",
      "this page is not running inside bunframe (or the bootstrap has not been injected yet)",
    );
  }
  return {
    __bffiCall: w.__bffiCall,
    __bffiEvent: typeof w.__bffiEvent === "function" ? w.__bffiEvent : undefined,
    __bfOn: w.__bfOn,
  };
}

/** Swallows the late settle of a raced-out call - the rejection is
 * already surfaced through the timeout. */
function ignore(_error: unknown): void {
  void _error;
}

/** One request with a local timeout applied. The native round trip
 * itself cannot be cancelled: the underlying promise stays pending
 * and its eventual settle is ignored. */
function withTimeout(
  call: Promise<ReplyFrame>,
  maxRequestTime: number,
): Promise<ReplyFrame> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RpcError("TIMEOUT", `no reply within ${maxRequestTime}ms`)),
      maxRequestTime,
    );
  });
  call.catch(ignore);
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

/** One full round trip: unwrap a successful reply, rethrow a
 * failed one as RpcError. `asEvent` posts a `kind: "evt"` frame
 * through `__bffiEvent` when the core ships it (the bun side
 * dispatches it to the message listeners); older cores fall back
 * to a req round trip. */
async function roundTrip(
  bridgeFn: Bootstrap,
  method: string,
  args: unknown,
  maxRequestTime: number | undefined,
  asEvent = false,
): Promise<unknown> {
  const post =
    asEvent && bridgeFn.__bffiEvent !== undefined
      ? bridgeFn.__bffiEvent(method, args)
      : bridgeFn.__bffiCall(method, args);
  let call = post;
  if (maxRequestTime !== undefined) call = withTimeout(call, maxRequestTime);
  const frame = await call;
  if (frame.ok) return frame.result;
  throw new RpcError(frame.error.code, frame.error.message);
}

/** Options for `defineRPC`. */
export interface RpcOptions {
  /** Reject a request locally (RpcError `TIMEOUT`) after this many
   * ms without a reply. Default: no timeout. */
  maxRequestTime?: number;
}

type BunOf<D extends RpcDef> = NonNullable<D["bun"]>;
type RequestsOf<D extends RpcDef> = NonNullable<BunOf<D>["requests"]>;
type ViewMessagesOf<D extends RpcDef> = NonNullable<D["view"]>["messages"];
type BunMessagesOf<D extends RpcDef> = NonNullable<BunOf<D>["messages"]>;

/** `rpc.request.<method>` - one entry per `bun.requests` method. */
export type RequestClient<D extends RpcDef> = {
  [M in keyof RequestsOf<D>]: (
    args: InferRequestArgs<RequestsOf<D>[M]>,
  ) => Promise<InferRequestResult<RequestsOf<D>[M]>>;
};

/** `rpc.send.<method>` - one entry per `view.messages` method. */
export type SendClient<D extends RpcDef> = {
  [M in keyof ViewMessagesOf<D>]: (
    payload: InferMessagePayload<ViewMessagesOf<D>[M]>,
  ) => void;
};

/** `rpc.on.<method>` - one entry per `bun.messages` method. */
export type OnClient<D extends RpcDef> = {
  [M in keyof BunMessagesOf<D>]: (
    handler: (payload: InferMessagePayload<BunMessagesOf<D>[M]>) => void,
  ) => () => void;
};

/** The typed page-side RPC surface. */
export interface RpcClient<D extends RpcDef> {
  request: RequestClient<D>;
  send: SendClient<D>;
  on: OnClient<D>;
}

/**
 * The page-side RPC for a shared schema definition. The definition
 * is types only, so the method objects are resolved through a
 * Proxy at call time - nothing from the schema ships in the page
 * bundle.
 *
 * - `rpc.request.m(args)` - awaited; the bun side answers.
 * - `rpc.send.m(payload)` - fire and forget; still costs one full
 *   round trip on the bridge in v0.1.0 (framed as a `kind: "evt"`
 *   message, acked by the bun side; the outcome is ignored).
 * - `rpc.on.m(handler)` - bun -> page messages; payloads are NOT
 *   validated on the page.
 */
export function defineRPC<D extends RpcDef>(options?: RpcOptions): RpcClient<D> {
  const maxRequestTime = options?.maxRequestTime;

  return {
    request: new Proxy({} as RequestClient<D>, {
      get(_target, method) {
        if (typeof method !== "string") return undefined;
        return async (args: unknown) => roundTrip(bridge(), method, args, maxRequestTime);
      },
    }),
    send: new Proxy({} as SendClient<D>, {
      get(_target, method) {
        if (typeof method !== "string") return undefined;
        return (payload: unknown): void => {
          roundTrip(bridge(), method, payload, undefined, true).catch(ignore);
        };
      },
    }),
    on: new Proxy({} as OnClient<D>, {
      get(_target, method) {
        if (typeof method !== "string") return undefined;
        return (handler: (payload: unknown) => void): (() => void) => {
          return bridge().__bfOn((frame) => {
            if (frame.kind === "msg" && frame.method === method) {
              handler(frame.args);
            }
          });
        };
      },
    }),
  };
}
