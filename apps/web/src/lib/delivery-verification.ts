import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  hardenedGitConfig,
  parseHttpsRemote,
  resolvePublicRemote,
  type PinnedRemote,
} from "./remote-guard";

const execFile = promisify(execFileCallback);

/** Stable copy shown to a reviewer when a delivery cannot be proved remote. */
export const DELIVERY_UNVERIFIED_WARNING = "commit não encontrado no remoto";
const CHECK_UNAVAILABLE_WARNING =
  "não foi possível verificar o remoto; confira o acesso ao repositório e tente novamente";

export type DeliveryVerificationStatus = "verified" | "unverified" | null;

export type DeliveryVerificationResult = {
  status: DeliveryVerificationStatus;
  unverified: boolean;
  warning: string | null;
};

type JsonRecord = Record<string, unknown>;

type VerifyDependencies = {
  fetch?: typeof fetch;
  git?: (args: string[]) => Promise<string>;
  /** Host name to addresses; replaced in tests. */
  lookup?: (host: string) => Promise<string[]>;
  githubToken?: string | null;
};

const VERIFIED: DeliveryVerificationResult = {
  status: "verified",
  unverified: false,
  warning: null,
};

const NOT_CHECKED: DeliveryVerificationResult = {
  status: null,
  unverified: false,
  warning: null,
};

function unverified(warning = DELIVERY_UNVERIFIED_WARNING): DeliveryVerificationResult {
  return {
    status: "unverified",
    unverified: true,
    warning,
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function asSha(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizedBranch(value: string): string {
  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/origin\//, "");
}

function matchesSha(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const wanted = expected.trim().toLowerCase();
  return actual === wanted || actual.startsWith(wanted);
}

function githubRepository(repoUrl: string): { owner: string; repo: string } | null {
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(repoUrl.trim());
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] };
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    // A credential embedded in a project URL is not sent to the GitHub API.
    if (parsed.username || parsed.password) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    const owner = parts[0];
    const repo = parts[1]?.replace(/\.git$/, "");
    return owner && repo ? { owner, repo } : null;
  } catch {
    return null;
  }
}

/** A path on this machine or a file:// url: a local checkout, never a remote. */
function isLocalCheckout(value: string): boolean {
  return /^file:/i.test(value) || /^(\/|\.{1,2}\/|~|\\|[a-z]:[\\/])/i.test(value);
}

function githubHeaders(workspaceToken?: string | null): HeadersInit {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
  };
  // The token is read for the request only and is never part of a returned
  // error or diagnostic. Public repositories work without it.
  const token = workspaceToken?.trim() || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function githubJson(
  url: string,
  fetchImpl: typeof fetch,
  token?: string | null,
): Promise<{ status: number; body: JsonRecord | null }> {
  try {
    const response = await fetchImpl(url, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { status: response.status, body: null };
    return { status: response.status, body: asRecord(await response.json()) };
  } catch {
    return { status: 0, body: null };
  }
}

async function verifyGithub(
  repo: { owner: string; repo: string },
  commit: string,
  branch: string,
  fetchImpl: typeof fetch,
  token?: string | null,
): Promise<DeliveryVerificationResult> {
  const root = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const commitRow = await githubJson(
    `${root}/commits/${encodeURIComponent(commit)}`,
    fetchImpl,
    token,
  );
  const commitSha = asSha(commitRow.body?.sha);
  if (!commitSha || !matchesSha(commitSha, commit)) {
    // A private repository without access is also a 404. Only call the
    // commit missing after proving that this credential can see the repo.
    if (commitRow.status === 404 || commitRow.status === 422) {
      const repository = await githubJson(root, fetchImpl, token);
      if (repository.status === 200 && repository.body) return unverified();
    }
    return unverified(CHECK_UNAVAILABLE_WARNING);
  }

  const branchName = normalizedBranch(branch);
  if (!branchName) return unverified();
  const branchRow = await githubJson(
    `${root}/branches/${encodeURIComponent(branchName)}`,
    fetchImpl,
    token,
  );
  if (branchRow.status === 404) return unverified();
  const branchSha = asSha(asRecord(branchRow.body?.commit)?.sha ?? branchRow.body?.sha);
  if (matchesSha(branchSha, commitSha)) return VERIFIED;
  if (!branchSha) return unverified(CHECK_UNAVAILABLE_WARNING);

  // A branch may have moved on since the delivered commit. GitHub's compare
  // endpoint answers the ancestry question without cloning the repository.
  const comparison = await githubJson(
    `${root}/compare/${encodeURIComponent(commit)}...${encodeURIComponent(branchName)}`,
    fetchImpl,
    token,
  );
  const status = comparison.body?.status;
  if (status === "ahead" || status === "identical") return VERIFIED;
  if (status === "behind" || status === "diverged") return unverified();
  return unverified(CHECK_UNAVAILABLE_WARNING);
}

async function defaultGit(args: string[]): Promise<string> {
  const result = await execFile("git", args, {
    timeout: 15_000,
    maxBuffer: 512 * 1024,
    windowsHide: true,
    // Nothing of the server's environment (tokens, askpass, ssh agent) reaches
    // a git that talks to an address a person typed; https and no prompt only.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: tmpdir(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "https",
    },
  });
  return result.stdout;
}

