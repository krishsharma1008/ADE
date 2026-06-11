# Onboarding a Repo for Agent Work

One page: what to do before agents take real tickets on a new repository. Validated by the 2026-06 engagement (two repos onboarded, third following this list).

## Checklist

1. **CI must exist.** The merge gate consumes GitHub check-runs; with zero checks, `ciStatus` is `unknown` and (unless `COMBYNE_GITHUB_MERGE_ALLOW_UNKNOWN_CI=true`) merges block — and with the override, nothing catches a bad PR. Add a workflow that runs the repo's tests on every PR (see `fs-brick-service-test` PR #7 for the JDK-17 Gradle template). *The one bug that reached staging during testing did so on a CI-less repo.*
2. **Add the project workspace** (Projects → workspace) with the repo URL. The agent push allowlist derives from project repo URLs — no extra config unless you need cross-repo pushes (`COMBYNE_ALLOWED_PUSH_REMOTE_PATTERNS`).
3. **Merge bases:** the repo's default branch is allowed automatically. If PRs target anything else (e.g. `staging` on a `main`-default repo), set `allowedMergeBases` in the workspace metadata.
4. **Local toolchain:** whatever the repo needs to run its tests must exist on the host (the BukuWarung Java repos need JDK 17: `brew install openjdk@17`; Gradle ≤7.x cannot run on JDK 18+). Agents run the same shell you do.
5. **Seed the memory rail (10–15 entries).** Recall starts cold on a new repo. Seed verified, service-scoped entries for what the code *doesn't* say: build/toolchain gotchas, branch/merge conventions, load-bearing patterns ("the global exception advice is relied on by all X endpoints"), deprecations ("never add consumers to flow Y"). Write them via Memory → Capture (or the board entries API with `serviceScope` = the repo slug) so they land **verified**. Don't bulk-embed code chunks — passdown budgets are tiny (top-3 entries for small tickets) and chunks crowd out the sharp facts. The 2026-06 seeding hit 16/16 top-3 recall with 15 curated entries.
6. **Canary ticket.** Run one genuinely small, throwaway ticket end-to-end (delegate → PR → merge) before real work. It validates clone access, push rights, CI wiring, merge gating, and recall in one pass.

## Operational env (per dev instance)

| Var | Why |
|---|---|
| `COMBYNE_USAGE_PAUSE_ENABLED=true` | Claude usage limit mid-ticket → run parks (lock held, session preserved) and auto-resumes the same conversation when the window resets |
| `COMBYNE_MAX_TURNS_CONTINUATION_ENABLED=true` | Turn-budget exhaustion with git-measured progress → warm continuation instead of a blocked issue |
| `COMBYNE_CONTEXT_DATABASE_URL` | The shared team rail. If it goes down, runs fail fast and re-deliver; the UI shows a "shared context rail unreachable" banner |

## What you should expect after onboarding

Small tickets: zero-touch to a ready PR. Medium: same, occasionally one question routed to you. Your only standing job is reviewing and merging from the dashboard PR panel — the merge is what closes the ticket and what writes the verified "accepted pattern" memory other agents learn from.
