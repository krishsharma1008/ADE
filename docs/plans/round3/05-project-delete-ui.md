# Item #5 — Project Delete UI

Phase 11 of Round 3.

## Problem

Backend delete exists (`DELETE /projects/:id` in `server/src/routes/projects.ts:261-290`) and client method is wired (`ui/src/api/projects.ts:32` `projectsApi.remove`), but no UI button. Worse: `projects.remove` hard-deletes without cascading to `issues.projectId`, so any project with historical issues (open or closed) would trigger an FK failure on delete.

## Fix

### Server guard

Before delete, count ALL referencing issues (open + closed). If count > 0 and `req.query.force !== "true"`, return 409 with `{ code: "project_has_issues", issueCount, openCount }`. With `force=true`, reassign `issues.projectId = NULL` in a transaction, then delete the project; log `project.force_deleted`.

### Schema

Add `ON DELETE SET NULL` on `issues.project_id` FK (Phase 1 migration 0036) so a race between the count and the delete doesn't leave orphaned references.

### UI

Kebab menu on each `Projects.tsx` row → "Delete project" → modal. Copy: `Delete project X? It has N issues (M open).` Buttons: "Delete & unlink issues" (sends `?force=true`), "Cancel". Empty project: plain "Delete" button.

## Files

- Modify: `packages/db/src/schema/issues.ts`, `server/src/services/projects.ts:384`, `server/src/routes/projects.ts:261-290`, `ui/src/pages/Projects.tsx`, `ui/src/api/projects.ts`.
- New: `ui/src/components/DeleteProjectDialog.tsx`, `packages/db/src/migrations/0036_project_issue_cascade.sql`.

## Tests

- Unit: 409 without force on project with issues; force=true nulls issues + deletes + writes activity.
- Playwright: 5-issue project delete end-to-end.

## Codex P1 reminder

Guard must count ALL issues (not just open). Closed issues also FK-reference `projects.id`.
