//! The Window wrapper: every command is one api call (native errors
//! re-thrown as BunframeError), the typed event emitter fed by the
//! app's pump task, the close veto (fail-open) and the page bridge
//! binding. Callback deliveries execute only while the JS thread
//! pumps (`app.run()`).

import { JSCallback, ptr } from "bun:ffi";
import {
  TAG_STR,
  TAG_UNIT,
  bindJsCallback,
  revokeCallback,
  type CbValue,
} from "@z2net/bffi";
import {
  eventsStream,
  toBunframeError,
  type BunframeCore,
  type WindowEvent,
} from "#core";
import { createIpcHandler, errorReply, type IpcState } from "./ipc.ts";

/** What a Window needs from its app (the loaded core). */
export interface WindowHost {
  readonly core: BunframeCore;
}

type ListenerFor<T extends WindowEvent["type"]> = (
  event: Extract<WindowEvent, { type: T }>,
) => void;

/** One native window: commands, typed events, close veto and the
 * `__bffiCall` bridge. Created through `app.createWindow` / the
 * `createApp({ window })` main window. */
export class Window {
  /** The opaque native handle (u64 as bigint). */
  readonly handle: bigint;
  /** The raw event stream; the app's pump task consumes it and
   * feeds `deliver`. */
  readonly events: AsyncIterable<WindowEvent>;

  readonly #core: BunframeCore;
  readonly #emitters = new Map<WindowEvent["type"], Set<(event: WindowEvent) => void>>();
  #ipc: { js: JSCallback; handle: bigint } | undefined;
  #veto: { revoke(): void } | undefined;
  #finished = false;

  constructor(host: WindowHost, handle: bigint) {
    this.#core = host.core;
    this.handle = handle;
    this.events = eventsStream(host.core, host.core.api.window_events(handle));
  }

  title(value: string): void {
    this.#call(() => this.#api.window_set_title(this.handle, value));
  }

  setSize(width: number, height: number): void {
    this.#call(() => this.#api.window_set_size(this.handle, width, height));
  }

  focus(): void {
    this.#call(() => this.#api.window_focus(this.handle));
  }

  maximize(): void {
    this.#call(() => this.#api.window_maximize(this.handle));
  }

  unmaximize(): void {
    this.#call(() => this.#api.window_unmaximize(this.handle));
  }

  minimize(): void {
    this.#call(() => this.#api.window_minimize(this.handle));
  }

  setVisible(on: boolean): void {
    this.#call(() => this.#api.window_set_visible(this.handle, on));
  }

  setResizable(on: boolean): void {
    this.#call(() => this.#api.window_set_resizable(this.handle, on));
  }

  setDecorations(on: boolean): void {
    this.#call(() => this.#api.window_set_decorations(this.handle, on));
  }

  setAlwaysOnTop(on: boolean): void {
    this.#call(() => this.#api.window_set_always_on_top(this.handle, on));
  }

  openDevtools(): void {
    this.#call(() => this.#api.window_open_devtools(this.handle));
  }

  /** Evaluates `js` in the page (fire-and-forget). */
  eval(js: string): void {
    this.#call(() => this.#api.window_eval(this.handle, js));
  }

  /** Closes the window (no veto on a programmatic close; the
   * "closed" event completes the stream). */
  close(): void {
    this.#call(() => this.#api.window_close(this.handle));
  }

