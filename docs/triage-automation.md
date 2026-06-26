# Triage Delegation Automation

This document describes the GitHub Actions automation that keeps the
[Besu Triage intake queue][triage-board] clean by automatically marking
issues as **Delegated** once they have been assigned to another project.

[triage-board]: https://github.com/orgs/besu-eth/projects/3/views/2?filterQuery=status%3ATriage+is%3Aopen

---

## How it works

The Besu Triage project (org project #3) acts as the intake queue for issues
across the `besu-eth` organisation.  New issues are automatically assigned
`Status = Triage`.  When a triager decides to hand an issue off to a product
team they add it to the appropriate team project.

The automation detects this delegation by checking whether an issue that still
has `Status = Triage` in the Besu Triage project also appears in any other
project.  If it does, the automation updates its Status to **Delegated** so it
no longer matches the intake-queue filter (`status:Triage is:open`).

If the **Delegated** option does not exist in the project's Status field the
item is removed from the Triage project entirely instead.

---

## Files

| Path | Purpose |
|------|---------|
| `.github/workflows/triage-delegation.yml` | GitHub Actions workflow definition |
| `scripts/triage-delegation.js` | Node.js script — GitHub GraphQL API calls |
| `docs/triage-automation.md` | This document |

---

## Triggers

The workflow runs on:

1. **Hourly schedule** — scans all `Status = Triage` items in the project and
   checks each one for membership in other projects.

2. **`workflow_dispatch`** — manual scan for testing or backfill (supports a
   `dry_run` input).

GitHub exposes a `projects_v2_item` webhook event when project items change,
but that event **cannot** be used as a native GitHub Actions workflow trigger.
Near-real-time updates would require an org webhook that forwards payloads via
`repository_dispatch` (not currently configured).

---

## Required secret

Create a repository secret named **`TRIAGE_AUTOMATION_TOKEN`** in
`besu-eth/governance` (Settings → Secrets and variables → Actions).

The token must have permission to **read and write** the Besu Triage project
and to **read org data**.

### Classic PAT (recommended for simplicity)

Scopes needed:

- `read:org`
- `project`

### Fine-grained PAT

Organisation permissions:

- **Projects** → Read and write

Repository access: the token does not need direct repository access since it
only reads and writes project data, but the fine-grained PAT must be authorised
for the `besu-eth` organisation.

---

## Configuration

All behaviour is controlled via environment variables in the workflow file
(`.github/workflows/triage-delegation.yml`):

| Variable | Default | Description |
|----------|---------|-------------|
| `ORG_LOGIN` | `besu-eth` | GitHub organisation login |
| `TRIAGE_PROJECT_NUMBER` | `3` | Project number for the Besu Triage intake board |
| `TRIAGE_STATUS` | `Triage` | Status option name that identifies intake items |
| `DELEGATED_STATUS` | `Delegated` | Status option name to set when an item is delegated |
| `DRY_RUN` | `false` | Set to `true` to log actions without applying changes |

---

## Project setup

For the best experience, add a **Delegated** option to the Status field in the
Besu Triage project.  If this option is absent the automation still works — it
removes the item from the project instead — but a **Delegated** option lets
maintainers review historical delegation data.

Recommended Status field options (in order):

| Option | Meaning |
|--------|---------|
| Triage | Newly received; not yet reviewed |
| Needs info | Blocked waiting on the reporter |
| Delegated | Handed off to a product team project |
| Accepted | Confirmed as in-scope but not yet delegated |
| Done | Closed; no further action needed |

---

## Permissions model

The workflow itself requests only `contents: read`.  All project access is
handled by the `TRIAGE_AUTOMATION_TOKEN` PAT.  This follows the principle of
least privilege: the default `GITHUB_TOKEN` is never given project write
access.

---

## Troubleshooting

**The workflow fails with "Project #3 not found"**
- Confirm `TRIAGE_PROJECT_NUMBER` matches the actual project number.
- Confirm the token has `project` scope / Projects read access for the org.

**Items are not being delegated**
- Verify the target project is in the same `besu-eth` organisation.
- Run a manual `workflow_dispatch` with `dry_run = true` and check the logs.

**"Delegated option not found" warning**
- The Status field in the Triage project does not have a **Delegated** option.
- Either add one (recommended) or leave it as-is — items will be removed from
  the project instead.
