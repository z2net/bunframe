//! The bun-side framework: createApp wires the loader, the typed
//! command registry, the Window wrappers and the run loop.
//!
//! - `run()` pumps until `quit()` or the last window closed - the
//!   pump contract, explicit. `quit()` is TERMINAL: the native loop
//!   never respawns.
//! - Handlers are SYNC per call: the native round trip settles the
//!   page promise before the callback returns - long work belongs
//!   in a Bun worker.
//! - Omit `window` to start headless (run() then returns
//!   immediately; open windows later with `createWindow`).

import { createCore, toBunframeError, type BunframeCore, type NativeWindowConfig } from "#core";
import type {
  HandlerOf,
  InferMessagePayload,
  ListenerOf,
  RpcDef,
} from "#schema";
import { messageFrame, type EventEntry, type IpcState } from "./ipc.ts";
import { validateArgs, ValidationError } from "./validate.ts";
import { Window } from "./window.ts";

/** The window config the app author writes (everything optional;
 * mapped to the full null-filled record for window_open). */
export interface AppWindowConfig {
  url?: string;
  html?: string;
  title?: string;
  width?: number;
  height?: number;
  min_width?: number;
  min_height?: number;
  resizable?: boolean;
  decorations?: boolean;
  transparent?: boolean;
  maximized?: boolean;
  visible?: boolean;
  x?: number;
  y?: number;
  devtools?: boolean;
  always_on_top?: boolean;
  skip_taskbar?: boolean;
  /** The asset directory served to the page through the `bf`
   * custom protocol (pair with `url: "bf://localhost/index.html"`). */
  asset_root?: string;
}

/** The createApp options. */
export interface AppOptions<R extends RpcDef = RpcDef> {
  /** The shared RPC definition (typed requests and messages). */
  rpc?: R;
  /** The main window config; omit to start headless. */
  window?: AppWindowConfig;
  /** A pre-loaded core (tests, custom resolution); else createCore(). */
  core?: BunframeCore;
  /** run() returns when the last window closed (default true). */
  exitProcessOnLastWindowClosed?: boolean;
}

/** The request defs of a definition (`rpc.bun.requests`). */
export type RequestsOf<R extends RpcDef> = NonNullable<NonNullable<R["bun"]>["requests"]>;
/** The bun-emitted message defs (`rpc.bun.messages`). */
export type BunMessagesOf<R extends RpcDef> = NonNullable<NonNullable<R["bun"]>["messages"]>;
/** The page-emitted message defs (`rpc.view.messages`). */
export type ViewMessagesOf<R extends RpcDef> = NonNullable<NonNullable<R["view"]>["messages"]>;

/** The app surface an author holds. */
export interface App<R extends RpcDef = RpcDef> {
  /** The loaded native core. */
  readonly core: BunframeCore;
  /** The main window - only when createApp got a `window` config. */
  readonly window: Window | undefined;
  /** Opens another window (same registry, own events + bridge). */
  createWindow(config?: AppWindowConfig): Window;
  /** Registers the bun-side handler for a page request. */
  handle<M extends keyof RequestsOf<R> & string>(
    method: M,
    handler: HandlerOf<RequestsOf<R>[M]>,
  ): void;
  /** Validates and dispatches a message to the main window's page. */
  send<M extends keyof BunMessagesOf<R> & string>(
    method: M,
    payload: InferMessagePayload<BunMessagesOf<R>[M]>,
  ): void;
  /** Subscribes to a page-emitted message (validated on delivery;
   * invalid payloads are dropped with a warning). */
  on<M extends keyof ViewMessagesOf<R> & string>(
    method: M,
    listener: ListenerOf<ViewMessagesOf<R>[M]>,
  ): () => void;
  /** Pumps until quit() or the last window closed (headless:
   * returns immediately). */
  run(): Promise<void>;
  /** Terminal: stops the loop; it never respawns. */
  quit(): Promise<void>;
}

/** Every key of the native record, `null` = absent. */
const NULL_CONFIG = {
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
} as const;

function toNativeConfig(config: AppWindowConfig): NativeWindowConfig {
  return { ...NULL_CONFIG, ...config } as NativeWindowConfig;
}

/** Creates the app. Sync; loads the core only when none was given. */
export function createApp<R extends RpcDef = RpcDef>(options: AppOptions<R> = {}): App<R> {
  return new AppImpl(options);
}

