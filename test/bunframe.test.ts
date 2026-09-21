/**
 * End-to-end test of the FULL `@z2net/bffi` pipeline on the
 * bunframe core: ONE call - cargo build -> loader JSON -> api.gen
 * generation -> binary resolution -> dlopen - then the real thing:
 * windows on the dedicated native thread, the events stream (pulled
 * through the raw stream ABI), the window command set, the query
 * ops, the close VETO round trip (a simulated title-bar X), the
 * IPC bridge (envelope, asset protocol, pipelining).
 *
 * WINDOWED BY DESIGN: it opens real OS windows, so it is
 * ENV-GATED - skipped entirely unless `BFFI_E2E=1`:
 *
 *   cargo build --release
 *   BFFI_E2E=1 bun test    # PowerShell: $env:BFFI_E2E = "1"
 *
 * (The WebView2 runtime must be installed on Windows.) The Rust
 * unit tests of the core (`cargo test`) cover the no-window logic
 * and always run.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JSCallback, type Pointer, dlopen, ptr } from "bun:ffi";

import { createApp } from "@z2net/bunframe";
import { rpc as integrationRpc } from "./integration/schema.ts";
import {
  TAG_STR,
  TAG_UNIT,
  type FfiLib,
  bffi,
  buildDeclarations,
  decodeAt,
  findProjectRoot,
  loadConfigFile,
  localArtifactPath,
  makeReadBuffer,
  pumpUntil,
  setJsThread,
  bindJsCallback,
  type CbValue,
} from "@z2net/bffi";
import { moduleJson, type Api } from "../.bffi/api.gen.ts";

const E2E = process.env.BFFI_E2E === "1";
const maybeTest = test.skipIf(!E2E);

const found = await findProjectRoot(import.meta.dir);
if (found === undefined) {
  throw new Error(".bffi/bffi.json not found above the test");
}
const ROOT = found;
const CONFIG = await loadConfigFile(ROOT);

const RAW = {
  bffi_stream_next: { args: ["u64", "u32", "ptr"], returns: "u32" },
  bffi_stream_drop: { args: ["u64"], returns: "u32" },
  bffi_buffer: { args: ["u64"], returns: "ptr" },
  bffi_buffer_length: { args: ["u64"], returns: "u64" },
  bffi_types_free: { args: ["u64"], returns: "void" },
  bffi_callback_bind: {
    args: ["u8", "ptr", "u64", "u64", "ptr"],
    returns: "u32",
  },
  bffi_callback_revoke: { args: ["u64"], returns: "u32" },
  bffi_test_close_requested: { args: ["u64"], returns: "u32" },
} as const;

let api: Api;
let raw: FfiLib;
let readBuffer: (handle: bigint) => Uint8Array;
let closeRequest: (handle: bigint) => unknown;

/** A raw symbol with a guard (the FfiLib typing unions the table,
 * so every access would otherwise be possibly-undefined). */
function sym(name: keyof typeof RAW): (...args: unknown[]) => unknown {
  const symbol = (raw as Record<string, unknown>)[name];
  if (typeof symbol !== "function") {
    throw new Error(`the ${name} export is missing`);
  }
  return symbol as (...args: unknown[]) => unknown;
}

function streamNext(handle: bigint, max: number, out: Pointer): number {
  return Number(sym("bffi_stream_next")(handle, max, out));
}

/** A minimal config with every field the typed RecordShape demands
 * (`null` rides the wire as the absent field). */
function config(
  overrides: Partial<Record<string, CbValue | null>>,
): Parameters<Api["window_open"]>[0] {
  return {
    url: null,
    html: null,
    title: null,
    width: null,
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
    ...overrides,
  } as Parameters<Api["window_open"]>[0];
}

/** The page->native request envelope posted by the IPC bootstrap. */
type IpcRequest = {
  v: 1;
  id: string;
  kind: "req";
  method: string;
  args: Record<string, unknown>;
};

/** The ok-reply envelope for a request (routes back by id). */
function ipcReply(request: IpcRequest, result: unknown): string {
  return JSON.stringify({ v: 1, id: request.id, ok: true, result });
}

/** Binds a `unit(string)` JS callback through the raw ABI and
 * returns its handle plus a closer (revoke + free). The shared
 * shape of every ipc binding in this file. */
