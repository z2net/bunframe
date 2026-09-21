//! @z2net/bunframe-core public surface: the loader, the events adapter
//! and the error types. Callback deliveries need loop_pump (the
//! pump contract) - app.run() drives it; never hide it behind
//! timers.

export {
  createCore,
  findRoot,
  resolveBinary,
  type BunframeCore,
  type CoreOptions,
  type NativeWindowConfig,
} from "./loader.ts";
export { eventsStream, type WindowEvent } from "./events.ts";
export { BunframeError, toBunframeError } from "./errors.ts";
