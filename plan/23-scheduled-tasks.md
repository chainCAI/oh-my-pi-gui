# 23 — Scheduled Tasks: creation from conversations, runs, reports, review

**Status**: P1–P4 implemented (2026-10-25), uncommitted. §14 lists where the build differs from this design; §12 stays deferred.
**Scope**: GUI only. Every agent primitive this needs already ships:
- `rpc-ui` sidecars
- tools provided by the GUI: `set_host_tools` is already in the RPC client, though nothing calls it yet, and `host_tool_call` is already routed by `sidecarPool.hostToolExecutor`
- the `--tools` allowlist and `--approval-mode` flags
- `extension_ui_response` with `cancelled: true`
- session files
- worktrees (doc 20)

The sidecar needs no rebuild.
**Out of scope**: running while the app is closed (an OS launch agent), cloud execution, and tasks from chat tabs (`--chat`).

---

## 0. What we are building

From any **agent** conversation, the user (or the agent, with the user's confirmation) turns a piece of work into a **task** that runs on a schedule. Each run is a real omp session that ends in a structured **report**. A shell command can check the run (**verification**), and a person accepts or rejects anything that changed code or failed (**review**). A dedicated **Tasks** view lists tasks, runs, a review queue and **insights** across runs.

North star: *a scheduled run is just a session nobody had to start.* It is the same kind of file as any other session, it opens as a normal tab once it finishes, and it shows its diff in the normal diff panel. The scheduler adds a schedule, a ledger and a verdict. It never adds a second agent runtime.

---

## 1. Research: what the four products do

| | OpenClaw | Hermes Agent (Nous) | OpenBot (CopilotKit / nightly-labs) | DeepSeek Bot (rlaope) + DeepSeek Harness plugin |
|---|---|---|---|---|
| **Creation** | `cron` tool from chat, CLI `openclaw cron add`, natural-language times | `/cron` and a `cronjob` tool from chat ("every morning at 9 …") | "Routines" defined in chat or a form, with a trigger and steps | "Watches" and reminders from chat; the plugin adds a scheduler tool |
| **Schedule kinds** | `at` (one-shot), `every` (interval), `cron` with a time zone | one-shot, interval, cron | cron and event triggers | interval watches, one-shot reminders |
| **Session style** | `main` (inject into the main thread) or `isolated` (fresh session per run) | fresh agent per run with its own skills and context | routine runs isolated, results posted back | read-only watch with a stored baseline |
| **Delivery** | announce to the originating channel; `NO_REPLY` keeps quiet runs silent | delivered to the origin platform or chat; `[SILENT]` suppresses | thread or inbox | message only on a change against the baseline |
| **Run tracking** | run log per job, overdue detection, `doctor` and `status` health | job list, last and next run, output stored per run | run history per routine | last value, last checked |
| **Failure handling** | backoff on errors, auto-disable after repeated failures | retry, then mark failed | retries | — |
| **Guardrails** | a cron run cannot create cron jobs; minimum interval | scheduled runs cannot schedule; a toolset restricted per job | approval at creation | read-only by construction |

Five patterns are worth copying:

1. **Create from the conversation, confirm before it exists.** Every product lets the agent propose a job, and the good ones show a preview first.
2. **Isolated runs.** Injecting into a live thread (OpenClaw `main`) is the exception, because runs then compete with the user's own turns.
3. **Quiet when there is nothing to say.** A run with nothing to report should not notify anyone.
4. **A ledger, not just "last run".** Run states, overdue detection, a health check and auto-disable after repeated failures.
5. **No recursion.** A scheduled run never gets the scheduling tool.

Two things none of them does well, which this design adds:

- **Verification.** Their runs end in prose, and success means "it didn't crash". Here every run ends in a structured report, and an optional check decides whether the run did its job.
- **Review of changes.** A run that edits code needs a diff a person can accept or reject. omp already has worktrees and a diff panel, so reviewing a run's changes is cheap to build.

Sources:

- [docs.openclaw.ai/automation/cron-jobs](https://docs.openclaw.ai/automation/cron-jobs)
- [hermes-agent.nousresearch.com — cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- [CopilotKit/OpenBot docs/routines.md](https://github.com/CopilotKit/OpenBot)
- [nightly-labs/openbot](https://github.com/nightly-labs/openbot)
- [rlaope/deepseek-bot docs/how-it-works.md](https://github.com/rlaope/deepseek-bot)
- the DeepSeek Harness scheduling plugin

---

## 2. Architecture

```
┌──────────────── Electron main ────────────────┐
│  Scheduler (main/scheduler/)                  │
│   ├─ clock: next-fire computation, wake/resume│
│   ├─ dispatcher: validate → queue → run       │
│   ├─ RunRunner: owns one SidecarManager/run ──┼──► omp --mode rpc-ui (headless, no window)
│   ├─ ledger: scheduler.db (node:sqlite)       │        │ host_tool_call: task_report
│   ├─ housekeeping: worktrees, retention       │        │ extension_ui_request → cancelled
│   └─ notifier: tray badge, OS notification    │
│                                               │
│  SidecarPool (unchanged) ── tab entries ──────┼──► omp --mode rpc-ui (per tab)
│                     ▲  host_tool_call         │        │
│                     └── schedule_task ◄───────┼────────┘ (agent tabs only)
└───────────────────────────────────────────────┘
          ▲ IPC (scheduler:*)
┌─────────┴────── Renderer ─────────┐
│ Tasks · Runs · Review · Insights  │
│ confirm card in the transcript    │
└───────────────────────────────────┘
```

**Why the main process and not the agent?** A tab's sidecar dies when the tab closes, and there is one sidecar per tab. The scheduler has to outlive tabs, see every workspace, and drive the tray. The main process is the only long-lived owner that sees all of that. The agent stays unchanged: a run is an ordinary `rpc-ui` session, prompted over the existing wire.

**Runs live outside `SidecarPool`.** The pool is keyed by window throughout: `acquire(cwd, win, …)`, `entryForWindow`, `tabsForWindow`, and saving and restoring tab layouts. Fitting a windowless entry into it would touch all of that. Instead, `RunRunner` builds its own `SidecarManager` from the same factory the pool uses, so it gets the same binary resolution, shell PATH, proxy env and crash reporting. It keeps a manager only for the length of one run. `scheduler.maxConcurrentRuns` (default 1, max 3) bounds how many exist at once; they don't count against the pool's tab cap.

**Runs open only after they finish.** While a run is live, its row in the Tasks view shows its progress (turn count, elapsed time, last tool) from the runner's event stream. **Open session** becomes available when the run ends, and hands the session file to a normal tab the same way the sidebar does. There is no read-only attach to a live run.

**Only while the app runs.** The tray already keeps the app alive with no windows open. When the app launches, or the machine wakes (`powerMonitor` `resume`), the clock recomputes. A slot that passed while the app was closed or asleep becomes **one** `missed` record per task, never a burst of replays. The app does not keep the machine awake.

---

## 3. How a run is launched

These code-controlled flags go on every run's argv, ahead of the user's flags:

| Flag | Why |
|---|---|
| `--no-auto-resume` | A run always starts a fresh session. It never resumes the user's latest session in that folder. |
| `--approval-mode <mode>` | Maps from the task's tool policy (below). It is passed at spawn, not with `set_setting`, because `set_setting` flushes to the user's config file and would change their global approval mode. |
| `--tools <list>` | Only for the `read_only` policy. |
| `--model <selector>` | Only when the task pins a model. |

The user's launch-profile flags still apply, for example provider and proxy settings. For run managers, though, the denylist that `stripDenylistedFlags` applies grows to include:

- `--approval-mode`
- `--yolo` and `--auto-approve`
- `--tools` and `--no-tools`
- `--model`
- `--session` and `--continue`

A profile flag therefore cannot widen a run's policy. This is one new option on `SidecarManager` (`runPolicy`), which supplies both the extra code-controlled flags and the extra denylist entries.

**Tool policy:**

| Policy | Argv | Isolation | Notes |
|---|---|---|---|
| `read_only` | `--tools <read/search set>` plus `--approval-mode always-ask` | runs in place | Nothing in the set needs approval. The exact list is fixed in P2 against the tool registry. Watch-style tasks and every agent-drafted task start here. |
| `workspace` | `--approval-mode write` | always a fresh worktree | Edits are auto-approved inside the worktree. Anything the mode still asks about is denied (see below). |
| `full` | `--approval-mode yolo` | always a fresh worktree | The confirm card requires an explicit tick. |

**Nobody answers prompts in a run.** `RunRunner` receives the run's `extension_ui_request` frames itself. Every blocking one (`select`, `confirm`, `ask`, `askDialog`, `input`, `editor`, `open_url`) gets `{ type: "extension_ui_response", cancelled: true }` straight away. An approval prompt answered this way is a denial. **P1 must prove this with a test**: a cancelled approval `select` must deny the tool call, not hang it.

Each denial is recorded on the run as `blocked: { tool, target }[]`, so the report page shows what the run wanted to do and couldn't. The run prompt (`src/main/scheduler/prompts/run.md`) tells the agent it is unattended: it should not ask questions, and it should say in its report what it couldn't do.

**What runs get from the GUI.** Each run sidecar gets exactly one GUI tool, `task_report` (§4). It never gets `schedule_task`, which is the recursion guard. Tools the GUI provides stay active even when `--tools` is set, so `task_report` survives the `read_only` list (`session-tools.ts`, `#applyRpcHostToolRefresh`).

---

## 4. Data model (`userData/scheduler.db`)

`node:sqlite`, like `conversation-index.ts`. IDs come from `snowflake.ts`.

```ts
interface Task {
	id: string;
	title: string;
	/** What each run is told to do. */
	prompt: string;
	revision: number;                        // bumps on every edit; runs record which one they ran
	state: "active" | "paused" | "disabled" | "archived";
	disabledReason?: "failure_streak" | "blocked_config";
	origin: { sessionPath: string; entryId?: string; createdBy: "user" | "agent" };
	cwd: string;                             // worktree isolation follows from the tool policy (§3)
	schedule:
		| { kind: "once"; at: string }                      // ISO, local tz
		| { kind: "interval"; everyMs: number; anchor: string }
		| { kind: "cron"; expr: string; tz: string };
	model?: { selector: string; effort?: string };   // pinned by the user; absent = workspace default
	tools: "read_only" | "workspace" | "full";
	timeoutMs: number;                       // default 30 min
	verify?: { command: string; timeoutMs: number };   // exit 0 pass, 1 fail, >1 error
	notify: "always" | "on_change" | "on_failure";      // "on_change" keeps quiet runs silent
	createdAt: number; updatedAt: number;
}

interface Run {
	id: string; taskId: string; taskRevision: number;
	trigger: "schedule" | "manual" | "retry";
	scheduledFor: number | null;
	state:
		| "queued" | "running"
		| "succeeded" | "failed" | "cancelled" | "timed_out"
		| "skipped_overlap" | "skipped_backlog" | "missed" | "blocked_config"
		| "unknown";                         // app died mid-run; reconciled at next start
	cancelReason?: "user" | "app_quit" | "task_archived";
	startedAt?: number; endedAt?: number;
	sessionPath?: string;                    // from the run's session-info frame
	worktree?: { path: string; branch: string; removed: boolean };
	report?: RunReport;
	blocked: { tool: string; target?: string }[];
	verification: { state: "none" | "passed" | "failed" | "error"; exitCode?: number; outputTail?: string };
	review: { state: "none" | "pending" | "accepted" | "rejected"; note?: string; at?: number };
	usage?: { inputTokens: number; outputTokens: number; costUsd: number; turns: number };
	error?: { message: string; kind: "transient" | "auth" | "config" | "other" };
	retryOf?: string;
}

interface RunReport {
	status: "done" | "nothing_to_report" | "blocked" | "partial";
	summary: string;                          // one paragraph
	findings: { title: string; detail?: string; severity?: "info" | "warn" | "error" }[];
	changes: { path: string; note?: string }[];
	next?: string;                            // what the next run should look at
}
```

Further tables:

- `task_revisions` holds `(taskId, revision, snapshot JSON)`, so a run always shows the exact prompt and config it ran.
- `scheduler_meta` holds the heartbeat timestamp, the global pause flag and the schema version.

**The report is structured, not scraped.** The run prompt tells the agent to finish by calling `task_report`, whose parameters are `RunReport`. The main-process tool executor answers that call directly, so it never touches a renderer. A run that ends without calling it gets `status: "partial"`, with the final assistant message as the summary, and goes to review instead of passing silently.

**The next run sees the last one.** Each run's prompt includes the previous run's `summary` and `next`. If that run was rejected, it also gets "Last run was rejected because …" with the reviewer's note. That is how a recurring task builds on earlier runs without one ever-growing session.

---

## 5. Creating a task from a conversation

Both entry points end in **one confirm card**. Nothing is scheduled until the user presses **Schedule**.

| Entry point | How |
|---|---|
| **Agent proposes** | Agent-tab sidecars get a `schedule_task` tool. This is the GUI's first `set_host_tools` call: the pool sends it once a tab's sidecar is ready, with `loadMode: "discoverable"`. When the user says "check this every morning", the agent calls it with a draft. The existing tool executor passes the unknown tool on to the tab's renderer, which renders the confirm card inline in the transcript. The tool result is `created` (with the id) or `declined` (with the user's reason), so the agent can follow up. |
| **Tasks view** | **New task**: an empty card with a workspace picker. |

What the confirm card shows:

- Title and prompt, both editable.
- The schedule as words plus the next three fire times ("Weekdays at 09:00 — Mon 27 Oct, Tue 28 Oct, Wed 29 Oct"), parsed by `croner`, a new GUI dependency.
- Workspace, the model pin, and the tool policy, as segmented controls. `full` needs a tick to confirm.
- An optional verify command.
- The notify mode.
- **Start paused** (canary): created paused, with a single **Run now** to try it.

Rules:

- **Agent tabs only.** Chat tabs never get the tool.
- **No recursion.** Run sidecars never get `schedule_task`. When a finished run's session is opened as a tab, that tab doesn't get it either: the tab is spawned with the run's session path, which the scheduler recognises (§8.1).
- **The user owns pins and policy.** An agent's draft always arrives as `read_only` with no model pin. The agent may suggest a model; the card shows it as a suggestion the user has to accept.
- **Floor and cap.** The minimum interval is 5 minutes (`scheduler.minIntervalMs`). At most 20 tasks can be enabled (`scheduler.maxEnabledTasks`). The card blocks saving past either limit and explains why.

---

## 6. Run lifecycle

```
fire ─► validate ─┬─► blocked_config   (cwd gone, model unavailable, provider auth expired)
                  ├─► skipped_overlap  (previous run of this task still live)
                  ├─► skipped_backlog  (5 changed runs of this task still unreviewed)
                  └─► queued ─► spawn ─► prompt ─► running ─┬─► task_report ─► verify ─► review? ─► notify
                                                            ├─► timeout ─► timed_out
                                                            └─► crash / provider error ─► failed (+1 retry if transient)
```

1. **Validate before dispatch.**
   - The cwd exists, and for worktree policies it is a git repo.
   - The task isn't paused globally.
   - Fewer than 5 runs with changes from this task are waiting for review. A daily task nobody reviews must not pile up worktrees.
   - A failure records `blocked_config` (or `skipped_backlog`). Three `blocked_config` runs in a row disable the task.
2. **Queue, then spawn.** The run row is written as `queued` before the sidecar starts, so a crash between the two leaves a ledger entry. At startup, any `queued` or `running` row without a live runner becomes `unknown`.
3. **Run.**
   - The runner sends the prompt and streams events, and watches the timeout.
   - The model pin is checked on the spawned sidecar. A pin that doesn't resolve ends the run as `blocked_config`.
   - Usage comes from the session's own stats events, so it matches `omp stats`.
4. **Errors.**
   - **Transient** (provider 429 or 5xx, network failure, a sidecar crash before the first turn): one retry 10 minutes later, as a new `retry` run linked by `retryOf`.
   - **Auth** (401, expired OAuth): `blocked_config` with `error.kind: "auth"`, no retry. The notification says to sign in again.
   - **Anything else** fails without a retry. The next scheduled run is the next attempt.
5. **Failure streak.** Three consecutive `failed` or `timed_out` runs (retries don't count) disable the task with `failure_streak` and send a notification.
6. **Health.** The scheduler writes a heartbeat every 30 seconds. The Tasks view header shows **Healthy**, **Paused** or **Stalled**, the time of the last heartbeat, and the next fire.

---

## 7. Verification and review

**Verification** is the task's optional shell command. It runs in the run's cwd or worktree after the agent ends, with the same exit-code meanings as `/loop` conditions (`loop-condition.ts`): exit 0 passes, 1 fails, and anything else is `error`. Examples: `bun test`, `git diff --quiet`, `curl -fs …/health`. The output tail is stored after the same sanitizing as any tool output.

**A run needs review when any of these hold:**

- `report.changes` isn't empty, or the worktree has a diff (`get_git_changes`).
- Verification is `failed` or `error`.
- The report is `partial` or `blocked`, or the run recorded denied tools.

**Review actions** on a run:

- **Accept** marks the run accepted. For a worktree run it then offers **Merge branch** (the existing worktree merge flow) or **Open PR** (PR center, doc 21).
- **Reject**, with a note. The note goes into the next run's prompt (§4).
- **Re-run** starts a manual run of the same revision.
- **Edit task** opens the card at the current revision.

`nothing_to_report` runs that pass verification skip the queue, and stay silent under `notify: "on_change"`.

---

## 8. Housekeeping

### 8.1 Run sessions stay out of the sidebar

Runs write to the normal session folder, so session paths, deletion and search work unchanged. The folder can't change: `SessionIndex` refuses paths outside its root. To keep runs from being listed with the user's own conversations:

- The scheduler keeps the set of run session paths from its `runs` table.
- The session-list IPC leaves those paths out of the sidebar.
- The conversation search leaves them out by default, with a "Include task runs" toggle.
- The Tasks view is where run sessions are listed and opened.

### 8.2 Worktree cleanup

| When | What happens |
|---|---|
| Run ends with no diff | worktree and branch removed at once |
| Rejected | worktree and branch removed |
| Accepted and merged, or PR opened | worktree removed; branch kept for the PR, or deleted after merge |
| Unreviewed after 14 days | worktree directory removed, **branch kept**, so the changes survive; the run stays in review |

Removal goes through the existing worktree IPC and `@oh-my-pi/pi-natives/vcs`, never through `git` spawned by hand. Combined with the backlog cap in §6, this bounds a task to at most five outstanding worktrees.

### 8.3 Retention

Each sweep removes runs older than `scheduler.retainDays` (default 90), together with their session files (via `SessionIndex.deleteSession`) and leftover branches. Two kinds are always kept:

- Runs with a pending review.
- The latest run of each task.

The sweep runs at startup and every 24 hours.

### 8.4 Quit, update and crash

- **Quit:** while a run is live, the quit guard (`quit-guard.ts`) asks "Quit and cancel 1 running task?". On a confirmed quit, the runner aborts its sessions and marks the runs `cancelled` with `app_quit`.
- **Update:** the updater holds a pending restart until no run is live, and shows "Restart after the running task finishes".
- **Crash:** reconciled to `unknown` at the next start (§6).

### 8.5 Editing, pausing and deleting a live task

- **Edit** bumps the revision. A live run finishes on the revision it started with; the next fire uses the new one.
- **Pause** stops future fires. It doesn't stop a live run; the run row has its own **Cancel**.
- **Archive** replaces delete and keeps the history. If a run is live, it asks whether to cancel it (`task_archived`).
- **Delete permanently** is offered only for archived tasks. It removes the task, its runs, their session files and their branches, after a confirm that names the count.

### 8.6 Results don't go back to the original conversation

This is deliberate. The GUI never writes session files (plan README, "Session data"), and appending to a conversation the user may have open would race their own turns. Instead, the task links its origin ("Created from *session title*"), and notifications open the run's report page.

---

## 9. Pages

A new **Tasks** entry sits in the sidebar header next to the Code and Work modes. It replaces the main area (it is not a drawer) with four sub-tabs. A tray badge counts runs waiting for review.

### 9.1 Tasks (management)

- **Header:**
  - Scheduler health pill.
  - Global **Pause all** switch.
  - **New task**.
  - Filters: workspace, state, and search.
- **Table:** one row per task with these columns:
  - title and workspace
  - schedule in words
  - next run (relative)
  - last run, as a state dot and time, or live progress while running
  - a 14-run history strip (pass, fail, quiet and skipped cells)
  - success rate
  - an enable toggle
- **Selecting a row opens the detail pane:**
  - Actions: **Run now**, **Pause/Resume**, **Edit**, **Duplicate**, **Archive**.
  - Prompt and config at the current revision, with a revision picker.
  - Origin link.
  - Its runs, as a timeline.

### 9.2 Runs (reports)

A reverse-chronological list across all tasks, filterable by task, state and date. Opening a run shows its report page:

- **Header:**
  - Task title and revision.
  - Trigger.
  - Scheduled time against start time.
  - Duration, tokens and cost.
  - State chip.
- **Report:** status, summary, findings (with severity icons) and changes. A change opens the diff panel on the run's worktree or session.
- **Blocked actions:** what the run was denied, if anything.
- **Verification:** exit code and output tail.
- **Review bar:** Accept, Reject with note, Re-run, Merge/PR.
- **Open session:** the full transcript as a normal tab.

### 9.3 Review (queue)

The runs from §7 that need a person, oldest first, grouped by task. Each row has the summary, the verification chip and the review actions inline. A disabled task (failure streak or blocked setup) also appears here, with its last error and a link to edit it.

### 9.4 Insights (summary and analysis)

Covers a period picker (7, 30 or 90 days) and a task filter.

- **Stat tiles:**
  - runs
  - success rate
  - verification pass rate
  - review acceptance rate
  - total cost
- **Charts** (following the dataviz rules: one accent, tabular numbers):
  - runs per day, stacked by outcome
  - cost per task (horizontal bars)
- **Recent failures:** the last 20 failed, timed-out and blocked runs, with task and error.

All aggregates are SQL over `runs`.

---

## 10. Safety rules (summary)

| Rule | Default |
|---|---|
| Agent proposes, user confirms | always; no silent creation |
| No scheduling from a scheduled run | the tool is never registered on run sidecars or on tabs opened from run sessions |
| Agent drafts | `read_only`, no model pin |
| Minimum interval | 5 min |
| Max enabled tasks | 20 |
| Concurrent runs | 1 (max 3) |
| Overlap | the next fire is `skipped_overlap`, never queued behind |
| Review backlog | 5 unreviewed runs with changes per task, then `skipped_backlog` |
| Missed slots | one `missed` record, no replay |
| Approval policy | spawn flags only; profile flags can't widen it; every prompt in a run is denied |
| Code changes | `workspace` and `full` always run in a worktree; changes reach the user's branch only through review |
| Timeout | 30 min |
| Failure streak | 3, then auto-disable |
| Transient retry | one, after 10 min |
| Audit | every run records trigger, revision and model; task edits are revisioned |

---

## 11. Phases (~10 days)

| Phase | Delivers | Verification gate |
|---|---|---|
| **P1 — Ledger, clock, runner** (~3 d) | `scheduler.db`, `croner` next-fire, wake/resume recompute, missed and overlap handling, heartbeat, `RunRunner` with `runPolicy` argv and auto-cancelled UI requests, quit guard and updater hold, IPC, a bare Tasks table with **Run now** | Fake-clock unit tests covering missed slots, DST jumps, overlap and `unknown` reconciliation after a kill; argv tests showing a profile `--approval-mode yolo` is stripped from a `read_only` run; a cancelled approval `select` denies the tool call |
| **P2 — Reports, review, housekeeping** (~3.5 d) | `task_report` tool, run report page, worktree runs, shell verification, review queue with accept/reject/re-run, rejection note and previous summary in the next prompt, merge/PR hand-off, run sessions hidden from the sidebar, worktree cleanup, retention sweep, failure streak, the one transient retry | Review script with the mock model: a `workspace` run writes in a worktree, reports, lands in review, and a reject removes the worktree. Shell exit 0, 1 and 127 map to pass, fail and error. The run session isn't in the sidebar. |
| **P3 — Creation from conversation** (~2 d) | `schedule_task` tool on agent tabs, inline confirm card, start paused | Agent drafts, user edits and confirms, task exists; declined → tool result `declined`; chat tabs and tabs opened from run sessions have no tool |
| **P4 — Insights and notifications** (~1.5 d) | Runs list filters, Insights tiles, the two charts, recent failures, tray badge, OS notifications by notify mode | SQL aggregates against a seeded ledger; a quiet run under `on_change` produces no notification |

Each phase ships behind `scheduler.enabled` (off until P2 lands), with en, zh and ru strings and a changelog entry.

---

## 12. Later

Cut from the first version on review. Each is worth building once the basics have real use behind them.

| Feature | Why it waits |
|---|---|
| **AI grader** (a separate short session grades the report and diff) | Shell verification plus human review already covers "verify". Before building it, check whether a `--chat` session accepts GUI tools, or have it answer in plain JSON. |
| **Tasks that keep one long session** (`session: "continue"`) | The previous run's summary and `next` in the prompt give most of the benefit, without unbounded growth or a compaction policy. |
| **Error grouping by signature** (incidents) | A failure streak plus the last error is enough until tasks fail in repeated, distinguishable ways. |
| **Retry ladder** (5, 15 and 30 minutes) | One retry, and then the next scheduled run, covers transient errors. |
| **Catch-up runs, keeping the machine awake, turn and cost caps** | A timeout is enough at first. Add catch-up once the `missed` counts show it matters. |
| **Insights analysis**: flaky, slowing, expensive and always-quiet detection; period digest | These need real run history to tune thresholds against. The digest also adds a paid model call. |
| **Revision diff view, review keyboard shortcuts, `autoAccept`** | Convenience on top of flows that must exist first. |
| **`/schedule` and "Schedule this…" on a message** | Thin wrappers around the confirm card; add them if the agent tool and **New task** prove to be too few ways in. |
| **Attaching to a live run** | It needs pool-level session ownership for windowless runs; live progress in the Tasks row covers the need. |
| **A "Scheduled" card in the Overview drawer** for tasks created from that conversation | A natural home for "how did my task do", once tasks exist. |
| **Running while the app is closed** (`launchd` or Task Scheduler starting the app hidden) | Wait until the `missed` counts show how often slots are lost. |

---

## 13. Open questions

1. **Where the confirm card lives.** It could render inline in the transcript, next to the tool call (closest to the conversation), or as a modal (harder to miss). The current lean is inline, plus a sidebar dot if the tab is in the background.
   *Built as a modal* (§14): the tool call row stays in the transcript and reads "waiting for you" until the dialog closes.
2. **`write` approval mode in worktrees.** If `write` still prompts for common bash commands, `workspace` runs will be denied often. P1's approval test should measure this. If it happens, `workspace` may need `yolo`, which the worktree already contains.
   *Measured*: under `write`, every bash call prompts, so an unattended `workspace` run edits files but cannot run commands; the refusals are listed on the run. The task's shell check still runs, from the scheduler. Kept as is; switching `workspace` to `yolo` is a one-line change in `runPolicyFlags` if runs need to build or test themselves.

---

## 14. As built (2026-10-25)

Differences from the design above, and what implementing it turned up.

| Area | Design | Built |
|---|---|---|
| Next-fire | `croner` | `src/shared/schedule.ts`: a small cron parser plus zone-aware wall-time search, no dependency. Backtested against an independent matcher over every minute of 2026 in 16 zones (including Chatham, Lord Howe, Troll) and 15 expressions: 727,886 fires, 0 mismatches. |
| Catch-up | missed slots recorded on wake and restart | One `missed` record per gap, carrying the last slot reached too late, on both paths; a slot inside the grace window still runs. A relaunch starts from the latest slot in the ledger, not only the heartbeat, so a slot that fired after the last beat is not run or recorded twice. |
| Tasks UI | a page | A full-size modal (Tasks, Runs, Review, Insights tabs) opened from the sidebar, the command palette and the menu. |
| Confirm card | inline in the transcript | A modal dialog; see §13.1. |
| Accept | merge/PR hand-off | Accept keeps the run's worktree and branch (retention and task deletion keep the branch too); merging is left to the user. Reject removes both. |
| Run sessions | hidden from sidebar and search | Hidden from the sidebar and session list; search still finds them. |
| Quit/update | updater hold | The quit guard asks before cancelling live runs; no updater change. The review count shows as the dock badge (`app.setBadgeCount`). |
| Archive | restore | Restoring an archived task leaves it paused. |
| Host tools | `set_host_tools` | Both tools load with `loadMode: "essential"`. omp gives GUI host tools the exec approval tier and has no way for a definition to declare a lower one, so the GUI answers its own tools' prompts: the runner approves `task_report`, and `sidecarPool.uiResponder` approves `schedule_task` (its confirm card is the real approval). A per-tool `approval` field in the agent's host-tool definition would be cleaner. The host-tool result shape the pool sent was wrong and had never been exercised; fixed. |
| `read_only` tools | read/search tools | `read,glob,grep,lsp,web_search,todo`. `find` (needs a judge model) and `ast_grep` (off by default) made omp refuse the command line with exit code 2. |
| Startup errors | transient retry | An exit-2 command-line rejection is a setup problem (`blocked_config`), not retried, and stops at the first restart; omp's ANSI colors are stripped from the reason. |
| Time picker | native time input | Hour and minute selects (5-minute steps) next to a date input, so the field matches the other selects and reads the same in every locale. |
| Insights | tiles and two charts | As designed; KPI cards align their rows with CSS subgrid, bars grow in on open and stay still under reduced motion. |
| Flag | `scheduler.enabled` | No flag: everything shipped at once. |
