//! The events stream adapter: the window's native push stream
//! (JSON strings) as a JS AsyncIterable of typed events. The items
//! only arrive while the JS thread pumps - `app.run()` drives it.
//!
//! The pull uses the e2e's proven POLL-RETRY pattern (bffi_stream_next
//! + status 14 = Pending), NOT the generic wake trampoline
//! (`bffi_stream_set_wake`): the trampoline cross-talks with the ipc
//! callback dispatch queue and starves it (found by the integration
//! e2e - the page's calls stopped dispatching while a wrapped stream
//! was being consumed). Manual pulls keep every dispatch healthy.

import { decodeAt, makeReadBuffer, type FfiLib } from "@z2net/bffi";
import { ptr } from "bun:ffi";
import type { BunframeCore } from "./loader.ts";

/** One native window event. */
export type WindowEvent =
  | { type: "resized"; width: number; height: number }
  | { type: "focused"; focused: boolean }
  | { type: "close-denied" }
  | { type: "closed" };

/** The bffi Pending status: the buffer is empty right now. */
const STREAM_PENDING = 14;

/** The events chunk budget per pull. */
const STREAM_MAX = 16;

function sym(lib: FfiLib, name: string): (...args: unknown[]) => unknown {
  const symbol = (lib as Record<string, unknown>)[name];
  if (typeof symbol !== "function") {
    throw new Error(`the ${name} export is missing`);
  }
  return symbol as (...args: unknown[]) => unknown;
}

/** Wraps the window's events stream handle. Completes when the
 * window closes (the "closed" event ends the native stream).
 * Malformed items are skipped, never thrown. */
export function eventsStream(core: BunframeCore, handle: bigint): AsyncIterable<WindowEvent> {
  const streamNext = sym(core.raw, "bffi_stream_next");
  const readBuffer = makeReadBuffer(core.raw);
  async function* generate(): AsyncGenerator<WindowEvent> {
    const out = new BigUint64Array(1);
    for (;;) {
      const status = Number(streamNext(handle, STREAM_MAX, ptr(out)));
      if (status === STREAM_PENDING) {
        await Bun.sleep(1);
        continue;
      }
      if (status !== 0) {
        throw new Error(`bffi_stream_next failed with status ${status}`);
      }
      const bufferHandle = out[0] ?? 0n;
      if (bufferHandle === 0n) {
        return;
      }
      const decoded = decodeAt(readBuffer(bufferHandle), 0);
      const items: unknown = decoded.value;
      if (!Array.isArray(items)) {
        continue;
      }
      for (const item of items) {
        if (typeof item !== "string") {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(item);
        } catch {
          continue;
        }
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { type?: unknown }).type === "string"
        ) {
          yield parsed as WindowEvent;
        }
      }
    }
  }
  return generate();
}
