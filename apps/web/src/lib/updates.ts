import pkg from "../../package.json";

/** Version this instance is running, straight from the package manifest. */
export const APP_VERSION: string = pkg.version;

/** GitHub repo the opt-in update check reads releases from. */
export const UPDATE_REPO = process.env.UPDATE_REPO ?? "ustoppble/overclick";

export type ReleaseInfo = {
  version: string;
  changelog: string;
  url: string;
};

function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

/**
 * The single outbound request the Settings note describes: one GET to the
 * GitHub Releases API, only when the owner turned the check on. Cached for an
 * hour so browsing the board does not fan out requests. Returns null when the
 * instance is current, the request fails, or the payload is unusable.
 */
export async function checkForUpdate(): Promise<ReleaseInfo | null> {
  const res = await fetch(
    `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
    {
      headers: { accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    },
  ).catch(() => null);
  if (!res?.ok) return null;
  const json = (await res.json().catch(() => null)) as {
    tag_name?: unknown;
    body?: unknown;
    html_url?: unknown;
  } | null;
  const tag = json?.tag_name;
  if (typeof tag !== "string" || !isNewer(tag, APP_VERSION)) return null;
  return {
    version: tag,
    changelog: typeof json?.body === "string" ? json.body : "",
    url:
      typeof json?.html_url === "string"
        ? json.html_url
        : `https://github.com/${UPDATE_REPO}/releases`,
  };
}
