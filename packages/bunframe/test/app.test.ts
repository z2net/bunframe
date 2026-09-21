/**
 * Unit tests of @z2net/bunframe-app over a RECORDING fake core - hermetic
 * by contract: no dlopen, no windows, no native state. The fake raw
 * table carries just enough for the callback bind and an
 * immediately-exhausted events stream.
 */
import { describe, expect, test } from "bun:test";
import type { BunframeCore } from "#core";
import type { FfiLib } from "@z2net/bffi";
import type { Api } from "#core/api.gen.ts";
import { defineSchema, s } from "@z2net/bunframe/schema";

import {
  createApp,
  createIpcHandler,
  validateArgs,
  type IpcState,
} from "@z2net/bunframe";

/** A recording api + a minimal raw table. `pollExit` controls the
 * run loop's exit probe. */
function makeFakeCore(pollExit = true): {
  core: BunframeCore;
  calls: Array<[method: string, args: unknown[]]>;
} {
  const calls: Array<[string, unknown[]]> = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push([method, args]);
  };
  const api = {
    window_open: (config: unknown) => {
      calls.push(["window_open", [config]]);
      return 1n;
    },
    window_events: (handle: unknown) => {
      calls.push(["window_events", [handle]]);
      return 100n;
    },
    window_close: record("window_close"),
    window_eval: record("window_eval"),
    window_set_title: record("window_set_title"),
    window_set_size: record("window_set_size"),
    window_set_resizable: record("window_set_resizable"),
    window_set_decorations: record("window_set_decorations"),
    window_set_always_on_top: record("window_set_always_on_top"),
    window_set_visible: record("window_set_visible"),
    window_focus: record("window_focus"),
    window_maximize: record("window_maximize"),
    window_unmaximize: record("window_unmaximize"),
    window_minimize: record("window_minimize"),
    window_open_devtools: record("window_open_devtools"),
    window_bind_ipc: record("window_bind_ipc"),
    window_ipc_reply: record("window_ipc_reply"),
    window_bind_close: record("window_bind_close"),
    window_poll_exit: () => {
      calls.push(["window_poll_exit", []]);
      return pollExit;
    },
    app_quit: record("app_quit"),
    loop_pump: record("loop_pump"),
  } as unknown as Api;
  const raw = {
    bffi_callback_bind: (
      _tag: unknown,
      _ptr: unknown,
      _len: unknown,
      _fn: unknown,
      out: BigUint64Array,
    ) => {
      out[0] = 77n;
      return 0;
    },
    bffi_callback_revoke: () => 0,
    bffi_stream_next: (_handle: unknown, _max: unknown, out: BigUint64Array) => {
      out[0] = 0n;
      return 0;
    },
    bffi_stream_drop: () => 0,
    bffi_buffer: () => 0,
    bffi_buffer_length: () => 0n,
    bffi_types_free: () => 0,
  } as unknown as FfiLib;
  return { core: { api, raw } as BunframeCore, calls };
}

const rpc = defineSchema({
  bun: {
    requests: {
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
      status: { payload: s.object({ ok: s.boolean() }) },
    },
  },
});

function freshState(): IpcState {
  return { requests: new Map(), events: new Map() };
}

function greetState(): IpcState {
  const state = freshState();
  const def = rpc.bun.requests.greet;
  state.requests.set("greet", {
    def,
    handler: (args) => ({ message: `Hello, ${(args as { name: string }).name}` }),
  });
  return state;
}

