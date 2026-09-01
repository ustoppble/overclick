#!/usr/bin/env node
// The one list of files that carry the release version (OCL-158).
//
// There are eleven of them and they do not agree on shape: the package.json
// family keeps `version` at the top level, while the two marketplace files
// keep it on the first entry of `plugins`. Before this file, the list lived
// twice — once in whoever was bumping by hand, once in
// verify-release-version.sh, which only knew about four of the eleven. A
// partial bump therefore passed the guard and shipped.
//
//   node scripts/release-manifests.mjs read           → "path<TAB>version" lines
//   node scripts/release-manifests.mjs write 0.3.7    → rewrites every file
//
// Writes preserve the file byte-for-byte apart from the version string, so a
// release commit stays readable as a one-line-per-file diff.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every manifest, with where the version sits inside it. */
export const MANIFESTS = [
  { path: "package.json", at: "top" },
  { path: "apps/web/package.json", at: "top" },
  { path: "packages/db/package.json", at: "top" },
  { path: "packages/mcp-core/package.json", at: "top" },
  { path: ".kimi-plugin/plugin.json", at: "top" },
  { path: "plugin/plugin.json", at: "top" },
  { path: "plugin/.claude-plugin/plugin.json", at: "top" },
  { path: "plugin/.codex-plugin/plugin.json", at: "top" },
  { path: "plugin/kimi.plugin.json", at: "top" },
  { path: ".claude-plugin/marketplace.json", at: "plugins" },
  { path: ".grok-plugin/marketplace.json", at: "plugins" },
];

function parse(manifest) {
  return JSON.parse(readFileSync(join(ROOT, manifest.path), "utf8"));
}

export function readVersion(manifest) {
  const json = parse(manifest);
  return manifest.at === "plugins" ? json.plugins?.[0]?.version : json.version;
}

/**
 * Replaces the version in place. A targeted regex rather than a reserialize:
 * `JSON.stringify` would reflow indentation and key order across eleven files
 * and bury the one line that actually changed.
 */
export function writeVersion(manifest, version) {
  const file = join(ROOT, manifest.path);
  const before = readFileSync(file, "utf8");
  const current = readVersion(manifest);
  if (current === undefined) {
    throw new Error(`${manifest.path} has no version to write`);
  }
  const needle = `"version": "${current}"`;
  if (!before.includes(needle)) {
    throw new Error(`${manifest.path} does not spell its version as ${needle}`);
  }
  const after = before.replace(needle, `"version": "${version}"`);
  if (after !== before) writeFileSync(file, after);
  return current;
}

const [command, argument] = process.argv.slice(2);

// A closed pipe (`... | head -3`) must never abort a run that is halfway
// through rewriting eleven files: a partial bump is the exact state the
// release guard exists to catch, and it would be caused here by the progress
// printing rather than by anything real.
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") throw error;
});

function report(line) {
  try {
    process.stdout.write(line);
  } catch {
    // Same reason: reporting is never worth failing the write for.
  }
}

if (command === "read") {
  for (const manifest of MANIFESTS) {
    report(`${manifest.path}\t${readVersion(manifest)}\n`);
  }
} else if (command === "write") {
  if (!argument) {
    process.stderr.write("!! write needs a version\n");
    process.exit(1);
  }
  for (const manifest of MANIFESTS) {
    const was = writeVersion(manifest, argument);
    report(`   ${manifest.path}: ${was} -> ${argument}\n`);
  }
} else if (command !== undefined) {
  process.stderr.write(`!! unknown command ${command}\n`);
  process.exit(1);
}