class AppImpl<R extends RpcDef> implements App<R> {
  readonly core: BunframeCore;
  readonly #state: IpcState = {
    requests: new Map(),
    events: new Map(),
  };
  readonly #openWindows = new Set<bigint>();
  readonly #exitOnLast: boolean;
  readonly #rpc: R | undefined;
  #mainWindow: Window | undefined;
  #quitRequested = false;

  constructor(options: AppOptions<R>) {
    this.core = options.core ?? createCore();
    this.#rpc = options.rpc;
    this.#exitOnLast = options.exitProcessOnLastWindowClosed ?? true;
    if (options.window !== undefined) {
      this.#mainWindow = this.createWindow(options.window);
    }
  }

  get window(): Window | undefined {
    return this.#mainWindow;
  }

  createWindow(config: AppWindowConfig = {}): Window {
    const handle = this.#call(() => this.core.api.window_open(toNativeConfig(config)));
    const win = new Window({ core: this.core }, handle);
    win.bindIpc(this.#state);
    this.#openWindows.add(handle);
    void this.#pump(win);
    return win;
  }

  handle<M extends keyof RequestsOf<R> & string>(
    method: M,
    handler: HandlerOf<RequestsOf<R>[M]>,
  ): void {
    this.#register(method, handler as (args: unknown) => unknown);
  }

  send<M extends keyof BunMessagesOf<R> & string>(
    method: M,
    payload: InferMessagePayload<BunMessagesOf<R>[M]>,
  ): void {
    this.#send(method, payload);
  }

  on<M extends keyof ViewMessagesOf<R> & string>(
    method: M,
    listener: ListenerOf<ViewMessagesOf<R>[M]>,
  ): () => void {
    return this.#listen(method, listener as (payload: unknown) => void);
  }

  async run(): Promise<void> {
    while (!this.#quitRequested) {
      this.#call(() => this.core.api.loop_pump());
      if (this.#call(() => this.core.api.window_poll_exit())) {
        break;
      }
      if (this.#exitOnLast && this.#openWindows.size === 0) {
        break;
      }
      await Bun.sleep(1);
    }
  }

  async quit(): Promise<void> {
    this.#quitRequested = true;
    try {
      this.core.api.app_quit();
    } catch {
      // The loop is already dead - terminal either way (never respawns).
    }
  }

  #register(method: string, handler: (args: unknown) => unknown): void {
    const def = this.#rpc?.bun?.requests?.[method];
    if (def === undefined) {
      throw new Error(
        `bunframe: no request definition for "${method}" (add it to createApp({ rpc }))`,
      );
    }
    if (this.#state.requests.has(method)) {
      throw new Error(`bunframe: a handler for "${method}" is already registered`);
    }
    this.#state.requests.set(method, { def, handler });
  }

  #send(method: string, payload: unknown): void {
    const win = this.#mainWindow;
    if (win === undefined) {
      throw new Error("bunframe: send() needs a main window (pass createApp({ window }))");
    }
    const def = this.#rpc?.bun?.messages?.[method];
    if (def === undefined) {
      throw new Error(
        `bunframe: no message definition for "${method}" (add it to createApp({ rpc }))`,
      );
    }
    const checked = validateArgs(def.payload, payload);
    if (!checked.ok) {
      throw new ValidationError(checked.message);
    }
    const frame = messageFrame(method, checked.value);
    this.#call(() =>
      this.core.api.window_eval(win.handle, `window.__bfDispatch(${JSON.stringify(frame)});`),
    );
  }

  #listen(method: string, listener: (payload: unknown) => void): () => void {
    const schema = this.#rpc?.view?.messages?.[method]?.payload;
    let entry = this.#state.events.get(method);
    if (entry === undefined) {
      const created: EventEntry = { schema, listeners: new Set() };
      this.#state.events.set(method, created);
      entry = created;
    }
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  /** The per-window events pump: feeds the emitters, retires the
   * window on "closed". Errors die with the loop - caught. */
  async #pump(win: Window): Promise<void> {
    try {
      for await (const event of win.events) {
        win.deliver(event);
        if (event.type === "closed") {
          break;
        }
      }
    } catch {
      // The stream died with the loop (quit or crash) - the window
      // is as good as closed for the app.
    } finally {
      this.#openWindows.delete(win.handle);
      win.finish();
    }
  }

  #call<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw toBunframeError(error);
    }
  }
}
