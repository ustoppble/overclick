import { createHmac, timingSafeEqual } from "node:crypto";
import { project } from "@agent-board/db";
import { BODY_LIMITS, readBodyCapped } from "../../../../lib/body-limit";
import { db } from "../../../../lib/db";
import { applyProjectRelease } from "../../../../lib/project-context-refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReleaseWebhookBody = {
  action?: unknown;
  repository?: { full_name?: unknown };
  release?: {
    id?: unknown;
    tag_name?: unknown;
    name?: unknown;
    body?: unknown;
    prerelease?: unknown;
    published_at?: unknown;
    html_url?: unknown;
  };
  sender?: { login?: unknown };
};

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function sameRepo(left: string | null, right: string): boolean {
  return Boolean(left && left.trim().toLowerCase() === right.trim().toLowerCase());
}

/**
 * OCL-226: GitHub signs every delivery with the webhook's secret as
 * `sha256=<hex hmac of the raw body>`. The body is only trusted once that
 * signature matches the secret the board was given, and without a secret
 * nothing is trusted at all: an unsigned route let anyone on the internet
 * rewrite a project's context, which goes straight into agent briefings.
 */
function validSignature(secret: string, payload: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(payload).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Receives GitHub's release.published webhook for every configured project. */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return Response.json({ error: "github webhook secret is not configured" }, { status: 503 });
  }
  // The ceiling comes before the HMAC: the signature is computed over the whole
  // body, so an unbounded one would be buffered and hashed for any caller.
  const read = await readBodyCapped(request, BODY_LIMITS.githubRelease);
  if (!read.ok) {
    return Response.json({ error: "webhook body too large" }, { status: read.status });
  }
  const payload = read.text;
  if (!validSignature(secret, payload, request.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "invalid webhook signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  if (event && event !== "release") {
    return Response.json({ ignored: true });
  }

  let body: ReleaseWebhookBody | null = null;
  try {
    body = JSON.parse(payload) as ReleaseWebhookBody | null;
  } catch {
    body = null;
  }
  const repository = asText(body?.repository?.full_name);
  const release = body?.release;
  const tagName = asText(release?.tag_name);
  if (!repository || !release || !tagName) {
    return Response.json({ error: "release webhook payload is incomplete" }, { status: 400 });
  }
  if (body?.action && body.action !== "published") {
    return Response.json({ ignored: true });
  }

  const database = db();
  const projects = await database
    .select()
    .from(project);
  const actor = asText(body?.sender?.login) ?? "github-webhook";
  let updated = 0;
  for (const row of projects) {
    if (!sameRepo(row.contextSource?.releasesRepo ?? null, repository)) continue;
    const result = await applyProjectRelease(database, row, {
      id:
        typeof release.id === "string" || typeof release.id === "number"
          ? release.id
          : null,
      repository,
      tagName,
      name: asText(release.name),
      body: typeof release.body === "string" ? release.body : null,
      prerelease: release.prerelease === true,
      publishedAt: asText(release.published_at),
      url: asText(release.html_url),
    }, { actor });
    if (result.updated) updated += 1;
  }

  return Response.json({ ok: true, projects: updated });
}
