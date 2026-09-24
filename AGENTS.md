# AGENTS.md — task-tracker

Notes for any agent (or human) working on this repo, covering conventions that aren't obvious
from the code alone. Read this before touching tagging, Plane sync, or the task `type` field.

## Layout

- `webapp/server.py` — stdlib HTTP server, entry point.
- `webapp/app/` — core domain: `constants.py` (statuses/priorities/types, Plane-eligibility
  rules), `models.py`, `storage.py` (reads/writes `tasks.json`), `activity.py`.
- `webapp/routes/` — HTTP handlers (`tasks.py`, `plane.py`, `meta.py`, `ai.py`, `export.py`).
- `webapp/plane/` — all Plane API integration (`client.py`, `sync.py`, `labels.py`, `mapper.py`).
- `webapp/static/js/` — the **real** frontend, loaded as ES modules from `static/index.html` via
  `<script type="module" src="/js/main.js">`.
  - **`webapp/static/app.js` (root-level, not under `js/`) is dead code.** It's never referenced
    by `index.html` and never loads. Do not edit it — edit the matching file under `static/js/`
    instead. (This has bitten an agent before: changes went in silently and never rendered.)
- `tasks.json` (repo root) — the flat-file DB. Gitignored. Back it up
  (`cp tasks.json tasks.json.bak_before_<thing>_<timestamp>`) before any bulk/scripted edit.

## Adding a new status (e.g. "Blocker")

Statuses are **not** fully data-driven end to end — most of the app reads `app/constants.py:
STATUSES` dynamically (frontend `state.statuses` is overwritten from `GET /api/meta` on load, and
every dropdown/kanban-column/count in `static/js/views.js` iterates `state.statuses`), but the
**status filter chips are hardcoded markup** in `static/index.html` (`<span class="chip"
data-filter="...">`). Adding a status to `STATUSES` alone will NOT give it a filter chip — you
must add the `<span>` by hand in `index.html` too, in the same position as `STATUS_ORDER` in
`static/js/state.js` (this was missed once and the new status silently had no chip despite
counting correctly everywhere else).

Full checklist for a new local status, using "Blocker" (added 2026-09-24) as the example:
1. `app/constants.py`: add to `STATUSES`, and to `PLANE_ACTIVE_WORK_STATUSES` if it represents
   active/open work (controls whether `roll_open_tasks_to_current_cycle` sweeps it into the
   current Plane cycle).
2. `static/js/state.js`: add entries to `STATUS_ORDER`, `STATUS_DOT`, `ACTIVE_WORK_STATUSES` (this
   one gates what shows up in the daily standup "active work" grouping in `updates.js`), and the
   default `statuses` array.