describe("createIpcHandler", () => {
  test("the happy path validates, strips unknown keys and answers the envelope", () => {
    const handle = createIpcHandler(greetState());
    const reply = JSON.parse(
      handle(
        JSON.stringify({
          v: 1,
          id: "r1",
          kind: "req",
          method: "greet",
          args: { name: "world", extra: true },
        }),
      ),
    );
    expect(reply).toEqual({
      v: 1,
      id: "r1",
      ok: true,
      result: { message: "Hello, world" },
    });
  });

  test("invalid args answer a VALIDATION envelope with the issue path", () => {
    const handle = createIpcHandler(greetState());
    const reply = JSON.parse(
      handle(
        JSON.stringify({
          v: 1,
          id: "r2",
          kind: "req",
          method: "greet",
          args: { name: 42 },
        }),
      ),
    );
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("VALIDATION");
    expect(reply.error.message).toContain("name");
  });

  test("an async validator is a VALIDATION error, never awaited", () => {
    const state = freshState();
    state.requests.set("slow", {
      def: {
        params: {
          "~standard": {
            version: 1,
            vendor: "test",
            validate: (value: unknown) => Promise.resolve({ value }),
          },
        },
        response: { "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) } },
      },
      handler: () => "never",
    });
    const reply = JSON.parse(
      createIpcHandler(state)(
        JSON.stringify({ v: 1, id: "r3", kind: "req", method: "slow", args: {} }),
      ),
    );
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("VALIDATION");
    expect(reply.error.message).toContain("async validators");
  });

  test("an unknown method answers NOT_FOUND", () => {
    const reply = JSON.parse(
      createIpcHandler(greetState())(
        JSON.stringify({ v: 1, id: "r4", kind: "req", method: "nope", args: {} }),
      ),
    );
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("NOT_FOUND");
    expect(reply.id).toBe("r4");
  });

  test("a throwing handler answers a HANDLER envelope with the message", () => {
    const state = freshState();
    const def = rpc.bun.requests.greet;
    state.requests.set("greet", {
      def,
      handler: () => {
        throw new Error("boom");
      },
    });
    const reply = JSON.parse(
      createIpcHandler(state)(
        JSON.stringify({ v: 1, id: "r5", kind: "req", method: "greet", args: { name: "x" } }),
      ),
    );
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("HANDLER");
    expect(reply.error.message).toBe("boom");
  });

  test("a failing response schema answers VALIDATION on the response", () => {
    const state = freshState();
    state.requests.set("greet", {
      def: rpc.bun.requests.greet,
      handler: () => ({ message: 1 }),
    });
    const reply = JSON.parse(
      createIpcHandler(state)(
        JSON.stringify({ v: 1, id: "r6", kind: "req", method: "greet", args: { name: "x" } }),
      ),
    );
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("VALIDATION");
    expect(reply.error.message).toContain("response");
  });

  test("garbage frames answer a BAD_FRAME envelope with an empty id", () => {
    const handle = createIpcHandler(greetState());
    for (const raw of ["not json", "", "null", "42", '{"v":2,"id":"x"}']) {
      const reply = JSON.parse(handle(raw));
      expect(reply.ok).toBe(false);
      expect(reply.error.code).toBe("BAD_FRAME");
      // A frame that is not a v1 envelope gets no id echo.
      expect(reply.id).toBe("");
    }
  });

  test("unknown frame kinds answer BAD_FRAME", () => {
    const reply = JSON.parse(
      createIpcHandler(greetState())(
        JSON.stringify({ v: 1, id: "r7", kind: "wat", method: "greet", args: {} }),
      ),
    );
    expect(reply.error.code).toBe("BAD_FRAME");
    expect(reply.id).toBe("r7");
  });

  test("evt frames dispatch validated payloads and drop invalid ones", () => {
    const state = freshState();
    const seen: unknown[] = [];
    state.events.set("status", {
      schema: rpc.view.messages.status.payload,
      listeners: new Set([(payload: unknown) => seen.push(payload)]),
    });
    const handle = createIpcHandler(state);

    const ok = JSON.parse(
      handle(
        JSON.stringify({ v: 1, id: "e1", kind: "evt", method: "status", args: { ok: true } }),
      ),
    );
    expect(ok).toEqual({ v: 1, id: "e1", ok: true, result: null });
    expect(seen).toEqual([{ ok: true }]);

    const dropped = JSON.parse(
      handle(
        JSON.stringify({ v: 1, id: "e2", kind: "evt", method: "status", args: { ok: "yes" } }),
      ),
    );
    expect(dropped.ok).toBe(true);
    expect(seen.length).toBe(1);
  });

  test("evt frames with no listeners still answer ok", () => {
    const reply = JSON.parse(
      createIpcHandler(greetState())(
        JSON.stringify({ v: 1, id: "e3", kind: "evt", method: "nobody", args: {} }),
      ),
    );
    expect(reply).toEqual({ v: 1, id: "e3", ok: true, result: null });
  });
});

describe("validateArgs", () => {
  test("formats issues as path: message", () => {
    const schema = s.object({ user: s.object({ name: s.string() }) });
    const bad = validateArgs(schema, { user: { name: 1 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.message).toContain("user.name");
    }
    const good = validateArgs(schema, { user: { name: "x" } });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value).toEqual({ user: { name: "x" } });
    }
  });
});