function bindUnitStrCallback(
  onMessage: (body: string) => void,
): { handle: bigint; close: () => void } {
  const handler = new JSCallback(onMessage, { args: ["cstring"], returns: "void" });
  if (handler.ptr === null) {
    throw new Error("bun:ffi produced a null JSCallback pointer");
  }
  const sig = new Uint8Array([TAG_UNIT, TAG_STR]);
  const bindOut = new BigUint64Array(1);
  const bindStatus = sym("bffi_callback_bind")(
    sig[0],
    ptr(sig.subarray(1)),
    sig.length - 1,
    BigInt(handler.ptr),
    bindOut,
  );
  if (bindStatus !== 0) {
    handler.close();
    throw new Error(`bffi_callback_bind failed with status ${bindStatus}`);
  }
  const handle = bindOut[0] ?? 0n;
  return {
    handle,
    close: () => {
      sym("bffi_callback_revoke")(handle);
      handler.close();
    },
  };
}

/** Polls a sync native query until it turns true (the OS applies
 * maximize/restore state asynchronously). */
async function pollUntilTrue(query: () => boolean, deadlineMs = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!query() && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  expect(query()).toBe(true);
}

/** Pulls up to `max` events off the window's events stream: an
 * array of parsed JSON events, or `"done"` when the stream ended. */
function pullEvents(streamHandle: bigint, max = 16): Array<Record<string, unknown>> | "done" {
  const out = new BigUint64Array(1);
  const status = streamNext(streamHandle, max, ptr(out));
  // 14 = Pending: the buffer is empty right now, more events may
  // come - the caller retries.
  if (status === 14) {
    return [];
  }
  if (status !== 0) {
    throw new Error(`bffi_stream_next failed with status ${status}`);
  }
  const bufferHandle = out[0] ?? 0n;
  if (bufferHandle === 0n) {
    return "done";
  }
  const bytes = readBuffer(bufferHandle);
  const decoded = decodeAt(bytes, 0);
  expect(decoded.value).toBeInstanceOf(Array);
  return (decoded.value as string[]).map((item) => JSON.parse(item));
}

/** Drains the events stream until an event of `type` arrives,
 * returning all drained events. Throws when the event never
 * arrived or the stream ended early. */
async function waitForEvent(
  streamHandle: bigint,
  type: string,
  deadlineMs = 15_000,
): Promise<Array<Record<string, unknown>>> {
  const drained: Array<Record<string, unknown>> = [];
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const pulled = pullEvents(streamHandle);
    if (pulled === "done") {
      break;
    }
    for (const event of pulled) {
      drained.push(event);
      if (event.type === type) {
        return drained;
      }
    }
    api.loop_pump();
    await Bun.sleep(10);
  }
  throw new Error(`the "${type}" event never arrived; drained: ${JSON.stringify(drained)}`);
}

