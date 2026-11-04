import type { DeployMode } from "./deploy-mode";

/**
 * The commands the UI offers, in their own module because both the server
 * pages and the client components show them, and everything else in
 * `updates.ts` reads the filesystem: importing that from a client component
 * drags `node:fs` into the browser bundle.
 *
 * Every command here is mode-aware (OCL-73). The root quickstart compose file
 * and the hosted `deploy/` compose file are two different projects on two
 * different `docker compose` invocations; the quickstart command run against
 * a hosted instance is the exact one that caused the OCL-43 incident. Picking
 * the command from the deploy mode the instance actually reports, instead of
 * a single command shown everywhere, is what keeps that from happening again.
 */

/**
 * What to run on the server to update a container instance: nothing in the app
 * restarts a container, so this is the only way (the old updater sidecar held
 * the docker socket, which is root on the host, and is gone). A hosted
 * instance only ever gets there through `./deploy/deploy.sh`: it holds
 * the deploy lock, pins the compose project and files, and guards against the
 * legacy-orphan collision OCL-43 fixed. The quickstart command matches the
 * documented install, a git checkout that builds its own image with the root
 * compose file.
 */
export function updateCommand(mode: DeployMode): string {
  return mode === "hosted" ? "./deploy/deploy.sh" : "git pull && docker compose up -d --build --remove-orphans";
}

/**
 * What updates an instance started from the checkout itself, `next dev` or a
 * built node process on the host. No container exists to pull or recreate, so
 * the code is refreshed in place and the process is restarted by whoever
 * started it. Mode-independent: a source checkout has no compose project.
 */
export const SOURCE_UPDATE_COMMAND =
  "git pull && pnpm install && pnpm --filter @agent-board/mcp-core build";
