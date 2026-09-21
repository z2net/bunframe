//! THE frozen type contract of the bunframe RPC: the wire envelope,
//! the schema-definition shapes and the inference helpers.
//!
//! `@z2net/bunframe-app`, `@z2net/bunframe-view` and `@z2net/bunframe-schema` all
//! compile against this file - the declarations here are the
//! interface between parallel work streams and must not drift.
//! Runtime code (the `s` descriptors, `defineSchema`) lives in the
//! sibling modules and may evolve freely as long as these types
//! hold.

// ---------------------------------------------------------------------------
// Standard Schema (minimal local copy of the v1 spec,
// https://standardschema.dev) - a schema is any object carrying the
// `~standard` property: the built-in `s` descriptors OR a foreign
// library (zod / valibot / arktype) that conforms.
// ---------------------------------------------------------------------------

/** A Standard Schema v1 conforming validator. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    /**
     * Validates an unknown value. Sync results only on the bunframe
     * bridge: an async validator (a returned Promise) is answered to
     * the page with an error envelope, not awaited - the native
     * round trip is synchronous in v0.1.0.
     */
    readonly validate: (
      value: unknown,
    ) => Result<Output> | Promise<Result<Output>>;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

/** The Standard Schema validation result. */
export type Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<Issue> };

/** A Standard Schema validation issue. */
export interface Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey> | undefined;
}

// ---------------------------------------------------------------------------
// The wire envelope (JSON, one frame per IPC round trip / dispatch).
// ---------------------------------------------------------------------------

/** The wire version carried by every frame; bump on a breaking
 * envelope change. */
export type EnvelopeVersion = 1;

/** Page -> bun: a request (`req`, answered) or an event (`evt`,
 * fire-and-forget - still costs one round trip on the native
 * bridge). */
export interface RequestFrame {
  v: EnvelopeVersion;
  id: string;
  kind: "req" | "evt";
  method: string;
  args: unknown;
}

/** Bun -> page: the answer to one request frame. Produced by
 * `@z2net/bunframe-app`; the core embeds it into the resolve script
 * VERBATIM (it must be valid JSON). */
export type ReplyFrame =
  | { v: EnvelopeVersion; id: string; ok: true; result: unknown }
  | { v: EnvelopeVersion; id: string; ok: false; error: RpcError };

/** Bun -> page: a fire-and-forget message delivered to the page
 * through `window.__bfDispatch(frame)` (evaluate_script). */
export interface MessageFrame {
  v: EnvelopeVersion;
  kind: "msg";
  method: string;
  args: unknown;
}

/** The error object of a failed reply. */
export interface RpcError {
  /** Machine code: `"VALIDATION"`, `"NOT_FOUND"`, `"HANDLER"`,
   * `"NATIVE"`, ... */
  code: string;
  /** Human-readable detail. */
  message: string;
}

// ---------------------------------------------------------------------------
// The shared RPC definition (the app author's single source of
// truth, imported by both the bun side and the page side).
// ---------------------------------------------------------------------------

/** One bun-handled method: `args` are validated on arrival, the
 * response is validated before the reply leaves. */
export interface RequestDef {
  readonly params: StandardSchemaV1;
  readonly response: StandardSchemaV1;
}

/** One fire-and-forget message (payload validated by the receiving
 * side; the bun side always validates, the page never does). */
export interface MessageDef {
  readonly payload: StandardSchemaV1;
}

/**
 * The RPC definition shape accepted by `defineSchema`:
 *
 * - `bun.requests`  - page calls, bun handles
 *   (`view.request.*` / `app.handle`)
 * - `bun.messages`  - bun emits, page listens
 *   (`app.send` / `view.on`)
 * - `view.messages` - page emits, bun listens
 *   (`view.send` / `app.on`)
 */
export interface RpcDef {
  readonly bun?: {
    readonly requests?: { readonly [method: string]: RequestDef };
    readonly messages?: { readonly [method: string]: MessageDef };
  };
  readonly view?: {
    readonly messages?: { readonly [method: string]: MessageDef };
  };
}

// ---------------------------------------------------------------------------
// Inference helpers (the whole point: runtime schemas double as the
// type source - define once, typed everywhere).
// ---------------------------------------------------------------------------

/** The validated input type of a request's `params` schema. */
export type InferRequestArgs<R> = R extends {
  params: StandardSchemaV1<infer I, unknown>;
}
  ? I
  : unknown;

/** The validated output type of a request's `response` schema. */
export type InferRequestResult<R> = R extends {
  response: StandardSchemaV1<unknown, infer O>;
}
  ? O
  : unknown;

/** The validated output type of a message's `payload` schema. */
export type InferMessagePayload<M> = M extends {
  payload: StandardSchemaV1<unknown, infer O>;
}
  ? O
  : unknown;

/** A bun-side request handler. SYNC by contract: the native bridge
 * settles the page promise before the callback returns - long work
 * belongs in a Bun worker. */
export type HandlerOf<R> = R extends RequestDef
  ? (args: InferRequestArgs<R>) => InferRequestResult<R>
  : never;

/** A bun-side message listener (`view.messages` payloads arriving
 * from the page). */
export type ListenerOf<M> = M extends MessageDef
  ? (payload: InferMessagePayload<M>) => void
  : never;
