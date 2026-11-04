import { describe, expect, it } from "vitest";
import { describeError } from "./safe-error";

/** What a driver error carries: the failed SQL, its params, a person's email, a stack. */
function driverError(): Error {
  const cause = Object.assign(new Error('duplicate key value violates unique constraint "user_email_idx"'), {
    name: "PostgresError",
    code: "23505",
    detail: "Key (email)=(someone@example.test) already exists.",
  });
  const error = new Error(
    'Failed query: insert into "user" ("email") values ($1)\nparams: someone@example.test',
    { cause },
  );
  error.name = "DrizzleQueryError";
  return error;
}

describe("describeError", () => {
  it("names the operation, the error type, the code and a correlation id", () => {
    const line = describeError("migrate", driverError(), "abc12345");
    expect(line).toBe("operation=migrate type=DrizzleQueryError code=23505 ref=abc12345");
  });

  it("carries no SQL, params, email, detail or stack", () => {
    const line = describeError("seed", driverError());
    for (const leaked of ["insert into", "params", "someone@example.test", "Key (email)", "user_email_idx", " at ", "$1"]) {
      expect(line).not.toContain(leaked);
    }
  });

  it("falls back to the errno code of a connection failure", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:5432"), { code: "ECONNREFUSED" });
    const line = describeError("migrate", refused, "r1");
    expect(line).toBe("operation=migrate type=Error code=ECONNREFUSED ref=r1");
    expect(line).not.toContain("10.0.0.9");
  });

  it("copes with a thrown string or null, and ignores an odd code", () => {
    expect(describeError("seed", "boom: secret", "r1")).toBe("operation=seed type=unknown code=none ref=r1");
    expect(describeError("seed", null, "r1")).toBe("operation=seed type=unknown code=none ref=r1");
    expect(describeError("seed", Object.assign(new Error("x"), { code: "select * from user" }), "r1")).toContain("code=none");
  });

  it("generates a ref when none is given", () => {
    expect(describeError("seed", new Error("x"))).toMatch(/ref=[0-9a-f]{8}$/);
  });
});
