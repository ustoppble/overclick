import { TEST_AUTH_SECRET } from "../test-support/auth-secret";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  token: undefined as string | undefined,
  users: [] as Array<{
    id: string;
    email: string;
    active: boolean;
    sessionVersion: number;
  }>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () =>
      authState.token === undefined ? undefined : { value: authState.token },
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock("./db", () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => authState.users,
        }),
      }),
    }),
  }),
}));

import { getSession } from "./cookies";
import { signSession } from "./session";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const EMAIL = "admin@example.invalid";

describe("getSession", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    authState.token = undefined;
    authState.users = [];
  });

  afterEach(() => {
    delete process.env.AUTH_SECRET;
  });

  it("rejects a correctly signed session for a user that does not exist", async () => {
    authState.token = await signSession({
      userId: USER_ID,
      sessionVersion: 1,
    });

    await expect(getSession()).resolves.toBeNull();
  });

  it("rejects a session for an inactive user", async () => {
    authState.users = [
      {
        id: USER_ID,
        email: EMAIL,
        active: false,
        sessionVersion: 1,
      },
    ];
    authState.token = await signSession({
      userId: USER_ID,
      sessionVersion: 1,
    });

    await expect(getSession()).resolves.toBeNull();
  });

  it("rejects a session after the user's session version changes", async () => {
    authState.users = [
      {
        id: USER_ID,
        email: EMAIL,
        active: true,
        sessionVersion: 2,
      },
    ];
    authState.token = await signSession({
      userId: USER_ID,
      sessionVersion: 1,
    });

    await expect(getSession()).resolves.toBeNull();
  });

  it("returns database-backed user data for a current session", async () => {
    authState.users = [
      {
        id: USER_ID,
        email: EMAIL,
        active: true,
        sessionVersion: 2,
      },
    ];
    authState.token = await signSession({
      userId: USER_ID,
      sessionVersion: 2,
    });

    await expect(getSession()).resolves.toEqual({
      userId: USER_ID,
      email: EMAIL,
      sessionVersion: 2,
    });
  });
});
