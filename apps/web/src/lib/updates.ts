import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * Directory shared with the optional compose updater profile. The app mounts
 * it whether or not the profile is running, so this only says the channel
 * exists, never that anybody is listening on the other end: for that, read
 * the heartbeat with `readUpdaterState`.
 */
export function updateHelperDir(): string | null {
  const dir = process.env.UPDATE_TRIGGER_DIR;
  if (!dir || !existsSync(dir)) return null;
  return dir;
}

/** The sidecar touches this every loop; the app reads its age. */
export const HEARTBEAT_FILE = "updater-alive";
/** Where the sidecar reports what it is doing and how it ended. */
export const STATUS_FILE = "update-status";
/** What the Update button writes to ask for a pull. */
export const TRIGGER_FILE = "update-requested";

/**
 * How stale a heartbeat may be before the sidecar counts as gone. The loop
 * writes every 5 seconds, so this tolerates a few missed beats without
 * calling a container that died five minutes ago "running".
 */
export const HEARTBEAT_TTL_MS = 30_000;

/** Phases the sidecar reports, in order. `failed` ends the run too. */
export type UpdatePhase = "pulling" | "recreating" | "done" | "failed";

export type UpdateStatus = {
  phase: UpdatePhase;
  at: string;
  /** Last lines of the docker output when the run failed. */
  detail: string | null;
};

const PHASES: readonly UpdatePhase[] = ["pulling", "recreating", "done", "failed"];

/**
 * A heartbeat counts only while it is fresh. Kept pure and separate from the
 * filesystem so the rule the UI depends on is testable.
 */
export function isHeartbeatFresh(
  writtenAtMs: number | null,
  nowMs: number,
  ttlMs: number = HEARTBEAT_TTL_MS,
): boolean {
  if (writtenAtMs === null) return false;
  const age = nowMs - writtenAtMs;
  // A clock skew that puts the file in the future is still a live sidecar:
  // the container just wrote it.
  return age <= ttlMs;
}

/** Parses the sidecar's status file, tolerating a half-written one. */
export function parseUpdateStatus(raw: string): UpdateStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const phase = record.phase;
  if (typeof phase !== "string" || !PHASES.includes(phase as UpdatePhase)) {
    return null;
  }
  return {
    phase: phase as UpdatePhase,
    at: typeof record.at === "string" ? record.at : "",
    detail:
      typeof record.detail === "string" && record.detail.trim()
        ? record.detail.trim()
        : null,
  };
}

export type UpdaterState = {
  /** True when the sidecar's heartbeat is fresh: the button can pull. */
  running: boolean;
  /** Last heartbeat, so a stopped sidecar can say when it was last alive. */
  lastSeenAt: string | null;
  status: UpdateStatus | null;
};

/**
 * Whether the optional updater profile is actually running, straight from the
 * shared volume. A mounted directory is not enough: the compose file mounts it
 * on the app too, so only a fresh heartbeat proves the sidecar is there to act.
 */
export async function readUpdaterState(now = Date.now()): Promise<UpdaterState> {
  const dir = updateHelperDir();
  if (!dir) return { running: false, lastSeenAt: null, status: null };

  let lastSeenMs: number | null = null;
  try {
    const beat = await stat(join(dir, HEARTBEAT_FILE));
    lastSeenMs = beat.mtimeMs;
  } catch {
    lastSeenMs = null;
  }

  let status: UpdateStatus | null = null;
  try {
    status = parseUpdateStatus(await readFile(join(dir, STATUS_FILE), "utf8"));
  } catch {
    status = null;
  }

  return {
    running: isHeartbeatFresh(lastSeenMs, now),
    lastSeenAt: lastSeenMs === null ? null : new Date(lastSeenMs).toISOString(),
    status,
  };
}
