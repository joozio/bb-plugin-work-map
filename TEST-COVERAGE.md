# Test coverage

This file records a pass that added unit tests to the pure-logic and service modules of the Work Map plugin. No application code changed.

## How it was measured

The tests use the repo's existing Vitest setup (`npm test`). Coverage came from `@vitest/coverage-v8` at the same version as Vitest (4.1.11). I installed it with `npm install --no-save`, so it is **not** in `package.json`. To reproduce:

```sh
npm ci
npm install --no-save @vitest/coverage-v8@4.1.11
npx vitest run --coverage --coverage.reportOnFailure
npm run typecheck
```

## Before and after

|                | Before        | After         |
| -------------- | ------------- | ------------- |
| Test files     | 22            | 25            |
| Tests          | 455 (1 failing) | 534 (all passing) |
| Statements     | 91.07%        | 93.28%        |
| Branches       | 87.44%        | 89.73%        |
| Functions      | 88.13%        | 89.50%        |
| Lines          | 92.50%        | 94.54%        |

Modules whose coverage changed (statements · branches · functions · lines):

| Module                   | Statements      | Branches        | Functions       | Lines           |
| ------------------------ | --------------- | --------------- | --------------- | --------------- |
| `delegate-service.ts`    | 71.06 → 99.37   | 52.11 → 100     | 68.18 → 100     | 72.97 → 99.32   |
| `management-cli.ts`      | 65.00 → 100     | 50.00 → 97.95   | 40.00 → 100     | 70.00 → 100     |
| `management.ts`          | 87.20 → 100     | 83.56 → 98.63   | 100 → 100       | 86.74 → 100     |
| `settlement.ts`          | 89.86 → 92.51   | 84.64 → 90.71   | 96.77 → 96.77   | 93.86 → 95.75   |
| `settlement-contract.ts` | 91.66 → 100     | 94.44 → 100     | 100 → 100       | 91.66 → 100     |
| `layout-motion.ts`       | 91.86 → 97.67   | 85.71 → 89.28   | 90.90 → 95.45   | 93.42 → 98.68   |
| `heat-memo.ts`           | 97.29 → 100     | 95.65 → 100     | 100 → 100       | 100 → 100       |
| `delegation.ts`          | 98.00 → 100     | 94.44 → 94.44   | 91.66 → 100     | 97.67 → 100     |

All other modules are unchanged. These were already at or near 100%: `model.ts`, `heat.ts`, `heat-timing.ts`, `heat-view.tsx`, `overview-layout.ts`, `zoom.ts`, `preview.ts`, `attention-age.ts` and `date-fixes.tsx`.

## What was added

### `delegate-service.test.ts` (new, 24 tests)
Before this pass, nothing tested the single-task **"Let agents decide"** path (`delegate`). The area path was tested only end to end through `server.ts`. These tests drive `delegationService` directly, on a hand-built `bb` with an in-memory kv that can be made to fail.
- **Handover order:** the comment is written before the dispatch. The dispatch carries the preset id and the brief, and a typed note is trimmed and appended to both. Only `in_review` is moved to `in_progress`, because Tasks moves backlog and todo itself.
- **Idempotency:** two clicks at the same moment start one agent. A restart replays the stored receipt without any RPC. A failed request can be retried with the same id. When kv refuses the receipt, the in-memory copy still blocks a second agent.
- **Guards:** a missing, done, canceled or stale (`expectedUpdatedAt`) task is refused, and nothing is written. An install with no preset gets an explanation.
- **Best-effort steps:** a failed comment or a failed status move does not stop the dispatch. The result reports it as `commented: false` / `movedFrom: null`.
- **Preset choice:** the stored choice wins, then `wiz`, then the first preset. A stale or wrongly shaped stored value falls back.
- **Orchestrator environment:** without a preset setting it uses `project-default`. A managed worktree goes on the primary host from the default branch, or on the preset's own machine and branch. The service tier is passed through. With no machine available, the error names the preset.
- **Area dispatch:** a deleted project is explained. A task that cannot be read is dropped as "could not be read". Different request ids for the same area share one dispatch while it is in flight, and a replay after a restart spawns nothing.
- **`liveOrchestrators`:** rows that cannot be parsed are skipped, and a kv list failure gives `[]`.

