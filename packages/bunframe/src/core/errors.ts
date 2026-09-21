//! Error surfaces: the JS-side BunframeError and the re-wrap of the
//! native error objects the generated api throws (bffi takeError
//! enriches them with a numeric `code` and the Rust variant name).

const JS_BASE_NAMES = new Set(["Error", "TypeError", "RangeError"]);

/** A bunframe failure carrying a machine code (the native variant
 * name - `InvalidHandle`, `LoopNotRunning`, ... - or a framework
 * code like `VALIDATION`). */
export class BunframeError extends Error {
  readonly code: string;
  /** The numeric ABI status, when the error came from a native call. */
  readonly status?: number;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions & { status?: number },
  ) {
    super(message, options);
    this.name = "BunframeError";
    this.code = code;
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}

/** Re-wraps a thrown value from a native call site: bffi's rich
 * errors (numeric `code` + variant `name`) become BunframeError,
 * anything else passes through untouched. */
export function toBunframeError(error: unknown): unknown {
  if (error instanceof BunframeError || !(error instanceof Error)) {
    return error;
  }
  const shaped = error as Error & { code?: unknown };
  if (typeof shaped.code === "number") {
    const variant = JS_BASE_NAMES.has(error.name) ? undefined : error.name;
    return new BunframeError(variant ?? "NATIVE", error.message, {
      cause: error,
      status: shaped.code,
    });
  }
  if (typeof shaped.code === "string" && shaped.code.length > 0) {
    return new BunframeError(shaped.code, error.message, { cause: error });
  }
  return error;
}
