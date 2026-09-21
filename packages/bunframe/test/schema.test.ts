//! Tests for the @z2net/bunframe-schema runtime: every `s` descriptor
//! (valid + invalid values, nested issue paths, unknown-key
//! stripping), `defineSchema` identity, the type inference flow and
//! the structural conformance of a foreign Standard Schema.

import { describe, expect, test } from "bun:test";

import {
  defineSchema,
  s,
  type InferMessagePayload,
  type InferRequestArgs,
  type InferRequestResult,
  type InputOf,
  type Issue,
  type OutputOf,
  type Result,
  type StandardSchemaV1,
} from "#schema";

/** Runs a schema's validator, failing loudly on an async answer. */
function validate(schema: StandardSchemaV1, value: unknown): Result<unknown> {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new Error("unexpected async validator");
  }
  return result;
}

/** The value of a validation that must pass. */
function valueOf(schema: StandardSchemaV1, value: unknown): unknown {
  const result = validate(schema, value);
  if (result.issues !== undefined) {
    throw new Error(`expected issues-free validation: ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

/** All issues of a validation that must fail. */
function issuesOf(schema: StandardSchemaV1, value: unknown): ReadonlyArray<Issue> {
  const result = validate(schema, value);
  if (result.issues === undefined) {
    throw new Error(`expected issues, got a value: ${JSON.stringify(result.value)}`);
  }
  return result.issues;
}

/** The first issue of a validation that must fail. */
function firstIssue(schema: StandardSchemaV1, value: unknown): Issue {
  const issues = issuesOf(schema, value);
  const first = issues[0];
  if (first === undefined) throw new Error("expected at least one issue");
  return first;
}

/** Compile-time equality of two types (1 = equal). */
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("s primitives", () => {
  test("string / number / boolean / bigint pass their own type", () => {
    expect(valueOf(s.string(), "hi")).toBe("hi");
    expect(valueOf(s.number(), 5)).toBe(5);
    expect(valueOf(s.boolean(), false)).toBe(false);
    expect(valueOf(s.bigint(), 10n)).toBe(10n);
  });

  test("primitives reject everything else with a helpful message", () => {
    expect(firstIssue(s.string(), 5).message).toContain("string");
    expect(firstIssue(s.string(), null).message).toContain("null");
    expect(firstIssue(s.number(), "5").message).toContain("number");
    expect(firstIssue(s.boolean(), undefined).message).toContain("boolean");
    expect(firstIssue(s.bigint(), 10).message).toContain("bigint");
  });

  test("unknown / any are pass-through", () => {
    expect(valueOf(s.unknown(), { a: [1, "x"] })).toEqual({ a: [1, "x"] });
    expect(valueOf(s.any(), "whatever")).toBe("whatever");
    expect(valueOf(s.unknown(), undefined)).toBeUndefined();
  });
});

describe("s.literal", () => {
  test("accepts the exact value only", () => {
    expect(valueOf(s.literal("a"), "a")).toBe("a");
    expect(valueOf(s.literal(3), 3)).toBe(3);
    expect(firstIssue(s.literal("a"), "b").message).toContain('"a"');
    expect(firstIssue(s.literal("a"), 5).message).toContain("number");
  });
});

describe("s.array", () => {
  const strings = s.array(s.string());

  test("maps every element", () => {
    expect(valueOf(strings, ["a", "b"])).toEqual(["a", "b"]);
  });

  test("rejects non-arrays", () => {
    expect(firstIssue(strings, "abc").message).toContain("array");
    expect(firstIssue(strings, { length: 1 }).message).toContain("array");
  });

  test("reports the index path of a bad element", () => {
    const issue = firstIssue(strings, ["a", 5]);
    expect(issue.message).toContain("string");
    expect(issue.path).toEqual([1]);
  });

  test("collects every bad element", () => {
    expect(issuesOf(strings, [1, "a", 2])).toHaveLength(2);
  });
});

describe("s.object", () => {
  const user = s.object({ name: s.string(), age: s.number() });

  test("validates and keeps the shape", () => {
    expect(valueOf(user, { name: "a", age: 1 })).toEqual({ name: "a", age: 1 });
  });

  test("rejects non-objects (incl. arrays and null)", () => {
    expect(firstIssue(user, "x").message).toContain("object");
    expect(firstIssue(user, [1]).message).toContain("object");
    expect(firstIssue(user, null).message).toContain("object");
  });

  test("strips unknown keys", () => {
    expect(valueOf(user, { name: "a", age: 1, extra: true })).toEqual({
      name: "a",
      age: 1,
    });
  });

  test("a missing prop validates as undefined", () => {
    expect(firstIssue(user, { name: "a" }).message).toContain("undefined");
  });

  test("nested issues carry the key path", () => {
    const nested = s.object({ user: s.object({ name: s.string() }) });
    const issue = firstIssue(nested, { user: { name: 5 } });
    expect(issue.message).toContain("string");
    expect(issue.path).toEqual(["user", "name"]);
  });

  test("collects issues across props", () => {
    expect(issuesOf(user, { name: 1, age: "x" })).toHaveLength(2);
  });

  test("s.optional allows omission and keeps the other props required", () => {
    const withOptional = s.object({ req: s.string(), opt: s.optional(s.number()) });
    expect(valueOf(withOptional, { req: "a" })).toEqual({ req: "a" });
    expect(valueOf(withOptional, { req: "a", opt: 2 })).toEqual({ req: "a", opt: 2 });
    expect(firstIssue(withOptional, { opt: 2 }).message).toContain("string");
  });
});

describe("s.record", () => {
  const numbers = s.record(s.number());

  test("validates every value", () => {
    expect(valueOf(numbers, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("rejects non-objects", () => {
    expect(firstIssue(numbers, [1]).message).toContain("object");
  });

  test("reports the key path of a bad value", () => {
    const issue = firstIssue(numbers, { a: 1, b: "x" });
    expect(issue.message).toContain("number");
    expect(issue.path).toEqual(["b"]);
  });
});

describe("s.union", () => {
  const strOrNum = s.union(s.string(), s.number());

  test("first success wins", () => {
    expect(valueOf(strOrNum, "a")).toBe("a");
    expect(valueOf(strOrNum, 5)).toBe(5);
    expect(valueOf(s.union(s.literal("a"), s.string()), "a")).toBe("a");
  });

  test("one issue when everything fails", () => {
    const issue = firstIssue(strOrNum, true);
    expect(issue.message).toContain("one of 2 schemas");
    expect(issue.message).toContain("boolean");
  });
});

describe("s.optional / s.nullable", () => {
  test("optional passes undefined through, delegates the rest", () => {
    const opt = s.optional(s.string());
    expect(valueOf(opt, undefined)).toBeUndefined();
    expect(valueOf(opt, "a")).toBe("a");
    expect(firstIssue(opt, 5).message).toContain("string");
  });

  test("nullable passes null through, delegates the rest", () => {
    const nul = s.nullable(s.number());
    expect(valueOf(nul, null)).toBeNull();
    expect(valueOf(nul, 5)).toBe(5);
    expect(firstIssue(nul, "x").message).toContain("number");
  });
});

describe("foreign Standard Schema conformance", () => {
  /** A minimal hand-rolled conforming schema (zod-shaped). */
  const foreign = {
    "~standard": {
      version: 1,
      vendor: "fake",
      validate: (value: unknown): Result<string> =>
        typeof value === "string"
          ? { value }
          : { issues: [{ message: "expected a string" }] },
    },
  } satisfies StandardSchemaV1<string, string>;

  test("is assignable to StandardSchemaV1", () => {
    const conforms: StandardSchemaV1<string, string> = foreign;
    expect(conforms["~standard"].vendor).toBe("fake");
  });

  test("drops into the built-in containers", () => {
    const wrapped = s.object({ x: foreign });
    expect(valueOf(wrapped, { x: "a" })).toEqual({ x: "a" });
    expect(firstIssue(wrapped, { x: 5 }).message).toContain("string");
  });

  test("is accepted as request params/response and infers types", () => {
    const rpc = defineSchema({
      bun: { requests: { echo: { params: foreign, response: foreign } } },
    });
    type Echo = typeof rpc.bun.requests.echo;
    const output: Eq<InferRequestResult<Echo>, string> = true;
    expect(output).toBe(true);
  });
});

describe("defineSchema", () => {
  test("is an identity at runtime", () => {
    const def = { view: { messages: {} } } as const;
    expect(defineSchema(def)).toBe(def);
  });

  test("carries the schema types through the frozen helpers", () => {
    const rpc = defineSchema({
      bun: {
        requests: {
          greet: {
            params: s.object({ name: s.string() }),
            response: s.object({ message: s.string() }),
          },
        },
        messages: { tick: { payload: s.number() } },
      },
      view: {
        messages: { ready: { payload: s.array(s.string()) } },
      },
    });

    type Greet = typeof rpc.bun.requests.greet;

    const args: Eq<InferRequestArgs<Greet>, { name?: string }> = true;
    const result: Eq<InferRequestResult<Greet>, { message: string }> = true;
    const argsAllowPartial: InferRequestArgs<Greet> = {};
    const tick: Eq<
      InferMessagePayload<(typeof rpc.bun.messages.tick)>,
      number
    > = true;
    const ready: Eq<
      InferMessagePayload<(typeof rpc.view.messages.ready)>,
      string[]
    > = true;

    expect(args).toBe(true);
    expect(result).toBe(true);
    expect(tick).toBe(true);
    expect(ready).toBe(true);
    expect(argsAllowPartial).toEqual({});
  });

  test("s.object types: optional inputs, required stripped outputs", () => {
    const loose = s.object({ req: s.string(), opt: s.optional(s.number()) });

    const input: Eq<InputOf<typeof loose>, { req?: string; opt?: number | undefined }> =
      true;
    const output: Eq<
      OutputOf<typeof loose>,
      { req: string; opt: number | undefined }
    > = true;

    expect(input).toBe(true);
    expect(output).toBe(true);
  });
});
