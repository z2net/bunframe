//! The IPC request handler - PURE and SYNC: parse, validate,
//! dispatch, and return the reply JSON string. It NEVER throws:
//! every path - garbage frames, missing handlers, async validators,
//! handler throws - produces a well-formed error envelope, so the
//! loop-thread invoke_wait is always answered promptly (the reply
//! must be in window_ipc_reply BEFORE the callback returns).

import type { MessageFrame, ReplyFrame, RequestDef, StandardSchemaV1 } from "#schema";
import { validateArgs } from "./validate.ts";

/** One bun-handled request: the schema pair plus the registered
 * handler (sync by contract - long work belongs in a Bun worker). */
export interface RequestEntry {
  def: RequestDef;
  handler: (args: unknown) => unknown;
}

/** One view-message subscription set (page emits, bun listens). */
export interface EventEntry {
  schema: StandardSchemaV1 | undefined;
  listeners: Set<(payload: unknown) => void>;
}

/** The registry the bound ipc callback reads per delivery (live -
 * registrations after the bind are seen immediately). */
export interface IpcState {
  requests: Map<string, RequestEntry>;
  events: Map<string, EventEntry>;
}

/** Builds a failed reply envelope as JSON. */
export function errorReply(id: string, code: string, message: string): string {
  const reply: ReplyFrame = { v: 1, id, ok: false, error: { code, message } };
  return JSON.stringify(reply);
}

function okReply(id: string, result: unknown): string {
  const reply: ReplyFrame = { v: 1, id, ok: true, result };
  return JSON.stringify(reply);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Builds the bun -> page dispatch frame (`app.send` evaluates it
 * through window_eval). */
export function messageFrame(method: string, args: unknown): MessageFrame {
  return { v: 1, kind: "msg", method, args };
}

/** Builds the pure ipc handler over `state`. Every branch returns a
 * JSON string; nothing escapes. */
export function createIpcHandler(state: IpcState): (frameJson: string) => string {
  return (frameJson: string): string => {
    let frame: unknown;
    try {
      frame = JSON.parse(frameJson);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return errorReply("", "BAD_FRAME", `unparsable frame: ${reason}`);
    }
    if (!isRecord(frame) || frame.v !== 1) {
      return errorReply("", "BAD_FRAME", "the frame is not a v1 envelope");
    }
    const id = typeof frame.id === "string" ? frame.id : "";
    if (typeof frame.method !== "string") {
      return errorReply(id, "BAD_FRAME", "the frame carries no method");
    }
    const method: string = frame.method;

    if (frame.kind === "req") {
      const entry = state.requests.get(method);
      if (entry === undefined) {
        return errorReply(id, "NOT_FOUND", `no handler registered for "${method}"`);
      }
      const args = validateArgs(entry.def.params, frame.args);
      if (!args.ok) {
        return errorReply(id, "VALIDATION", args.message);
      }
      let result: unknown;
      try {
        result = entry.handler(args.value);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorReply(id, "HANDLER", reason);
      }
      const checked = validateArgs(entry.def.response, result);
      if (!checked.ok) {
        return errorReply(id, "VALIDATION", `response: ${checked.message}`);
      }
      return okReply(id, checked.value);
    }

    if (frame.kind === "evt") {
      const entry = state.events.get(method);
      if (entry !== undefined) {
        let payload: unknown = frame.args;
        if (entry.schema !== undefined) {
          const checked = validateArgs(entry.schema, payload);
          if (!checked.ok) {
            console.warn(`bunframe: dropped "${method}" event payload: ${checked.message}`);
            return okReply(id, null);
          }
          payload = checked.value;
        }
        for (const listener of Array.from(entry.listeners)) {
          try {
            listener(payload);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`bunframe: listener for "${method}" threw: ${reason}`);
          }
        }
      }
      return okReply(id, null);
    }

    return errorReply(id, "BAD_FRAME", `unknown frame kind "${String(frame.kind)}"`);
  };
}