### `management-cli.test.ts` (new, 27 tests)
`runManagementCli` parses argv over injected services, so these tests use plain stubs.
- Output of `project list` as text and JSON (including the hidden marker and `No projects.`), and `--help`.
- `project create`: the prefix is uppercased, folder and workspace are resolved by name or id, `none` clears them, a request id is generated when not given and is echoed back, an ambiguous or unknown folder is refused, a blank value counts as missing, and a failure prints the request id to reuse.
- `project edit`: only the changed field is sent, together with the `expected` snapshot. It needs at least one field and an existing project.
- `project hide|restore`, `task create`, and `attach`: the task is found by key in any case or by id, from a fresh snapshot.
- A table of 11 malformed command lines: unknown verbs, duplicate flags, missing values, options that don't belong to the verb, and wrong argument counts. Each must fail before any service call.

### `settlement-handoff.test.ts` (new, 14 tests)
Tests for the pure `handoffDescription` rewrite and the `settleInput` contract.
- The exact output for a bare description (`done`), for a pause that keeps an existing `---` log and a session id, and for an empty description (its fallbacks).
- A typed next step is tidied and replaces the old one whatever its case, and is never duplicated. A pause on a task waiting on someone else is refused unless the next step is left blank.
- A review goes to the owner, or to me. An outside reviewer gets their wait, follow-up date and typed ask. Fields stay above a `## History` heading, and the old status reason is recorded except on a pause.
- Contract: an archive names a session only. Other actions need a task. An outside review needs a reviewer and a date. Only real calendar days are accepted (2026-02-29 is rejected, 2028-02-29 accepted). Ids are checked for format. Defaults are filled in.

### Additions to existing files
- **`management.test.ts`** (+6): edit and attach success paths, a task from another project, a deleted project, an unknown workspace, a prefix already in use, a request id that Tasks refused (`ok: false`) being freed so it can be reused, and one request id not being reused for different work. The setup gained two switches, `moveTask` and `refuseTask`.
- **`settlement.test.ts`** (+2): a deleted session or task is refused before any write. Receipt pruning keeps the newest 200 and keeps an old pending receipt for recovery.
- **`heat-memo.test.tsx`** (+3): direct tests of `holdLayout`. Held weights and order are kept while each tile shows its current values, and a change in which areas or tiles exist returns `null`.
- **`layout-motion.test.tsx`** (+3): `keyMovesLayout` with a non-element target or `null`, with `summary`, `role="button"` and `contenteditable="false"` targets, plus the `ResizeObserver` path of `useRevealChat` (re-reveal on resize, disconnect on close) and a chat outside an open card. `afterEach` now also calls `vi.unstubAllGlobals()`.

## Findings

1. **One test failed because of the date (test bug, now fixed).** `app.test.tsx` › *preserves attention channels while marking aged undated work* compares task age with the real `Date.now()`. Its other fixture tasks took their `createdAt` from the fixed `fixtures.ts` date, 2026-09-17. From 2026-10-17 onwards those tasks were more than 30 days old, so the "undated 30d+" count was 3 instead of 1. The fix gives those tasks a `createdAt` measured from the real clock, which matches how the test already sets up its aged task. The app is not at fault.
2. **Small CLI wording issue (left unchanged).** `task create` and `project create` set the request id before checking the rest of the input. If `--project` names a project that doesn't exist, or a folder or workspace can't be resolved, stderr still says "Request id: … Reuse it to recover a confirmed result", even though nothing was sent (`management-cli.ts:122` and `:154`). It does no harm, because reusing the id is safe, so I left it as it is.
3. No other bugs turned up: every new test passed against the existing code.

## Remaining gaps

These are mostly UI and integration surfaces, better covered by rendering or end-to-end tests than by unit tests:
- `app.tsx` (88% statements), `management-ui.tsx` (76%), `components/ui/icon.tsx` (76%), `map-zoom.tsx` (88%).
- `server.ts` (86% statements, 70% branches): RPC wiring and snapshot assembly on the host.
- `settlement.ts`: the remaining branches are rare recovery paths. Examples are an update response that doesn't match what was sent, a thread archived between the read and the archive call, and a recovery that fails inside `settledToday`.