describe("createApp", () => {
  test("headless: run() pumps once and returns without opening a window", async () => {
    const { core, calls } = makeFakeCore(true);
    const app = createApp({ core });
    expect(app.window).toBeUndefined();
    await app.run();
    expect(calls.find(([m]) => m === "window_open")).toBeUndefined();
    expect(calls.find(([m]) => m === "loop_pump")).toBeDefined();
    expect(calls.find(([m]) => m === "window_poll_exit")).toBeDefined();
  });

  test("the window config is null-filled for window_open", () => {
    const { core, calls } = makeFakeCore(true);
    createApp({ core, window: { title: "main", width: 640 } });
    const open = calls.find(([m]) => m === "window_open");
    expect(open).toBeDefined();
    expect(open?.[1]?.[0]).toEqual({
      url: null,
      html: null,
      title: "main",
      width: 640,
      height: null,
      min_width: null,
      min_height: null,
      resizable: null,
      decorations: null,
      transparent: null,
      maximized: null,
      visible: null,
      x: null,
      y: null,
      devtools: null,
      skip_taskbar: null,
      always_on_top: null,
      asset_root: null,
    });
  });

  test("handle registers once; a duplicate throws", () => {
    const { core } = makeFakeCore(true);
    const app = createApp({ core, rpc });
    app.handle("greet", ({ name }) => ({ message: `hi ${name}` }));
    expect(() => app.handle("greet", () => ({ message: "x" }))).toThrow(/already registered/);
  });

  test("handle without a definition throws at registration", () => {
    const { core } = makeFakeCore(true);
    const app = createApp({ core });
    expect(() =>
      app.handle("greet", () => ({ message: "x" })),
    ).toThrow(/no request definition/);
  });

  test("send validates the payload and dispatches __bfDispatch to the main window", () => {
    const { core, calls } = makeFakeCore(true);
    const app = createApp({ core, rpc, window: { title: "x" } });
    app.send("tick", { n: 3 });
    const evaled = calls.find(([m]) => m === "window_eval");
    expect(evaled).toBeDefined();
    expect(evaled?.[1]?.[0]).toBe(1n);
    const script = String(evaled?.[1]?.[1]);
    expect(script).toContain("window.__bfDispatch(");
    const frame = JSON.parse(
      script.replace("window.__bfDispatch(", "").replace(/\);$/, ""),
    );
    expect(frame).toEqual({ v: 1, kind: "msg", method: "tick", args: { n: 3 } });
  });

  test("send with an invalid payload throws a ValidationError", () => {
    const { core } = makeFakeCore(true);
    const app = createApp({ core, rpc, window: { title: "x" } });
    expect(() => app.send("tick", { n: "nope" as unknown as number })).toThrow(
      /expected a number/,
    );
  });

  test("send without a main window throws", () => {
    const { core } = makeFakeCore(true);
    const app = createApp({ core, rpc });
    expect(() => app.send("tick", { n: 1 })).toThrow(/main window/);
  });

  test("window commands record native calls and close is wired", () => {
    const { core, calls } = makeFakeCore(true);
    const app = createApp({ core, window: { title: "w" } });
    const win = app.window;
    expect(win?.handle).toBe(1n);
    win?.title("renamed");
    win?.setSize(280, 180);
    win?.focus();
    win?.setVisible(false);
    win?.openDevtools();
    win?.eval("1 + 1");
    win?.close();
    expect(calls.map(([m]) => m)).toContain("window_set_title");
    expect(calls.find(([m]) => m === "window_set_size")?.[1]).toEqual([1n, 280, 180]);
    expect(calls.find(([m]) => m === "window_eval")?.[1]?.[1]).toBe("1 + 1");
    expect(calls.find(([m]) => m === "window_close")).toBeDefined();
  });

  test("quit is terminal: run() after quit() never pumps", async () => {
    const { core, calls } = makeFakeCore(true);
    const app = createApp({ core });
    await app.quit();
    expect(calls.find(([m]) => m === "app_quit")).toBeDefined();
    await app.run();
    expect(calls.find(([m]) => m === "loop_pump")).toBeUndefined();
  });

  test("run() exits on the poll flag even with exitProcessOnLastWindowClosed off", async () => {
    const { core, calls } = makeFakeCore(true);
    const app = createApp({ core, exitProcessOnLastWindowClosed: false });
    await app.run();
    expect(calls.find(([m]) => m === "window_poll_exit")).toBeDefined();
  });

  test("on() subscribes and unsubscribes without throwing", () => {
    const { core } = makeFakeCore(true);
    const app = createApp({ core, rpc });
    const off = app.on("status", () => {});
    off();
    off();
  });
});
