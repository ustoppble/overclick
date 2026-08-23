import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandFor } from "./commands";

const URL = "https://board.example/api/mcp";
const SECRET = "ocb_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const RUNNABLE = ["claude-code", "codex", "gemini-cli"];

/**
 * The command is copied into a terminal we do not control: it may be bash or
 * PowerShell. These are the constructs that only work in one of them.
 */
describe.each(RUNNABLE)("commandFor(%s)", (cli) => {
  const command = commandFor(cli, URL, SECRET);

  it("is a single line, because a trailing backslash means nothing in PowerShell", () => {
    expect(command).not.toContain("\n");
    expect(command).not.toContain("\\");
  });

  it("uses no heredoc, no ~ and no cat >>, which PowerShell does not have", () => {
    expect(command).not.toContain("<<");
    expect(command).not.toContain("~");
    expect(command).not.toContain("cat >>");
  });

  it("carries nothing either shell would expand inside double quotes", () => {
    // `$` expands in both; the backtick is command substitution in bash and
    // the escape character in PowerShell.
    expect(command).not.toContain("$");
    expect(command).not.toContain("`");
    // `!` is history expansion in an interactive bash, even inside quotes.
    expect(command).not.toContain("!");
  });

  it("carries the instance and the token", () => {
    expect(command).toContain(URL);
    expect(command).toContain(SECRET);
  });
});

describe("commandFor(claude-code) / commandFor(gemini-cli)", () => {
  it("adds the remote server in one `mcp add` call with the auth header", () => {
    expect(commandFor("claude-code", URL, SECRET)).toBe(
      `claude mcp add --transport http overclick ${URL} --header "Authorization: Bearer ${SECRET}"`,
    );
    expect(commandFor("gemini-cli", URL, SECRET)).toBe(
      `gemini mcp add --transport http overclick ${URL} --header "Authorization: Bearer ${SECRET}"`,
    );
  });
});

describe("commandFor(codex)", () => {
  // `codex mcp add` has no --header flag, so the config.toml is written
  // directly — by node, not by a bash heredoc.
  const command = commandFor("codex", URL, SECRET);

  it("is a node one-liner, not a shell built-in", () => {
    expect(command.startsWith('node -e "')).toBe(true);
    expect(command.endsWith('"')).toBe(true);
  });

  /** Runs the emitted script the way a shell would, against a fake CODEX_HOME. */
  function run(home: string): string {
    const script = command.slice('node -e "'.length, -1);
    execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: "pipe",
    });
    return readFileSync(join(home, "config.toml"), "utf8");
  }

  it("writes the overclick server into CODEX_HOME/config.toml", () => {
    const written = run(mkdtempSync(join(tmpdir(), "codex-")));

    expect(written).toContain("[mcp_servers.overclick]");
    expect(written).toContain(`url = "${URL}"`);
    expect(written).toContain(
      `http_headers = { Authorization = "Bearer ${SECRET}" }`,
    );
  });

  it("keeps whatever else the config already held", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-"));
    writeFileSync(join(home, "config.toml"), 'model = "gpt-5"\n');

    expect(run(home)).toContain('model = "gpt-5"');
  });

  it("replaces its own block instead of appending a second one", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-"));
    run(home);
    const written = run(home);

    expect(written.split("[mcp_servers.overclick]").length - 1).toBe(1);
    expect(written.split("# overclick:start").length - 1).toBe(1);
  });
});

describe("commandFor(anything else)", () => {
  it("is a comment block, which `#` opens in bash and PowerShell alike", () => {
    const lines = commandFor("outro", URL, SECRET).split("\n");

    expect(lines.every((line) => line.startsWith("#"))).toBe(true);
    expect(lines.join("\n")).toContain(`Authorization: Bearer ${SECRET}`);
  });
});
