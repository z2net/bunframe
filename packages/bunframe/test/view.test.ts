//! Tests for the page-side shim against a mocked window: the
//! bootstrap surface (__bffiCall / __bfOn) records calls and
//! settles programmatically, so every path (unwrap, error
//! envelope, timeout, NO_BRIDGE, send, on) runs headless.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defineSchema, s } from "@z2net/bunframe/schema";

import { defineRPC, RpcError } from "#view";

const rpcDef = defineSchema({
  bun: {
    requests: {
      greet: {
        params: s.object({ name: s.string() }),
        response: s.object({ message: s.string() }),
      },
    },
    messages: { tick: { payload: s.number() } },
  },
  view: {
    messages: { ready: { payload: s.object({ title: s.string() }) } },
  },
});
type Rpc = typeof rpcDef;

interface Deferred {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const calls: Array<{ method: string; args: unknown }> = [];
const pending = new Map<number, Deferred>();
const listeners = new Set<(frame: unknown) => void>();
let buffer: unknown[] = [];
let seq = 0;

const g = globalThis as Omit<typeof globalThis, "window"> & {
  window?: unknown;
};

function installWindow(): void {
  g.window = {
    ipc: { postMessage: () => undefined },
    __bffiCall: (method: string, args: unknown) => {
      calls.push({ method, args });
      const id = seq++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    __bfOn: (handler: (frame: unknown) => void) => {
      listeners.add(handler);
      for (const frame of buffer) handler(frame);
      buffer = [];
      return () => listeners.delete(handler);
    },
  };
}

function deferredOf(id: number): Deferred {
  const deferred = pending.get(id);
  if (deferred === undefined) throw new Error(`no pending call #${id}`);
  return deferred;
}

function dispatch(frame: unknown): void {
  for (const listener of listeners) listener(frame);
}

function okReply(result: unknown): unknown {
  return { v: 1, id: "w", ok: true, result };
}

function failReply(code: string, message: string): unknown {
  return { v: 1, id: "w", ok: false, error: { code, message } };
}

beforeEach(() => {
  calls.length = 0;
  pending.clear();
  listeners.clear();
  buffer = [];
  seq = 0;
  installWindow();
});

afterEach(() => {
  g.window = undefined;
});

describe("request", () => {
  test("unwraps a successful reply envelope", async () => {
    const rpc = defineRPC<Rpc>();
    const promise = rpc.request.greet({ name: "world" });

    expect(calls).toEqual([{ method: "greet", args: { name: "world" } }]);

    deferredOf(0).resolve(okReply({ message: "hi" }));
    expect(await promise).toEqual({ message: "hi" });
  });

  test("throws RpcError with the envelope code and message", async () => {
    const rpc = defineRPC<Rpc>();
    const promise = rpc.request.greet({ name: "world" });

    deferredOf(0).resolve(failReply("VALIDATION", "bad name"));
    const error = await promise.then(
      () => undefined,
      (reason) => reason,
    );

    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("VALIDATION");
    expect((error as RpcError).message).toBe("bad name");
  });

  test("rejects with TIMEOUT and leaves the call pending", async () => {
    const rpc = defineRPC<Rpc>({ maxRequestTime: 10 });
    const promise = rpc.request.greet({ name: "x" });

    await expect(promise).rejects.toBeInstanceOf(RpcError);
    await expect(
      promise.catch((reason: unknown) => (reason as RpcError).code),
    ).resolves.toBe("TIMEOUT");

    deferredOf(0).resolve(okReply({}));
  });

  test("NO_BRIDGE when ipc.postMessage is missing", async () => {
    g.window = {
      __bffiCall: () => Promise.resolve(okReply(null)),
      __bfOn: () => () => undefined,
    };
    await expect(
      defineRPC<Rpc>().request.greet({ name: "x" }),
    ).rejects.toMatchObject({ code: "NO_BRIDGE" });
  });

  test("NO_BRIDGE when the bootstrap is not injected yet", async () => {
    g.window = { ipc: { postMessage: () => undefined } };
    await expect(
      defineRPC<Rpc>().request.greet({ name: "x" }),
    ).rejects.toMatchObject({ code: "NO_BRIDGE" });
  });

  test("NO_BRIDGE when there is no window at all", async () => {
    g.window = undefined;
    await expect(
      defineRPC<Rpc>().request.greet({ name: "x" }),
    ).rejects.toMatchObject({ code: "NO_BRIDGE" });
  });
});

describe("send", () => {
  test("posts the payload and ignores the outcome", async () => {
    const rpc = defineRPC<Rpc>();
    expect(rpc.send.ready({ title: "t" })).toBeUndefined();

    expect(calls).toEqual([{ method: "ready", args: { title: "t" } }]);

    deferredOf(0).resolve(failReply("VALIDATION", "ignored"));
  });

  test("throws NO_BRIDGE synchronously outside bunframe", () => {
    g.window = undefined;
    expect(() => defineRPC<Rpc>().send.ready({ title: "t" })).toThrow(RpcError);
  });
});

describe("on", () => {
  test("filters by method and kind, and unsubscribes", () => {
    const rpc = defineRPC<Rpc>();
    const seen: number[] = [];
    const unsubscribe = rpc.on.tick((payload) => {
      seen.push(payload);
    });

    dispatch({ v: 1, kind: "msg", method: "tick", args: 5 });
    dispatch({ v: 1, kind: "msg", method: "other", args: 9 });
    dispatch({ v: 1, kind: "req", method: "tick", args: 9 });
    expect(seen).toEqual([5]);

    unsubscribe();
    dispatch({ v: 1, kind: "msg", method: "tick", args: 7 });
    expect(seen).toEqual([5]);
  });

  test("delivers frames buffered before the subscription", () => {
    buffer.push({ v: 1, kind: "msg", method: "tick", args: 1 });

    const seen: number[] = [];
    defineRPC<Rpc>().on.tick((payload) => {
      seen.push(payload);
    });

    expect(seen).toEqual([1]);
  });

  test("NO_BRIDGE outside bunframe", () => {
    g.window = undefined;
    expect(() => defineRPC<Rpc>().on.tick(() => undefined)).toThrow(RpcError);
  });
});
