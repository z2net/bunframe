//! The built-in `s` descriptors: small synchronous Standard Schema
//! v1 validators for the common shapes. Any conforming foreign
//! library (zod / valibot / arktype) drops in wherever a schema is
//! accepted - validation runs on the bun side only; the page never
//! validates.

import type { Issue, Result, StandardSchemaV1 } from "./types.ts";

/** The validated input type of a schema. */
export type InputOf<S extends StandardSchemaV1> =
  S extends StandardSchemaV1<infer I, unknown> ? I : unknown;

/** The validated output type of a schema. */
export type OutputOf<S extends StandardSchemaV1> =
  S extends StandardSchemaV1<unknown, infer O> ? O : unknown;

/** The shape accepted by `s.object`. */
export type ObjectShape = { readonly [key: string]: StandardSchemaV1 };

/** The input of `s.object`: every prop optional (presence is the
 * inner schema's business). */
export type ObjectInput<S extends ObjectShape> = {
  [K in keyof S]?: InputOf<S[K]>;
};

/** The output of `s.object`: every prop required, unknown keys
 * stripped. */
export type ObjectOutput<S extends ObjectShape> = {
  [K in keyof S]: OutputOf<S[K]>;
};

/** Wraps a sync validate fn as a Standard Schema v1 schema. */
function make<Input, Output>(
  validate: (value: unknown) => Result<Output>,
): StandardSchemaV1<Input, Output> {
  return { "~standard": { version: 1, vendor: "bunframe", validate } };
}

/** A passed validation. */
function ok<Output>(value: Output): Result<Output> {
  return { value };
}

/** A failed validation with a single issue. */
function fail(message: string, path?: PropertyKey[]): Result<never> {
  return path === undefined
    ? { issues: [{ message }] }
    : { issues: [{ message, path }] };
}

/** A failed validation from already-collected issues. */
function failed(issues: ReadonlyArray<Issue>): Result<never> {
  return { issues };
}

/** Re-roots a nested issue under `key` (`[key, ...rest]`). */
function prefixPath(issue: Issue, key: PropertyKey): Issue {
  return issue.path === undefined
    ? { message: issue.message, path: [key] }
    : { message: issue.message, path: [key, ...issue.path] };
}

/** True when a validation came back failed. */
function isFailure(
  result: Result<unknown>,
): result is { readonly issues: ReadonlyArray<Issue> } {
  return result.issues !== undefined;
}

/** A helpful runtime type name for issue messages. */
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Runs one nested validator; a Promise answer fails - the bridge
 * is synchronous in v0.1.0, async validators cannot be awaited. */
function runNested<Output>(
  validate: (value: unknown) => Result<Output> | Promise<Result<Output>>,
  value: unknown,
): Result<Output> {
  const result = validate(value);
  return isPromise(result)
    ? fail("expected a synchronous validator, got a Promise")
    : result;
}

/** Collects nested results into `out` / `issues`, re-rooting every
 * nested issue under `key`. */
function collect(
  result: Result<unknown>,
  key: PropertyKey,
  out: (value: unknown) => void,
  issues: Issue[],
): void {
  if (isFailure(result)) {
    for (const issue of result.issues) issues.push(prefixPath(issue, key));
  } else {
    out(result.value);
  }
}

/** A string. */
export function string(): StandardSchemaV1<string, string> {
  return make<string, string>((value) =>
    typeof value === "string"
      ? ok(value)
      : fail(`expected a string, got ${typeOf(value)}`),
  );
}

/** A number (NaN passes - JSON wire frames can never carry one). */
export function number(): StandardSchemaV1<number, number> {
  return make<number, number>((value) =>
    typeof value === "number"
      ? ok(value)
      : fail(`expected a number, got ${typeOf(value)}`),
  );
}

/** A boolean. */
export function boolean(): StandardSchemaV1<boolean, boolean> {
  return make<boolean, boolean>((value) =>
    typeof value === "boolean"
      ? ok(value)
      : fail(`expected a boolean, got ${typeOf(value)}`),
  );
}

/** A bigint (in-process only - a bigint never crosses the JSON
 * wire). */
export function bigint(): StandardSchemaV1<bigint, bigint> {
  return make<bigint, bigint>((value) =>
    typeof value === "bigint"
      ? ok(value)
      : fail(`expected a bigint, got ${typeOf(value)}`),
  );
}

/** An exact value, compared with Object.is. */
export function literal<
  const T extends string | number | boolean | bigint | null | undefined,
>(value: T): StandardSchemaV1<T, T> {
  const display =
    typeof value === "string" ? JSON.stringify(value) : String(value);
  return make<T, T>((input) =>
    Object.is(input, value)
      ? ok(value)
      : fail(`expected ${display}, got ${typeOf(input)}`),
  );
}

