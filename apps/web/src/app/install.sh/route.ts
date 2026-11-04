import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isPairingCode } from "../../lib/plugin-install";
import { publicOrigin } from "../../lib/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readInstaller() {
  return readFile(
    /* turbopackIgnore: true */ resolve(process.cwd(), "../../install.sh"),
    "utf8",
  );
}

/**
 * The address written into the script: the operator's configured
 * `OVERCLICK_PUBLIC_URL` (validated by `publicOrigin`: https, or http for a
 * local address, no credentials, origin only), never the request's Host or
 * x-forwarded-* — those are written by whoever sent the request, and a script
 * served with the caller's own address inside it is a script that sends the
 * pairing code wherever the caller said. Without the variable there is no
 * address we can vouch for, so no paired installer is generated and the plain
 * one, which asks, is served instead.
 */
function instanceUrl(): string | null {
  return publicOrigin();
}

/**
 * The installer, with the instance and a one-time pairing code already
 * answered.
 *
 * The two values go in as defaults, not as assignments: an operator who
 * exports OVERCLICK_INSTANCE_URL or OVERCLICK_TOKEN still wins, and the
 * script's own prompts still run when neither exists. They are inserted after
 * the shebang rather than before it, so a saved copy stays executable.
 */
function withPairing(script: string, url: string, code: string): string {
  const preamble = [
    "",
    "# overclick: this copy was served with a one-time pairing code.",
    "# The code is six digits, single use, and expires in ten minutes. It is not",
    "# a token: install.sh trades it on /api/pair for the real one and never",
    "# prints either. An exported OVERCLICK_TOKEN still takes precedence.",
    `OVERCLICK_INSTANCE_URL="\${OVERCLICK_INSTANCE_URL:-${url}}"`,
    `OVERCLICK_PAIRING_CODE="\${OVERCLICK_PAIRING_CODE:-${code}}"`,
    "export OVERCLICK_INSTANCE_URL OVERCLICK_PAIRING_CODE",
  ];
  const lines = script.split("\n");
  const at = lines[0]?.startsWith("#!") ? 1 : 0;
  return [...lines.slice(0, at), ...preamble, ...lines.slice(at)].join("\n");
}

export async function GET(request: Request) {
  const script = await readInstaller();
  const code = new URL(request.url).searchParams.get("code");
  const url = isPairingCode(code) ? instanceUrl() : null;
  const body = url === null || !isPairingCode(code)
    ? script
    : withPairing(script, url, code);

  return new Response(body, {
    headers: {
      // A pairing code is single use: a proxy holding this response for five
      // minutes would serve a spent code to the next person who asks.
      "Cache-Control": url === null ? "public, max-age=300" : "no-store, private",
      "Content-Disposition": 'inline; filename="install.sh"',
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
