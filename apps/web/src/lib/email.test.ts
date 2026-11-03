import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resendState = vi.hoisted(() => ({
  send: vi.fn(async (_message: Record<string, unknown>) => ({
    data: { id: "email-id" },
    error: null as null | { message: string },
  })),
  keys: [] as string[],
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendState.send };
    constructor(key: string) {
      resendState.keys.push(key);
    }
  },
}));

const { emailConfigured, sendEmail } = await import("./email");

const MESSAGE = {
  to: "person@local.test",
  subject: "Subject",
  text: "Body 123456",
};

describe("email", () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    resendState.send.mockClear();
    resendState.keys.length = 0;
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logged.mockRestore();
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  it("is not configured until both variables are set", () => {
    expect(emailConfigured()).toBe(false);
    process.env.RESEND_API_KEY = "test-key";
    expect(emailConfigured()).toBe(false);
    process.env.EMAIL_FROM = "Board <board@local.test>";
    expect(emailConfigured()).toBe(true);
  });

  it("refuses to send without configuration, and logs it without the recipient or the body", async () => {
    await expect(sendEmail(MESSAGE)).resolves.toBe(false);
    expect(resendState.send).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    const output = JSON.stringify(logged.mock.calls);
    expect(output).not.toContain(MESSAGE.to);
    expect(output).not.toContain("123456");
  });

  it("sends through Resend from EMAIL_FROM", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "Board <board@local.test>";

    await expect(sendEmail(MESSAGE)).resolves.toBe(true);
    expect(resendState.keys).toEqual(["test-key"]);
    expect(resendState.send).toHaveBeenCalledWith({
      from: "Board <board@local.test>",
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    });
  });

  it("answers false and logs without the recipient, the body or the key when Resend refuses", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "Board <board@local.test>";
    resendState.send.mockResolvedValueOnce({
      data: null as never,
      error: { message: "domain not verified" },
    });

    await expect(sendEmail(MESSAGE)).resolves.toBe(false);
    const output = JSON.stringify(logged.mock.calls);
    expect(output).not.toContain(MESSAGE.to);
    expect(output).not.toContain("123456");
    expect(output).not.toContain("test-key");
  });

  it("answers false instead of throwing when the call itself fails", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "Board <board@local.test>";
    resendState.send.mockRejectedValueOnce(new Error("network down"));

    await expect(sendEmail(MESSAGE)).resolves.toBe(false);
    expect(logged).toHaveBeenCalled();
  });
});