/** An array; nested issues carry an index path (`[1, "id"]` for
 * element 1, field id). */
export function array<I, O>(
  item: StandardSchemaV1<I, O>,
): StandardSchemaV1<readonly I[], O[]> {
  const validateItem = item["~standard"].validate;
  return make<readonly I[], O[]>((value) => {
    if (!Array.isArray(value)) {
      return fail(`expected an array, got ${typeOf(value)}`);
    }
    const out: O[] = [];
    const issues: Issue[] = [];
    for (let i = 0; i < value.length; i++) {
      collect(runNested(validateItem, value[i]), i, (v) => out.push(v as O), issues);
    }
    return issues.length > 0 ? failed(issues) : ok(out);
  });
}

/**
 * An object. Unknown keys are STRIPPED from the output; every
 * input prop is optional, and a missing prop validates as
 * `undefined` - wrap it in `s.optional` to allow omission. Nested
 * issues carry the key path (`["user", "name"]`).
 */
export function object<const S extends ObjectShape>(
  shape: S,
): StandardSchemaV1<ObjectInput<S>, ObjectOutput<S>> {
  return make<ObjectInput<S>, ObjectOutput<S>>((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail(`expected an object, got ${typeOf(value)}`);
    }
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const issues: Issue[] = [];
    for (const [key, inner] of Object.entries(shape)) {
      collect(
        runNested(inner["~standard"].validate, input[key]),
        key,
        (v) => {
          out[key] = v;
        },
        issues,
      );
    }
    return issues.length > 0
      ? failed(issues)
      : ok(out as ObjectOutput<S>);
  });
}

/** A string-keyed record; nested issues carry the key path
 * (`["settings", "volume"]`). */
export function record<I, O>(
  value: StandardSchemaV1<I, O>,
): StandardSchemaV1<{ readonly [key: string]: I }, { [key: string]: O }> {
  const validateValue = value["~standard"].validate;
  return make<{ readonly [key: string]: I }, { [key: string]: O }>((input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return fail(`expected an object, got ${typeOf(input)}`);
    }
    const source = input as Record<string, unknown>;
    const out: Record<string, O> = {};
    const issues: Issue[] = [];
    for (const key of Object.keys(source)) {
      collect(
        runNested(validateValue, source[key]),
        key,
        (v) => {
          out[key] = v as O;
        },
        issues,
      );
    }
    return issues.length > 0 ? failed(issues) : ok(out);
  });
}

/** Tries each schema in order; the first success wins. */
export function union<const S extends readonly StandardSchemaV1[]>(
  ...schemas: S
): StandardSchemaV1<InputOf<S[number]>, OutputOf<S[number]>> {
  type Member = (
    value: unknown,
  ) => Result<OutputOf<S[number]>> | Promise<Result<OutputOf<S[number]>>>;
  const validators = schemas.map(
    (schema) => schema["~standard"].validate as Member,
  );
  return make<InputOf<S[number]>, OutputOf<S[number]>>((value) => {
    for (const validate of validators) {
      const result = runNested(validate, value);
      if (!isFailure(result)) return result;
    }
    return fail(
      `expected a value matching one of ${validators.length} schemas, got ${typeOf(value)}`,
    );
  });
}

/** `undefined` passes through; anything else goes to `schema`. */
export function optional<I, O>(
  schema: StandardSchemaV1<I, O>,
): StandardSchemaV1<I | undefined, O | undefined> {
  const validateInner = schema["~standard"].validate;
  return make<I | undefined, O | undefined>((value) =>
    value === undefined ? ok(undefined) : runNested(validateInner, value),
  );
}

/** `null` passes through; anything else goes to `schema`. */
export function nullable<I, O>(
  schema: StandardSchemaV1<I, O>,
): StandardSchemaV1<I | null, O | null> {
  const validateInner = schema["~standard"].validate;
  return make<I | null, O | null>((value) =>
    value === null ? ok(null) : runNested(validateInner, value),
  );
}

/** Anything passes, unchanged. */
export function unknown(): StandardSchemaV1<unknown, unknown> {
  return make<unknown, unknown>((value) => ok(value));
}

/** Anything passes, unchanged (alias of `s.unknown`). */
export function any(): StandardSchemaV1<unknown, unknown> {
  return make<unknown, unknown>((value) => ok(value));
}

/** The built-in validators. */
export const s = {
  string,
  number,
  boolean,
  bigint,
  literal,
  array,
  object,
  record,
  union,
  optional,
  nullable,
  unknown,
  any,
};