function outputLines(raw: string): Array<{ sha: string; ref: string }> {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/, 2))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([sha, ref]) => ({ sha: sha.toLowerCase(), ref }));
}

async function verifyGeneric(
  repoUrl: string,
  pin: PinnedRemote,
  commit: string,
  branch: string,
  run: (args: string[]) => Promise<string>,
): Promise<DeliveryVerificationResult> {
  const branchName = normalizedBranch(branch);
  if (!branchName) return unverified();
  const config = hardenedGitConfig(pin);
  const git = (args: string[]) => run([...config, ...args]);

  try {
    const advertised = outputLines(
      await git(["ls-remote", "--refs", "--", repoUrl, `refs/heads/${branchName}`]),
    );
    const branchHead = advertised.find(
      (line) => line.ref === `refs/heads/${branchName}`,
    )?.sha;
    if (matchesSha(branchHead ?? null, commit)) return VERIFIED;

    // The branch can contain an older commit that is not its tip. Fetch only
    // the requested branch and omit blobs, then ask Git whether the commit is
    // an ancestor. A conservative failure remains an accepted, flagged handoff.
    const temp = await mkdtemp(join(tmpdir(), "overclick-delivery-"));
    try {
      await git(["-C", temp, "init", "--quiet"]);
      try {
        await git([
          "-C",
          temp,
          "fetch",
          "--no-tags",
          "--filter=blob:none",
          "--",
          repoUrl,
          `refs/heads/${branchName}`,
        ]);
      } catch {
        await git([
          "-C",
          temp,
          "fetch",
          "--no-tags",
          "--depth=256",
          "--",
          repoUrl,
          `refs/heads/${branchName}`,
        ]);
      }
      await git(["-C", temp, "cat-file", "-e", "--", `${commit}^{commit}`]);
      await git([
        "-C",
        temp,
        "merge-base",
        "--is-ancestor",
        "--",
        commit,
        "FETCH_HEAD",
      ]);
      return VERIFIED;
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    return unverified();
  }
}

/**
 * Verifies a delivery when the project has a remote. A project without a
 * remote is deliberately not checked: there is no claim to make about where
 * its commit should be reachable. All remote failures are advisory so a
 * network outage never destroys an otherwise useful handoff.
 */
export async function verifyDelivery(
  input: {
    repoUrl?: string | null;
    commit?: string | null;
    branch?: string | null;
  },
  dependencies: VerifyDependencies = {},
): Promise<DeliveryVerificationResult> {
  const repoUrl = input.repoUrl?.trim();
  if (!repoUrl) return NOT_CHECKED;
  const commit = input.commit?.trim();
  const branch = input.branch?.trim();
  if (!commit || !branch) return unverified();

  const github = githubRepository(repoUrl);
  if (github) {
    return verifyGithub(github, commit, branch, dependencies.fetch ?? fetch, dependencies.githubToken);
  }
  // A checkout registered by path or file:// is not a remote: nothing to prove,
  // and git is never pointed at the server's own disk.
  if (isLocalCheckout(repoUrl)) return NOT_CHECKED;

  // Anything else is a network request the server makes on a typed address:
  // https only, and only to a public address (see remote-guard).
  const remote = parseHttpsRemote(repoUrl);
  if (!remote) return unverified(CHECK_UNAVAILABLE_WARNING);
  const pin = await resolvePublicRemote(remote, dependencies.lookup);
  if (!pin) return unverified(CHECK_UNAVAILABLE_WARNING);
  return verifyGeneric(remote.href, pin, commit, branch, dependencies.git ?? defaultGit);
}