3. `static/index.html`: add the chip `<span>` — this is the step that's easy to forget.
4. `static/style.css`: add `.status-tone-<Name>` and `.status-col-<Name>` (kanban column tint).
5. If it should map to a Plane state: add `"<Status>": "<Plane state name>"` to `status_map` in
   `webapp/plane_config.json` (the state must already exist in that file's `states` dict — get the
   exact name/id from Plane, e.g. via the workspace's state list). No code change needed —
   `plane_state_id()` in `plane/mapper.py` reads `status_map` + `states` directly.
6. Restart the server (`app/constants.py` is only read at import time).
7. `nextWorkflowStatus()` in `static/js/views.js` (the kanban card's single-click "advance" button)
   is a deliberately separate, hardcoded linear list — a side-state like Blocker or Cancelled
   should NOT be added to it, since "advance" should keep skipping straight through to the next
   real workflow stage.

## Task `type` vs `tags` — two independent axes

- `type` (`app/constants.py: TYPES`, currently `["Task", "Review", "Bug"]`) is a **local-only**
  UI classification. It drives the type dropdown, the type tag chip on cards
  (`.type-review` / `.type-bug` in `static/style.css`), and is one of the OR-conditions in
  `isBugModuleTask()` (`static/js/utils.js`) for the "🐛 Bugs" filter/badge.
- `tags` (freeform, e.g. `"Bug"`, `"Incident"`, `"Slack Bug"`) is what actually drives **Plane**
  module membership, via `is_slack_bug_incident_task(tags)` in `app/constants.py`.
- **These are deliberately decoupled.** Setting `type: "Bug"` on a task does NOT touch Plane, and
  is not read by `is_slack_bug_incident_task()`. Conversely, a task can carry a `"Bug"` tag (and
  sync to the Plane module) without ever having `type: "Bug"` set — most historical bug tasks are
  like this (tag-marked, not type-marked). **Do not merge these two checks in the backend.** The
  user was explicit about this: local classification changes freely, Plane-side behavior for
  existing tag-driven tasks stays exactly as it is.
- Practical effect: `isBugModuleTask()` (frontend, used only for local display/filtering) checks
  `type === "Bug" OR tags include "Bug"/"Slack Bug"` — broader, for UI purposes only.
  `is_slack_bug_incident_task()` (backend, the actual Plane-sync gate) checks tags only — kept
  narrow and unchanged.

## Plane module sync ("slack bug / incident")

- `PLANE_BUG_MODULE_NAME = "slack bug / incident"` (`app/constants.py`) — matched by name via the
  Plane API at sync time, not a hardcoded id (module ids differ per workspace/project).
- Eligibility: `is_slack_bug_incident_task(tags)` → `"Slack Bug" in tags or "Bug" in tags`. This
  was broadened mid-session from requiring `"Bug" AND "Incident"` together, after confirming a
  bare `"Bug"` tag should be sufficient. Any future narrowing/widening of this rule is a
  Plane-sync behavior change — confirm with the user first, it's the single source of truth for
  which issues land in that module.
- Two-way sync lives in `webapp/plane/sync.py`:
  - `sync_module_membership(cfg, task)` — compares desired (`is_slack_bug_incident_task`) vs
    current (`bool(task.plane_module_id)`), calls `assign_module_to_issue` /
    `remove_module_from_issue` as needed. Never raises.
  - `sync_task_cycle(cfg, task)` — for linked, non-closed tasks, moves the issue into whatever
    Plane cycle is currently active if it's not already there.
  - Both run **unconditionally** inside `sync_plane_on_activity()`, before the "meaningful
    activity" check that gates the core-field push + diff comment. This matters: a tag-only edit
    (e.g. adding `"Bug"`) produces no activity-log entry, so if module/cycle sync were gated
    behind that check (as they originally were), tagging a task would silently never sync to
    Plane. Keep module/cycle sync unconditional if you touch this function again.
  - `apply_plane_auto_sync()` (called from every task PATCH route in `routes/tasks.py`) returns
    `(task, changed)` — callers must `save_tasks(data)` again when `changed` is true, since the
    mutation happens in-memory on the task dict.
  - The **cookie-session API** (not the PAT/v1 API) is required for the modules endpoint
    (`POST /issues/{id}/modules/`, needs `force_cookie=True` — 404s on PAT). Cycle-issues
    (`POST /cycles/{id}/cycle-issues/`) works fine on either.
  - Quirk: the cycle-issues POST response returns Plane's **full current member list** for that
    cycle, not just the newly-added issue — don't mistake that for a bug. Also, a Plane issue's
    own GET-detail response has no `cycle`/`cycle_id` field at all (cycle membership is a separate
    relation), so verify cycle writes by checking the cycle-issues response's `issues` array, not
    the issue detail.
- `create_plane_issue()` also assigns the module (and cycle) **at creation time** if the task
  already qualifies — don't rely on a follow-up PATCH to pick that up.
- If you ever add a bulk "backfill" script/endpoint for module or cycle membership (there's
  already `POST /api/plane-module-backfill`), remember it needs to persist via `save_tasks()`
  same as the per-task path.

## Cycle rollover

- Plane cycles are weekly and don't auto-roll open issues into the new one. `roll_open_tasks_to_current_cycle()` (`plane/sync.py`, exposed as `POST /api/plane-cycle-rollover`) handles
  moving any open, linked task into whatever cycle is currently active.
- The frontend calls this automatically at most once/day (`maybeAutoSyncCycles()` in
  `static/js/plane.js`, gated on a `localStorage` date check) plus on-demand via the "🔁 Sync
  cycles" button. `sync_task_cycle()` (above) is the per-task version that also runs on every
  PATCH, so in practice cycle drift gets caught two ways: immediately on task edits, and once a
  day as a sweep for anything untouched.

## "🐛 Bugs" filter / Bug badges (local UI only)

- Filter key: `"bugmodule"` (chip label "🐛 Bugs", `state.js: CHIP_LABELS`/`FILTER_LABELS`).
  Despite the internal name, it is **not** literally "is this in the Plane module" — it's
  `isBugModuleTask(t)` from `static/js/utils.js`, which is the local, UI-facing bug check
  (type-based OR tag-based, see above). Keep this in sync with the backend's
  `is_slack_bug_incident_task` tag criteria whenever that changes, or the filter/badge counts will
  drift from what's actually in Plane (this happened once already — the frontend check wasn't
  updated when the backend rule was broadened, and the filter under-counted until fixed).
- Badge rendering (🐛 icon prefix, module tag chip) is wired through `taskTooltipHtml`,
  `compactTaskRow`, kanban card title, `renderCardReadOnly`'s `title-static`, and
  `renderFilterCounts` in `static/js/views.js` — all keyed off `isBugModuleTask(t)`.

## AI prompts (`webapp/ai/prompts.py`) — not fully constant-driven either

- `ai/agent.py`, `ai/fill.py`, and `ai/parser.py` all import `STATUSES`/`TYPES` from
  `app/constants.py` directly and validate/enumerate against them dynamically — adding a status or
  type there is automatically picked up (e.g. the AI agent's `update_status` action lists valid
  statuses straight from `STATUSES`).
- `ai/prompts.py`, however, is a dict of **static prompt strings** handed to the LLM — it does NOT
  read `TYPES`/`STATUSES`, so any prompt that spells out the valid values in its instructions
  (currently `"task_type"` and `"task_fill"`, both of which literally list `"Task, Review"`/
  `"Bug"`) needs a manual edit whenever `TYPES` changes, or the model will never suggest the new
  value even though `ai/parser.py`'s `validate_output()` would happily accept it. Updated for
  `Bug` on 2026-09-24 — check `ai/prompts.py` again next time `TYPES` (or a status the prompts
  mention by name) changes.

## Plane push policy (do not automate)

- Sending a task to Plane (`POST /api/tasks/{id}/plane`) is **manual, per-task, user-initiated**
  ("Send to Plane" button or the Add-Task checkbox). Never auto-push newly created tasks to Plane
  in bulk or by default — only tasks the user explicitly marks/sends. This has been an explicit,
  repeated instruction.
- Module/cycle sync (above) only runs for tasks that are *already* linked to Plane
  (`plane_issue_id` set) — it never creates the initial Plane issue.

## General workflow rules for this repo

- Never `git commit`/`push`/open a PR without asking first, in this repo or any other.
- Back up `tasks.json` before any scripted/bulk edit.
- Don't mark a task "Done" without explicit confirmation the underlying work is actually deployed
  /verified — "In Review" is the right default for "done but not confirmed live."
- When adding tasks in bulk from pasted notes, keep descriptions factual/plain (no AI-flowery
  language) — match the terse style of existing task notes.
