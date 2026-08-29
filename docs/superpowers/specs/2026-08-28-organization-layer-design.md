# Organization layer — grouping projects and missions by business

**Status:** approved (2026-08-28)
**Repo:** overclick

## Problem

A single OverClick instance holds one workspace with dozens of projects (26 today).
Those projects belong to different businesses. The board, `project_list`, and every
filter treat them as one flat list, so the owner reads across unrelated businesses
on every screen and every agent call.

## Shape

A new entity sits between the workspace and its projects:

```
workspace (the instance)
 └─ organization        ← NEW (the business)
     ├─ project (repo)
     │   └─ task
     └─ mission
```

Not chosen, and why:

- **Multiple workspaces.** The isolation already exists, but a business boundary
  built on workspaces forces a workspace switch (and possibly a second MCP token)
  to see another business, and it touches auth, the board, and the whole MCP surface.
- **A `business` text tag on the project.** Cheap, but it is not an entity: no
  context of its own, no page, and missions cannot belong to it.

## Data model

New table `organization`:

| column | type | notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `workspace_id` | uuid not null | → `workspace.id`, `on delete cascade` |
| `name` | text not null | unique per workspace |
| `context` | text | markdown briefing for the business, max 32 000 chars |
| `created_at` / `updated_at` | timestamptz not null | |

`project.organization_id` and `mission.organization_id`: uuid **not null**,
→ `organization.id`, `on delete restrict`. Restrict, not cascade: deleting a
business must never silently destroy the repos under it.

### Migration `0031`

1. Create `organization`.
2. Insert one row per existing workspace, named `General`, with empty context.
3. Add the two nullable columns, backfill every project and mission with the
   `General` row of its workspace, then set them `not null` and attach the FKs.

No orphan state exists after this migration, and none can be created later.

## MCP

**New tools**

- `organization_list` → id, name, `has_context`, project/mission/card counts.
- `organization_get` → the above plus the `context` markdown.
- `organization_create` `{ name, context? }`.
- `organization_update` `{ organization_id, name?, context? }`.
- `organization_delete` `{ organization_id, reassign_to? }` — an organization
  holding projects or missions is refused with the counts that block it, unless
  `reassign_to` names the organization that inherits them. There is no `force`:
  the column is not nullable, so there is nothing to detach to.

**Changed tools**

- `project_create` and `mission_create` accept `organization` (uuid or name).
  Omitted, the server resolves it: exactly one organization in the workspace →
  that one; several → the call is refused with the list to pick from. Existing
  single-business installs keep working untouched; a multi-business one is told
  to choose instead of guessing.
- `project_update` and `mission_update` accept `organization` to move the row.
- `project_list`, `project_get`, `mission_list`, `mission_get` return
  `organization_id` and `organization_name`.
- `project_list`, `mission_list`, `task_list`, `task_search` accept an optional
  `organization` filter.
- The claim briefing renders the organization's context above the project block,
  so an agent working a card reads the business rules before the repo rules.

## Web

- **Board filter.** An organization selector next to the project filter. Picking
  organizations narrows the board *and* the project filter's options. Stored on
  `user` beside the existing board filter columns.
- **`/organizations` page.** One card per organization: its projects, its active
  missions, and aggregate telemetry (tokens and time) for the period, reusing the
  Insights aggregation so the numbers match.
- **Settings.** Create, rename, and delete organizations, and edit the context
  markdown with the same editor the project context uses.
- **Onboarding.** The wizard asks for the organization before the first project;
  a fresh instance still gets a working default without a question when skipped.

## Testing

- `packages/db`: migration applied against a scratch database leaves every
  project and mission pointing at `General`, and both columns `not null`.
- `packages/mcp-core`: schema round-trips for the five new tools and the changed
  inputs.
- `apps/web/src/mcp`: integration tests for create/update/list/delete, the
  ambiguity refusal when several organizations exist, the `reassign_to` path,
  and the briefing rendering the organization context.
- `apps/web`: the board filter narrows by organization, and the organizations
  page totals match the Insights totals for the same selection.