describe("bunframe core e2e", () => {
  maybeTest(
    "the pipeline builds, generates and loads the bunframe module",
    async () => {
      // The pipeline does cargo build -> resolve -> dlopen with the
      // FULL typed declarations.
      api = await bffi({ config: `${ROOT}/.bffi/bffi.json` });
      expect(api).toBeTypeOf("object");
      // A second dlopen for the raw pieces the typed API hides:
      // the stream pulls and the test-only close-request dispatch.
      raw = dlopen(
        localArtifactPath(CONFIG, ROOT),
        buildDeclarations(moduleJson, CONFIG.features ?? {}),
      ).symbols as unknown as FfiLib;
      readBuffer = makeReadBuffer(raw);
      const testLib = dlopen(localArtifactPath(CONFIG, ROOT), {
        bffi_test_close_requested: { args: ["u64"], returns: "u32" },
      });
      closeRequest = testLib.symbols.bffi_test_close_requested;
      setJsThread(raw);
    },
    120_000,
  );

  maybeTest(
    "the window lifecycle feeds the events stream and the shutdown is clean",
    async () => {
      const handle = api.window_open(
        config({
          html: "<!doctype html><html><body><h1>bunframe e2e</h1></body></html>",
          title: "bunframe e2e lifecycle",
          width: 320,
          height: 200,
        }),
      );
      expect(handle).toBeTypeOf("bigint");

      const streamHandle = api.window_events(handle);
      expect(streamHandle).toBeTypeOf("bigint");

      // The command set: each proxies onto the loop thread and must
      // report Ok.
      api.window_set_title(handle, "renamed");
      api.window_set_size(handle, 280, 180);
      api.window_set_resizable(handle, false);
      api.window_set_decorations(handle, true);
      api.window_set_always_on_top(handle, false);
      api.window_set_visible(handle, true);
      api.window_focus(handle);
      api.window_eval(handle, "1 + 1");

      // Creation events arrive on the stream (resized fires at
      // creation; pull and validate the JSON envelope).
      const first = pullEvents(streamHandle);
      if (first === "done") {
        throw new Error("no creation events on the stream");
      }
      for (const event of first) {
        expect(typeof event.type).toBe("string");
      }

      // Close: the closed event completes the stream. The loop
      // thread STAYS alive (one EventLoop per process) - the quit
      // is explicit in the last test.
      api.window_close(handle);
      const drained = await waitForEvent(streamHandle, "closed");
      expect(drained.find((event) => event.type === "closed")).toBeDefined();
    },
    120_000,
  );

  maybeTest(
    "the close veto denies and then allows a simulated title-bar X",
    async () => {
      const vetoes: Array<() => boolean> = [];
      const handle = api.window_open(
        config({
          html: "<!doctype html><html><body>veto e2e</body></html>",
          title: "bunframe e2e veto",
          width: 280,
          height: 160,
        }),
      );
      const streamHandle = api.window_events(handle);

      let allow = false;
      const veto = bindJsCallback(
        raw,
        { ret: "bool", params: ["string"] },
        (...args: CbValue[]) => {
          const body = String(args[0] ?? "");
          expect(JSON.parse(body)).toEqual({ type: "close-requested" });
          return vetoes.at(-1)?.() ?? true;
        },
      );
      api.window_bind_close(handle, veto.handle);

      // Round 1: the veto DENIES - the window survives, a
      // close-denied event is pushed.
      vetoes.push(() => allow);
      closeRequest(handle);
      const denied = await waitForEvent(streamHandle, "close-denied");
      expect(denied.find((event) => event.type === "close-denied")).toBeDefined();
      // The window is still live: commands keep working.
      api.window_set_title(handle, "still here");

      // Round 2: the veto ALLOWS - the window closes, the closed
      // event completes the stream.
      allow = true;
      closeRequest(handle);
      const closed = await waitForEvent(streamHandle, "closed");
      expect(closed.find((event) => event.type === "closed")).toBeDefined();
      veto.revoke();
    },
    120_000,
  );

  maybeTest(
    "the IPC bridge answers the page promise",
    async () => {
      const handle = api.window_open(
        config({
          html: [
            "<!doctype html><html><body>ipc e2e<script>",
            // The bootstrap never rejects: a call posted before the
            // JS side binds stays pending forever, so retry until
            // one call actually settles.
            "(async () => {",
            "  while (true) {",
            "    const winner = await Promise.race([",
            '      window.__bffiCall("ping", {}).then(() => "done"),',
            '      new Promise((r) => setTimeout(() => r("retry"), 100)),',
            "    ]);",
            '    if (winner === "done") { return; }',
            "  }",
            "})();",
            "</script></body></html>",
          ].join("\n"),
          title: "bunframe e2e ipc",
          width: 280,
          height: 160,
        }),
      );

      // The handler MUST NOT throw: every message gets a reply
      // (the id-routed envelope), so the worker always settles the
      // page promise.
      const { promise: answered, resolve: markAnswered } =
        Promise.withResolvers<IpcRequest>();
      const seen: IpcRequest[] = [];
      const ipc = bindUnitStrCallback((body) => {
        const request = JSON.parse(body) as IpcRequest;
        seen.push(request);
        api.window_ipc_reply(handle, ipcReply(request, { pong: true }));
        markAnswered(request);
      });
      api.window_bind_ipc(handle, ipc.handle);

      // Drive the page: the bootstrap posts the envelope; the
      // worker invokes the bound callback while THIS thread pumps.
      api.window_eval(handle, `window.__bffiCall("ping", {})`);
      const deadline = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("the IPC roundtrip never completed")), 15_000);
      });
      await Promise.race([pumpUntil(answered, () => api.loop_pump()), deadline]);

      expect(seen.length).toBeGreaterThan(0);
      const request = await answered;
      expect(request.v).toBe(1);
      expect(request.kind).toBe("req");
      expect(request.method).toBe("ping");
      expect(request.args).toEqual({});
      expect(typeof request.id).toBe("string");

      ipc.close();
      api.window_close(handle);
    },
    120_000,
  );
  maybeTest(
    "the query ops read window state on the loop thread",
    async () => {
      const handle = api.window_open(
        config({
          html: "<!doctype html><html><body>query e2e</body></html>",
          title: "bunframe e2e query",
          width: 320,
          height: 200,
        }),
      );
      const streamHandle = api.window_events(handle);

      // A freshly opened (visible) window reports visible; the
      // webview viewport is real.
      expect(api.window_is_visible(handle)).toBe(true);
      const size = api.window_inner_size(handle);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);

      // The OS applies maximize/restore asynchronously: poll.
      expect(api.window_is_maximized(handle)).toBe(false);
      api.window_maximize(handle);
      await pollUntilTrue(() => api.window_is_maximized(handle));
      api.window_unmaximize(handle);
      await pollUntilTrue(() => !api.window_is_maximized(handle));

      // Logical (10, 20) lands at a non-negative physical position
      // (exact equality is display-scale dependent).
      api.window_set_position(handle, 10, 20);
      const position = api.window_position(handle);
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.y).toBeGreaterThanOrEqual(0);

      api.window_close(handle);
      await waitForEvent(streamHandle, "closed");
    },
    120_000,
  );

  maybeTest(
    "window_center and window_set_min_size apply without error",
    async () => {
      const handle = api.window_open(
        config({
          html: "<!doctype html><html><body>mutate e2e</body></html>",
          title: "bunframe e2e mutate",
          width: 320,
          height: 200,
        }),
      );
      const streamHandle = api.window_events(handle);

      expect(() => api.window_center(handle)).not.toThrow();
      expect(() => api.window_set_min_size(handle, 400, 300)).not.toThrow();
      // 0/0 clears the constraint.
      expect(() => api.window_set_min_size(handle, 0, 0)).not.toThrow();

      api.window_close(handle);
      await waitForEvent(streamHandle, "closed");
    },
    120_000,
  );

  maybeTest(
    "the bf custom protocol serves the asset root to the page",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "bf-assets-"));
      try {
        await writeFile(
          path.join(dir, "index.html"),
          [
            "<!doctype html><html><head>",
            '<script>window.__marker = "bf-asset-ok";</script>',
            '<script src="app.js"></script>',
            "</head><body>assets</body></html>",
          ].join(""),
        );
        await writeFile(path.join(dir, "app.js"), "window.__assetJs = true;\n");

        const handle = api.window_open(
          config({
            url: "bf://localhost/",
            title: "bunframe e2e assets",
            width: 320,
            height: 200,
            asset_root: dir,
          }),
        );
        const streamHandle = api.window_events(handle);

        const { promise: answered, resolve: markAnswered } =
          Promise.withResolvers<Record<string, unknown>>();
        const ipc = bindUnitStrCallback((body) => {
          const request = JSON.parse(body) as IpcRequest;
          if (request.method !== "probe") {
            return;
          }
          api.window_ipc_reply(handle, ipcReply(request, request.args));
          markAnswered(request.args);
        });
        api.window_bind_ipc(handle, ipc.handle);

        // The page may still be loading (a too-early eval is lost):
        // keep firing a probe that waits for BOTH assets to have
        // run before reporting the evidence.
        const probeScript = [
          "(function probe() {",
          "  if (window.__assetJs !== true) { setTimeout(probe, 100); return; }",
          '  window.__bffiCall("probe", { href: location.href, marker: window.__marker, assetJs: window.__assetJs });',
          "})();",
        ].join("\n");
        const fireTimer = setInterval(() => api.window_eval(handle, probeScript), 500);
        api.window_eval(handle, probeScript);
        const deadline = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("the asset probe never completed")), 15_000);
        });
        let evidence: Record<string, unknown>;
        try {
          evidence = await Promise.race([
            pumpUntil(answered, () => api.loop_pump()),
            deadline,
          ]);
        } finally {
          clearInterval(fireTimer);
        }

        // href carries the bf custom-protocol origin; the inline
        // script AND the subresource both ran.
        expect(String(evidence.href)).toContain("bf");
        expect(evidence.marker).toBe("bf-asset-ok");
        expect(evidence.assetJs).toBe(true);

        ipc.close();
        api.window_close(handle);
        await waitForEvent(streamHandle, "closed");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  maybeTest(
    "ipc calls pipeline: two calls in flight, both answered",
    async () => {
      const handle = api.window_open(
        config({
          html: "<!doctype html><html><body>pipeline e2e</body></html>",
          title: "bunframe e2e pipeline",
          width: 320,
          height: 200,
        }),
      );
      const streamHandle = api.window_events(handle);

      const seen: IpcRequest[] = [];
      const { promise: bothSeen, resolve: markBothSeen } = Promise.withResolvers<void>();
      const ipc = bindUnitStrCallback((body) => {
        const request = JSON.parse(body) as IpcRequest;
        seen.push(request);
        const result = request.method === "slow1" ? "one" : "two";
        api.window_ipc_reply(handle, ipcReply(request, result));
        if (seen.length >= 2) {
          markBothSeen();
        }
      });
      api.window_bind_ipc(handle, ipc.handle);

      // Fire BOTH calls without awaiting between (retry until the
      // page is loaded; the once-guard keeps a late-queued eval
      // from double-firing).
      const fireScript = [
        "if (!window.__bfFired) {",
        "  window.__bfFired = true;",
        '  window.__bffiCall("slow1", { n: 1 });',
        '  window.__bffiCall("slow2", { n: 2 });',
        "}",
      ].join("\n");
      const fireTimer = setInterval(() => {
        if (seen.length === 0) {
          api.window_eval(handle, fireScript);
        }
      }, 500);
      api.window_eval(handle, fireScript);
      const deadline = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("the pipelined calls never both arrived")), 15_000);
      });
      try {
        await Promise.race([pumpUntil(bothSeen, () => api.loop_pump()), deadline]);
      } finally {
        clearInterval(fireTimer);
      }

      expect(seen.length).toBe(2);
      expect(seen.map((request) => request.method).toSorted()).toEqual(["slow1", "slow2"]);
      expect(new Set(seen.map((request) => request.id)).size).toBe(2);

      ipc.close();
      api.window_close(handle);
      await waitForEvent(streamHandle, "closed");
    },
    120_000,
  );

  // The FRAMEWORK integration: createApp + the real core + a page
  // bundled with Bun.build that uses the real @z2net/bunframe-view,
  // served through the bf:// asset protocol - one typed schema
  // (integration/schema.ts) drives both sides. Runs BEFORE the quit
  // test (the loop must still be alive here) and does NOT quit:
  // the closing of its last window resolves run() and leaves the
  // loop to the final quit test.
  maybeTest(
    "the framework stack: createApp + @z2net/bunframe-view over bf://",
    async () => {
      const assetDir = await mkdtemp(path.join(os.tmpdir(), "bunframe-it-"));
      try {
        await Bun.build({
          entrypoints: [path.join(import.meta.dir, "integration/page.ts")],
          outdir: assetDir,
          target: "browser",
        });
        await copyFile(
          path.join(import.meta.dir, "integration/index.html"),
          path.join(assetDir, "index.html"),
        );

        const collected: { greet?: unknown; ready?: unknown; tick?: unknown } = {};
        const app = createApp({
          rpc: integrationRpc,
          window: {
            title: "bunframe-integration",
            width: 640,
            height: 480,
            asset_root: assetDir,
            url: "bf://localhost/index.html",
          },
        });
        app.handle("probe", () => ({}));
        app.handle("greet", ({ name }) => ({ message: `Hello, ${name}!` }));
        app.on("ready", (payload) => {
          collected.ready = payload;
        });
        app.on("result", (payload) => {
          if (payload.greet !== undefined) collected.greet = payload.greet;
          if (payload.tick !== undefined) collected.tick = payload.tick;
        });

        const runPromise = app.run();
        const deadline = Date.now() + 20_000;
        while (
          (collected.greet === undefined || collected.ready === undefined) &&
          Date.now() < deadline
        ) {
          await Bun.sleep(25);
        }
        expect(collected.greet).toEqual({ message: "Hello, bunframe!" });
        expect(collected.ready).toEqual({ title: "bunframe-integration" });

        // Bun -> page message, received by the page's view.on and
        // reported back through a request (both directions proven).
        app.send("tick", { n: 1 });
        const tickDeadline = Date.now() + 10_000;
        while (collected.tick === undefined && Date.now() < tickDeadline) {
          await Bun.sleep(25);
        }
        expect(collected.tick).toEqual({ n: 1 });

        // Electron-style run(): closing the last window resolves it.
        app.window?.close();
        await runPromise;
      } finally {
        await rm(assetDir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  maybeTest(
    "app_quit stops the loop and flips the sticky exit flag",
    () => {
      expect(api.window_poll_exit()).toBeFalse();
      api.app_quit();
      const deadline = Date.now() + 10_000;
      while (!api.window_poll_exit() && Date.now() < deadline) {
        api.loop_pump();
        Bun.sleepSync(20);
      }
      expect(api.window_poll_exit()).toBeTrue();
    },
    60_000,
  );
  afterAll(() => {
    // Ungated runs never constructed the api - nothing to await.
    if (api === undefined) {
      return;
    }
    const exitDeadline = Date.now() + 10_000;
    while (!api.window_poll_exit() && Date.now() < exitDeadline) {
      Bun.sleepSync(20);
    }
  });
});
