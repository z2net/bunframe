//! @z2net/bunframe - the bun-side framework: the loader, the typed
//! command registry, the Window wrappers and the run loop.
//!
//! Import map (enforced by convention, kept by the tests):
//! - backend files:   `@z2net/bunframe` + `@z2net/bunframe/schema`
//! - shared rpc.ts:   `@z2net/bunframe/schema` ONLY (bun-safe, ships
//!   to the page as types)
//! - page files:      `@z2net/bunframe/view` ONLY (zero-dep; the
//!   root pulls `bun:ffi` and must never reach the browser)
//! - bunframe.config: `@z2net/bunframe/cli`
//!
//! Callback deliveries need loop_pump (the pump contract) - app.run()
//! drives it; quit() is terminal, the loop never respawns.

export {
  createApp,
  type App,
  type AppOptions,
  type AppWindowConfig,
  type BunMessagesOf,
  type RequestsOf,
  type ViewMessagesOf,
} from "#app/app.ts";
export { Window, type WindowHost } from "#app/window.ts";
export {
  createIpcHandler,
  errorReply,
  messageFrame,
  type EventEntry,
  type IpcState,
  type RequestEntry,
} from "#app/ipc.ts";
export { validateArgs, ValidationError, type Validated } from "#app/validate.ts";

export {
  createCore,
  findRoot,
  resolveBinary,
  type BunframeCore,
  type CoreOptions,
  type NativeWindowConfig,
} from "#core/loader.ts";
export { eventsStream, type WindowEvent } from "#core/events.ts";
export { BunframeError, toBunframeError } from "#core/errors.ts";
