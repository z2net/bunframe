//! Sync Standard Schema validation for the bridge: the native IPC
//! round trip is synchronous in v0.1.0, so a validator answering a
//! Promise is an error envelope, never an await.

import type { Issue, Result, StandardSchemaV1 } from "#schema";
import { BunframeError } from "#core";

/** A failed payload validation (code "VALIDATION"). */
export class ValidationError extends BunframeError {
  constructor(message: string) {
    super("VALIDATION", message);
    this.name = "ValidationError";
  }
}

/** The outcome of one sync validation. */
export type Validated = { ok: true; value: unknown } | { ok: false; message: string };

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Formats one issue as `path: message` (bare message at the root). */
function formatIssue(issue: Issue): string {
  if (issue.path === undefined || issue.path.length === 0) {
    return issue.message;
  }
  return `${issue.path.map((key) => String(key)).join(".")}: ${issue.message}`;
}

/** Runs one Standard Schema validation synchronously. A Promise
 * answer (async validator) or a throwing validator is a failure,
 * not an await - the native round trip cannot wait. */
export function validateArgs(schema: StandardSchemaV1, args: unknown): Validated {
  let result: Result<unknown> | Promise<Result<unknown>>;
  try {
    result = schema["~standard"].validate(args);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `validator threw: ${reason}` };
  }
  if (isPromise(result)) {
    return { ok: false, message: "async validators are not supported in v0.1.0" };
  }
  if (result.issues !== undefined) {
    return { ok: false, message: result.issues.map(formatIssue).join("; ") };
  }
  return { ok: true, value: result.value };
}
