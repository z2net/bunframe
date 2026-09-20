/**
 * End-to-end test of the FULL `@z2net/bffi` pipeline on the
 * bunframe core: ONE call - cargo build -> loader JSON -> api.gen
 * generation -> binary resolution -> dlopen - then the real thing:
 * windows on the dedicated native thread, the events stream (pulled
 * through the raw stream ABI), the window command set, the close
 * VETO round trip (a simulated title-bar X) and the IPC bridge.
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
import { JSCallback, type Pointer, dlopen, ptr } from "bun:ffi";

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
import { createApiFromJson, moduleJson, type Api } from "../.bffi/api.gen.ts";

const E2E = process.env.BFFI_E2E === "1";
const maybeTest = test.skipIf(!E2E);

const found = await findProjectRoot(import.meta.dir);
if (found === undefined) {
  throw new Error(".bffi/bffi.json not found above the test");
}
const ROOT = found;
const CONFIG = await loadConfigFile(ROOT);

const CDYLIB = `E:/@z2net/bunframe/target/release/bunframe_core.${
  process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so"
}`;

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
    ...overrides,
  } as Parameters<Api["window_open"]>[0];
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

/** Awaits `promise` while pumping the loop, with a hard deadline
 * so a broken bridge fails instead of hanging. */
function withPump<T>(promise: Promise<T>, deadlineMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the pump deadline expired")), deadlineMs);
  });
  return Promise.race([pumpUntil(promise, () => api.loop_pump()), deadline]).finally(() => {
    clearTimeout(timer);
  });
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
            // Retry until the JS side binds its ipc callback (the
            // 2s bootstrap reject makes a too-early attempt retry).
            "(async () => {",
            "  while (true) {",
            "    try {",
            '      await window.__bffiCall("ping", {});',
            "      return;",
            "    } catch {",
            "      await new Promise((r) => setTimeout(r, 100));",
            "    }",
            "  }",
            "})();",
            "</script></body></html>",
          ].join("\n"),
          title: "bunframe e2e ipc",
          width: 280,
          height: 160,
        }),
      );

      let received: string | undefined;
      const seen: string[] = [];
      // The handler MUST NOT throw: every message gets a reply, so
      // the loop-thread invoke_wait always returns promptly.
      const handler = new JSCallback(
        (body: string) => {
          seen.push(body);
          if (body === "page-loaded") {
            return;
          }
          received = body;
          api.window_ipc_reply(handle, '{"pong":true}');
        },
        { args: ["cstring"], returns: "void" },
      );
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
        throw new Error(`bffi_callback_bind failed with status ${bindStatus}`);
      }
      const ipcHandle = bindOut[0] ?? 0n;
      api.window_bind_ipc(handle, ipcHandle);

      // Drive the page: the bootstrap promise posts the message;
      // the loop-thread handler parks on invoke_wait until THIS
      // thread pumps and the bound callback answers.
      api.window_eval(handle, `window.__bffiCall("ping", {})`);
      const deadline = Date.now() + 15_000;
      while (received === undefined && Date.now() < deadline) {
        api.loop_pump();
        await Bun.sleep(5);
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(received).toBeDefined();
      expect(JSON.parse(received ?? "{}")).toEqual({ method: "ping", args: {} });

      sym("bffi_callback_revoke")(ipcHandle);
      handler.close();
      api.window_close(handle);
    },
    120_000,
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