  /** Subscribes to one native event type; returns the unsubscribe
   * fn. Listeners run on the pump task - keep them quick. */
  on<T extends WindowEvent["type"]>(type: T, listener: ListenerFor<T>): () => void {
    let set = this.#emitters.get(type);
    if (set === undefined) {
      const created = new Set<(event: WindowEvent) => void>();
      this.#emitters.set(type, created);
      set = created;
    }
    const listeners = set;
    const fn = listener as (event: WindowEvent) => void;
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  /** Binds the close veto: the fn answers `true` (allow the title-bar
   * X) or `false` (deny; a close-denied event is pushed). Any parse
   * error FAILS OPEN - a hung backend must not trap the user. */
  onCloseRequested(fn: (event: { type: "close-requested" }) => boolean): void {
    if (this.#veto !== undefined) {
      throw new Error("bunframe: a close-veto callback is already bound for this window");
    }
    const veto = bindJsCallback(
      this.#core.raw,
      { ret: "bool", params: ["string"] },
      (...args: CbValue[]) => {
        try {
          return Boolean(fn(JSON.parse(String(args[0] ?? ""))));
        } catch {
          return true;
        }
      },
    );
    try {
      this.#call(() => this.#api.window_bind_close(this.handle, veto.handle));
    } catch (error) {
      try {
        veto.revoke();
      } catch {
        // Nothing bound native-side; the JS half is closed by revoke.
      }
      throw error;
    }
    this.#veto = veto;
  }

  /** @internal Feeds one native event to the typed listeners (the
   * pump task calls this; not app-facing). */
  deliver(event: WindowEvent): void {
    const listeners = this.#emitters.get(event.type);
    if (listeners === undefined) {
      return;
    }
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`bunframe: ${event.type} listener threw: ${reason}`);
      }
    }
  }

  /** @internal Releases the native callback handles and completes
   * the emitters (the pump task, on "closed" or stream end). */
  finish(): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.#emitters.clear();
    if (this.#ipc !== undefined) {
      try {
        revokeCallback(this.#core.raw, this.#ipc.handle);
      } catch {
        // The loop is already gone - revocation is best effort here.
      }
      try {
        this.#ipc.js.close();
      } catch {
        // Already closed.
      }
      this.#ipc = undefined;
    }
    if (this.#veto !== undefined) {
      try {
        this.#veto.revoke();
      } catch {
        // Already revoked (revocation is terminal).
      }
      this.#veto = undefined;
    }
  }

  /** @internal Wires the page bridge: `window.__bffiCall` deliveries
   * run the pure handler and answer through window_ipc_reply BEFORE
   * the callback returns. The ipc callback is `unit(str)` per the
   * core ABI - sig bytes [TAG_UNIT, TAG_STR] through the raw
   * `bffi_callback_bind`, exactly like the e2e (CbType cannot spell
   * a unit return). */
  bindIpc(state: IpcState): void {
    const api = this.#api;
    const handleRequest = createIpcHandler(state);
    const js = new JSCallback(
      (body: string) => {
        let reply: string;
        try {
          reply = handleRequest(String(body ?? ""));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          reply = errorReply("", "BAD_FRAME", `ipc handler failed: ${reason}`);
        }
        try {
          this.#call(() => api.window_ipc_reply(this.handle, reply));
        } catch {
          // The loop is gone; the reply has no consumer left.
        }
      },
      { args: ["cstring"], returns: "void" },
    );
    if (js.ptr === null) {
      throw new Error("bun:ffi produced a null JSCallback pointer");
    }
    const sig = new Uint8Array([TAG_UNIT, TAG_STR]);
    const out = new BigUint64Array(1);
    const status = Number(
      this.#sym("bffi_callback_bind")(
        sig[0],
        ptr(sig.subarray(1)),
        sig.length - 1,
        BigInt(js.ptr),
        out,
      ),
    );
    if (status !== 0) {
      js.close();
      throw new Error(`bffi_callback_bind failed with status ${status}`);
    }
    const bound = out[0] ?? 0n;
    this.#ipc = { js, handle: bound };
    this.#call(() => api.window_bind_ipc(this.handle, bound));
  }

  get #api(): BunframeCore["api"] {
    return this.#core.api;
  }

  #sym(name: string): (...args: unknown[]) => unknown {
    const symbol = (this.#core.raw as Record<string, unknown>)[name];
    if (typeof symbol !== "function") {
      throw new Error(`the ${name} export is missing`);
    }
    return symbol as (...args: unknown[]) => unknown;
  }

  #call<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw toBunframeError(error);
    }
  }
}
