import { spawnSync } from "node:child_process";
import { readStdin } from "./common.mjs";

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function git(args, capture = false) {
  const result = spawnSync("git", args, {
    stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
    encoding: "utf8",
    windowsHide: true,
  });
  return { ok: result.status === 0 && !result.error, stdout: result.stdout ?? "" };
}

const hookInput = readStdin();
const commit = hookInput.match(/[0-9a-fA-F]{40}/)?.[0] ?? "";

if (!commit) {
  refuse("OverClick delivery evidence must cite the full Git commit ID.");
}

if (!git(["rev-parse", "--is-inside-work-tree"]).ok) {
  refuse("OverClick could not verify the delivered commit outside a Git worktree.");
}

if (!git(["cat-file", "-e", `${commit}^{commit}`]).ok) {
  refuse("The commit cited in OverClick delivery evidence is not present locally.");
}

if (!git(["fetch", "--all", "--quiet", "--prune"]).ok) {
  refuse("OverClick could not refresh remote refs to verify the delivered commit.");
}

const remotes = git(["for-each-ref", `--contains=${commit}`, "--format=%(refname)", "refs/remotes"], true);
if (!remotes.ok || !remotes.stdout.trim()) {
  refuse("The commit cited in OverClick delivery evidence is not present on a remote branch.");
}

process.exit(0);
