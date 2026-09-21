---
description: Claim an OverClick card and load its execution contract.
argument-hint: <card-id>
---

Load the bundled `overclick` skill and read its linked canonical `OVERCLICK.md`.
Treat `$ARGUMENTS` as the exact card ID. Call
`task_claim` once with the current CLI, exact model, and session identifier.
Return the claimed card's contract, branch convention, and first confirmation
step. Keep `measure.command` for delivery; fetch the project dossier with
`project_get` only if the work needs it. Do not begin repository work before the claim succeeds.
