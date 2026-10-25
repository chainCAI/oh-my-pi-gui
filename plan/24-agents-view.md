# 24 — Agents view: a docked monitor, activity first, rich transcripts

**Status**: design (2026-10-25). Not started.
**Source**: [nornzach/oh-my-pi-gui#23](https://github.com/nornzach/oh-my-pi-gui/issues/23). The reporter runs sessions with dozens of subagents nested several levels deep.
**Scope**: GUI only. Everything this needs is already on the wire:
- `parentSubagentId` on every nested snapshot
- `AgentProgress`: current tool, tool args preview, last intent, context use, retry state
- `get_subagent_messages` from a byte offset

The sidecar needs no rebuild.
**Out of scope**: token-level live streaming of subagent output (§10), and changing what the agent reports.
**Prototype**: [`mockups/24-agents-view.html`](mockups/24-agents-view.html) draws every screen in this plan with the GUI's own tokens, in light and dark. §5 is its written contract.

---

## 0. What we are building

The issue asks for three things:
1. **A docked view.** The agent list sits in a sidebar, so the conversation stays visible while you watch it.
2. **Activity first.** Agents that are working come before parked, idle and finished ones, without losing the parent-child tree.
3. **Rich transcripts.** A subagent's transcript reads like the main conversation, with tool cards, thinking and formatted messages, not plain text.

North star: *one roster and one transcript reader, shown in the places that need them.* Today the same agents appear in four places with four implementations. This plan adds one real monitor and makes the other places reuse it. It does not add a fifth list.

---

## 1. Current state (checked against the code)

| Surface | File | What it does | Gap for #23 |
|---|---|---|---|
| Dock card above the composer | `chat/dock/AgentsDockCard.tsx` | Tree in spawn order (`buildSubagentList`), List/Graph toggle, a 5-row preview (`buildAgentDockSummary` keeps live and failed agents plus their ancestors), in-dock "view all" focus, inline transcripts | Shares a dock capped at 45% of the window height with todos, plan and queue; no activity ordering |
| Agent Hub → Hub tab | `panels/AgentHubWindow.tsx` (`HubTab`) | Flat list, live agents first (`hubStatusOrder`); status counts; pause or resume agents, abort the turn, abort or revive one agent; transcript slide-over | A **modal**: it covers the conversation. The flat list loses the hierarchy. |
| Task tool card | `tools/TaskRenderer.tsx` | Live tree for one `task` call, inside the transcript | Scrolls away with the conversation |
| Overview → Running | `panels/OverviewPanel.tsx` | First few live agents with a count | A preview with no destination to open |
| Transcript | `panels/SubagentTranscript.tsx` | `messageText()` keeps only `type === "text"` parts, cut at 1,200 characters, with a raw role label | Drops tool calls, results and thinking. No markdown. |

Findings that shape the design:

- **"Live" doesn't mean "working".** `isLiveSubagentStatus` treats `started`, `running`, `pending`, `idle` and `parked` all as live. So the dock badge (`3/40`), the Overview "N running" line, the pulsing badge and the Hub ordering all lump parked and idle agents in with working ones. This is the heart of ask 2.
- **The wire carries what an agent is doing; the rows drop it.** `progress.currentTool`, `currentToolArgs` (already a short preview, such as a path or a command), `currentToolStartMs`, `lastIntent`, `retryState`/`retryFailure` and `contextTokens`/`contextWindow` all arrive. The dock row shows only `description`, model, tokens, cost and elapsed time.
- **The hierarchy needs no transcripts.** `parentSubagentId` is explicit on nested snapshots. The tool-call ownership fallback only matters for frames that predate it.
- **The transcript read is incremental.** `readRpcSubagentTranscript` returns every complete line after `fromByte` in one response. Polling from `nextByte` costs only the new bytes.
- **A refresh bug.** A caught-up transcript keeps its refresh button only while `status === "started"`. An agent reporting `running` loses it.
- **Frame rate.** The agent coalesces progress to at most one frame per 150 ms per agent. Each frame is one IPC message and one subagents-store write, which builds a new `Map` (`hooks/use-rpc-events.ts`). With 40 working agents that can mean hundreds of store writes a second, each re-deriving the tree.
- **History.** 0.7.3 deliberately moved the drawer's Agents tab into the dock ("live execution state moved into the conversation"). The dock card is the right *glance*. The issue asks for a *monitor*, a different job, so this plan keeps the dock card and adds the monitor instead of moving the card back.
- **The event stream stays off.** `SUBAGENT_SUBSCRIPTION_LEVEL` is `progress`. The `events` level streams a full message snapshot per token for every subagent and flooded the pipe in #19.
- **The drawer header is already full.** Six views share it, and above 480 px every tab prints its label. With the real labels that strip needs about 645 px in English and 676 px in Russian, so between 480 px and that width it already scrolls sideways (`overflow-x-auto` in `layout/PanelContainer.tsx`) and hides tabs. A seventh tab raises the need to about 730 and 764 px (measured in the prototype with the locale strings; Chinese needs 554).

---

## 2. Decisions

| Decision | Choice | Rejected, and why |
|---|---|---|
| Where the monitor lives | A new **Agents** tab in the right drawer, on agent tabs only | A separate window needs cross-window store sync for a per-tab runtime. A non-modal Hub is the wrong primitive, and the modal also holds Definitions. Moving the dock card back would undo 0.7.3 for everyone, including sessions with two agents. |
| Roster implementation | One `AgentRoster` component: list, rows, filters. The drawer tab uses it, and in P3 it replaces the Hub tab | A third roster beside the dock and the Hub |
| How much a row says | A title, one "now" line and one time. Model, tokens, cost, context and the assignment move to the detail (§5.1) | Three-line rows carrying eight facts each. At 40 agents nothing stands out, and the list stops being scannable. |
| Status signal | The existing 6 px signal dot, static | A pulse on every working row: ten pulsing dots are noise, and plan/22 keeps motion for "needs you" |
| Tab indicator | A dot on the Agents icon: accent while agents work, error after a failure you haven't seen | A count on the tab. It repeats the toolbar's number, and a second number that disagrees (working vs active) has to be reconciled. |
| Drawer header with seven tabs | Only the selected tab prints its label; the others are icons with tooltips, at every width | Today's rule (every label above 480 px) already scrolls tabs out of view (§1). A higher breakpoint would have to sit near 770 px to fit Russian, so labels would show only close to the drawer's 840 px maximum, and a per-locale breakpoint breaks with every new string. |
| Transcript implementation | One `TranscriptReader` built on the main conversation's `MessageBubble` and `ToolCard`, used by the drawer, the dock's inline expansion and the Hub | A separate set of "lite" renderers that drift from the main ones |
| Live transcript updates | Poll `get_subagent_messages` from `nextByte` every 2 s for the **one open** transcript while its agent works | The `events` subscription (#19). A per-agent subscription (needs an agent change; §10). |
| Frame cost | Coalesce subagent frames per animation frame into one store write | Throttling in the agent: it is shared with the TUI and already at 150 ms |

---

## 3. The docked Agents view (ask 1)

A drawer tab `agents`, placed after Overview. It isn't in `CHAT_PANEL_TABS`, because chat tabs have no tools and no subagents.

- **Content**: a list (filtered Active or All, §4) or the Graph (the existing `SubagentDag`, which has room here once the drawer is widened to 360–840 px).
- **Detail**: selecting a row opens that agent's detail inside the tab (§5.3). Back or Esc returns to the list with its scroll position, filter, expansion and selection kept.
- **Entry points**:
  - the drawer toggle
  - an "Open in sidebar" button in the dock card header
  - the subagent line in Overview → Running
  - from P3: each agent row on a task tool card, `⌥A` and `/hub`
- **Header**: the tab-label rule in §2, which replaces the 480 px rule in `global.css` for every view, not only this one. Every tab keeps its `aria-label` and tooltip. Below 400 px the selected tab drops its label too, so the seven icons and the close button still fit the 360 px minimum.
- **Narrow windows**: at 1000 px and below the drawer already overlays the conversation, and the tab follows that rule.
- **Split view**: the tab shows the focused pane's runtime, like Diff and Files.

The dock card stays as it is: the in-conversation glance, with its 5-row preview and focus mode. The design-qa.md contract for it is unchanged.

---

## 4. Activity first (ask 2)

### 4.1 Activity, separate from status

`subagentActivity(agent)` maps the free-form wire status into five groups. It always goes through `statusMeta`, never a raw lookup.

| Activity | Wire statuses | Signal (§5.2) |
|---|---|---|
| **working** | `started`, `running` with `live !== false` | Accent dot |
| **waiting** | `pending`, `idle`, `parked` | Hollow ring |
| **failed** | `failed` | Error dot, and "Failed" in place of the time |
| **done** | `completed` | None |
| **stopped** | `cancelled`, `aborted`, `stale`, unknown | None, and "Cancelled" or "Stopped" in place of the time |

`isLiveSubagentStatus` keeps its meaning (elapsed timers, roster retention in the store). Every *count* and every *live signal* switches to activity:
- the dock badge
- the Overview Running line
- the Agents tab's dot
- the Hub's status badges

### 4.2 Two filters

- **Active**: working, waiting and failed agents, each with its ancestors. An ancestor that isn't active itself stays as a muted context row, so no row is ever an indented orphan; this reuses `buildAgentDockSummary`'s ancestor walk. Siblings are ordered working → waiting → failed, with spawn index as the tie-break. Ancestors of active rows start expanded.
- **All**: today's spawn-order tree. Nothing is hidden or reordered.

Each segment of the filter carries its count ("Active 13", "All 34"). Active counts agents, including those under a collapsed parent. This is the only number of agents the view prints.

**Order is stable.** A row moves only when its activity group changes. Progress frames never reorder the list, so rows don't jump while you read them.

The default is **Active** when more than `AGENT_SUMMARY_LIMIT` agents exist, otherwise **All** (§11.1). The choice is remembered per tab while the tab is open. An empty Active list says so and offers "Show all" (§5.4).

---

## 5. Presentation

The first draft of this plan put every fact the wire carries on every row. The result was hard to read: status was printed twice per row, every working row pulsed, counts appeared in three places and nothing set one row apart from another. This section replaces it with a visual contract. Each screen below has a frame in the prototype.

### 5.1 Three layers of detail

| Layer | Question it answers | Where | What it shows |
|---|---|---|---|
| **Glance** | Is anything running, or did something break? | The Agents tab's dot, the dock card, Overview → Running | A dot or a count |
| **Scan** | Which agents are there, and what is each one doing now? | Roster rows | A signal, a title, one now-line, one time |
| **Inspect** | What exactly has this agent done? | The detail | Facts, the assignment, the transcript, the live tail |

Each fact has one home. Model, tokens, cost, context share and the assignment belong to the inspect layer and never appear on a row. A row carries one time; the current tool's own elapsed time is an inspect fact.

### 5.2 Roster

Frames `roster-active` (dark, 400 px) and `roster-all` (light, 520 px).

```
⌄ ●  Map the auth surface                      6m 40s
  │ ●  Find every verifyToken caller            1m 48s
  │    grep verifyToken · src/
  │ ○  Check the token refresh tests           Waiting
› ●  Rewrite the login handler  (● 4)          3m 05s
     edit src/routes/login.ts
  ●  Audit cookie flags                        2m 10s
     Retrying 2 of 3 · 429 Too Many Requests
  ●  Benchmark the token cache                  Failed
     Rate limited after 3 attempts
```

**Row anatomy**: a 14 px chevron column, the 16 px signal slot that sidebar rows use, the title, and the time on the right.

- **Surface**: rows sit directly on the canvas, with no borders, no cards and no tinted backgrounds. A one-line row is 30 px, like a sidebar row. A two-line row adds 6 px of padding above and below. The corner radius and the hover and selection fills are the sidebar's.
- **Title**: `subagentPrimaryLabel`, `text-omp-md`, one line with an ellipsis and the full text in a tooltip. Its tone follows activity: working `--omp-text`, waiting `--omp-text-secondary`, done, stopped and context rows `--omp-muted`. This makes the working rows the brightest thing in the list.
- **Signal**: as in §4.1. Static: no pulse, no ping.
- **Time**: `text-omp-xs`, `--omp-dim`, tabular figures. Elapsed time while working; total time once done. Otherwise a word ("Waiting", "Failed" in error tone, "Cancelled"), which is the dot's meaning in text wherever a time would mean nothing.
- **Now-line**: a second line in `text-omp-xs` and `--omp-dim`, shown only when one of these applies (the first one wins):
  1. retrying: "Retrying 2 of 3 · \<error\>" in warning tone, the only place a row uses warning
  2. the current tool: its name in mono `--omp-text-secondary`, then `currentToolArgs` in mono `--omp-dim`
  3. `lastIntent`
  4. failed: `retryFailure.errorMessage` or the last line of `recentOutput`, in the ordinary dim tone, because the dot and the word already carry the error

  A parent whose current tool is `task` shows no now-line: its children are what it is doing. Waiting, done and stopped rows stay one line.
- **Tree**: each level indents 14 px and draws one hairline guide (`--omp-border-muted`) down from its parent's signal dot. Indentation stops growing after six levels; deeper rows keep the sixth level's indent, and the detail's crumb gives the full path. A collapsed parent shows a pill with the number of agents it hides, led by an accent dot when any of them is working.
- **Sanitizing**: all wire text goes through the `lib/format.ts` helpers (tabs, truncation, home-path shortening), as in tool renderers.

**Toolbar** (44 px, sticky; frame `roster-active`):
- Left: the filter, a small segmented control: "Active 13 | All 34".
- Right: the presentation (List | Graph) as a separate icon segmented control, so a filter and a view are never the same control. Then ⋯ with Pause agents (or Resume agents), Stop the turn, Expand all and Collapse all.
- The toolbar gets a hairline bottom border only once the list scrolls under it.
- While agents are paused, a warning banner sits under the toolbar: "Agents are paused" with a Resume link. Resume is the one menu action that also appears outside the menu, because it is the way out of a state the user may have forgotten entering.

### 5.3 Detail

Frames `detail-working` (dark), `detail-scrolled` (dark) and `detail-failed` (light).

```
‹ Agents         Find every verifyToken caller        ⋯    nav bar; the title appears once the heading scrolls away
In Map the auth surface                                    crumb, nested agents only
Find every verifyToken caller                              heading
(● Working)  1m 48s                                        status badge and time
╭─────────────────────────────────────────────╮
│ Agent    explore · claude-sonnet-4.5         │            facts card
│ Work     14 steps · 38.2k tokens · $0.21     │
│ Context  ━━━━──────────  31% of 200k         │
├─────────────────────────────────────────────┤
│ › Assignment  Find every call site of …      │
╰─────────────────────────────────────────────╯
Transcript
  …messages, thinking and tool cards…
┃ ◌ grep  verifyToken packages/          0:12             live tail: the running tool
  Looking for callers outside the auth module              intent, shimmering
                 ( ↓ 3 new steps )                         only while scrolled up
```

- **Nav bar** (44 px, sticky, with a hairline): "‹ Agents" on the left; ⋯ on the right for the agent's own actions (Stop or Revive, from P3). Once the heading scrolls out of view, the agent's title fades in, centred on the bar and truncated.
- **Header**: sits on the canvas, not in a card.
  - A crumb, "In \<parent\>", linking to the parent's detail. Only nested agents have one.
  - The heading in `text-omp-lg`, semibold. It wraps rather than truncates.
  - A subline: the status `Badge` with `dot` and without `pulse`, then the time: "1m 48s", or "after 3m 22s" once the agent has ended.
- **Error card** (failed agents only) comes first, ahead of the facts. It has an error-dim fill, an alert icon, a one-line summary in error tone ("Stopped after 3 attempts") and the message in secondary text.
- **Facts card**: the Overview card (`rounded-xl`, `--omp-border-muted`, `--omp-bg-elevated`) with its label and value rows, labels 64 px wide in `--omp-dim`:
  - Agent: type · model. A fallback model says so.
  - Work: steps · tokens · cost.
  - Context: a 4 px bar and "31% of 200k", only when `contextWindow` is known.
  - Assignment: a disclosure row at the card's foot, collapsed, with a one-line preview. It expands to the delegated prompt as markdown (§6.1).
- **Transcript**: a section label, then the reader (§6).
- **Live tail**: while the agent works, the transcript ends with its running tool, drawn as a pending `ToolCard` from `progress` (`currentTool`, its args, the time since `currentToolStartMs`), and the intent under it in `.omp-shimmer-text`. This is the detail's only "now": the header and the facts card never restate the current tool.
- **New-steps chip**: when the reader is scrolled above the live edge and messages arrive, a pill floats at the bottom centre: "↓ 3 new steps". Clicking it scrolls to the end; reaching the end hides it.
- **Width**: on a wide drawer the content column is capped at 44 rem and centred, so prose lines stay a readable length.

### 5.4 States

Frame `states`, plus the glance frame `glance`.

| State | Shown as |
|---|---|
| The session has no subagents | Centred: icon, "No subagents yet", "When the agent hands work to subagents, they appear here while they run." No toolbar. |
| Active is empty | Centred: "Nothing is running", "Every agent in this session has finished.", and a Show all button |
| Agents are paused | The warning banner under the toolbar (§5.2); rows keep their states |
| `get_subagents` fails with rows on screen | An error banner, "Couldn't refresh the agents", with Retry; the rows stay |
| `get_subagents` fails with nothing on screen | Centred: "Couldn't load the agents", "The agent didn't answer.", and Retry |
| The transcript is still loading after 300 ms | The header and facts show at once, because they come from the snapshot. Under "Transcript", placeholder lines shaped like a reply, as `TranscriptLoading` draws them. |
| The transcript read fails | One line under "Transcript": "Couldn't load the transcript", with Retry |
| Another drawer tab is selected | The Agents icon carries the glance dot: accent while any agent works, error after a failure you haven't opened the tab since. Error wins. |

### 5.5 Visual system

Elevation:

| Layer | Holds | Treatment |
|---|---|---|
| **L0 canvas** | Rows, the detail header, transcript prose | `--omp-bg-primary` |
| **Bars** | Drawer header, toolbar, nav bar | The canvas colour, separated by a 1 px `--omp-border-muted` hairline; no shadow. The toolbar's hairline appears on scroll. |
| **L1 cards** | Facts, error, tool cards | `--omp-bg-elevated` with `--omp-border-muted`, `rounded-xl`. Tool cards keep `ToolCard`'s own shape and shadow. |
| **L2 floating** | The new-steps chip, menus, tooltips | Elevated fill, `--omp-border`, `--omp-shadow-md` |
| **L3 modal** | Definitions (`/agents`) | Unchanged |

The roster has no cards. Cards never nest. Apart from `ToolCard`'s existing shadow, only L2 casts a shadow.

Colour gives each hue one job:
- **Accent**: the working dot, the Working badge, the running tool's rail, the context bar and links.
- **Error**: the failed dot and word, the Failed badge, the error card and a failed tool's rail.
- **Warning**: the retry now-line and the paused banner.
- **Success**: finished tool rails, as `ToolCard` draws them today.

Everything else uses text tones. No row is ever filled with a colour.

Type uses the `text-omp-*` scale only:
- `md` (13.5): row titles, fact values and prose.
- `lg` (14.5), semibold: the detail heading.
- `sm` (12.5): section labels, banners, the chip and the nav bar.
- `xs` (12): now-lines, times, the crumb and badges.
- Mono only for tool names, tool arguments and output.
- Tabular figures for every time, count and amount.

Motion follows plan/22: two durations, and no layout animation.
- Rows never animate in, out or between positions. A row moves only when its activity group changes, and then it moves without animation.
- Dots don't pulse. The shimmer runs only on the detail's live intent line, never on rows; forty shimmering rows would be noise.
- The detail enters with an 8 px slide and a fade at `--omp-motion-med` with `--omp-ease-enter`, and Back reverses it.
- The nav title and the new-steps chip fade at `--omp-motion-fast`.
- With `prefers-reduced-motion`: no slide, a static muted intent line instead of the shimmer, and instant fades.

### 5.6 Accessibility

- The roster is a `role="tree"`. Each row is a `treeitem` with `aria-level`, `aria-expanded` and `aria-selected`. ↑ and ↓ move. ← collapses or goes to the parent; → expands. Enter opens the detail, and Esc goes back.
- A row's accessible name says its state in words: "Find every verifyToken caller, working, 1 minute 48 seconds, grep verifyToken".
- Status never depends on colour alone. Waiting is a different shape; failed and stopped rows carry a word; working rows carry a time and usually a now-line.
- The tab's dot is part of the tab's accessible name: "Agents, 6 working" or "Agents, 1 failed".
- One polite live region announces failures only ("Benchmark the token cache failed"). Progress is never announced.
- The dim text tone meets 4.5:1 on its canvas in both themes: about 5.9:1 in dark and 5.3:1 in light.

---

## 6. Rich transcripts (ask 3)

### 6.1 Reuse, not a second renderer

`TranscriptReader` renders a subagent's messages with the main conversation's components:

- **Tool cards**: `ToolCard` reads results from the tab's `tools` store. The reader wraps its subtree in `SessionRuntimeProvider` with a copy of the tab's runtime whose `tools` entry is a **private** store (`createToolsStore()`), filled by `hydrateMessages(messages, { turnIsLive })`. Every renderer in `tools/index.tsx` then works unchanged: diffs, bash output, nested task trees. Commands still go to the tab's sidecar.
- **Messages**: `MessageBubble` gains `readOnly`, which hides edit, fork and retry; those act on the *main* session. Copy stays.
- **Thinking**: `ThinkingBlock` with `live={false}` reads only the finished text. It still subscribes to one flag in the tab's messages store ("has streamed text started"), which is cheap and harmless here.
- **Assignment**: the subagent's first user message is the delegated prompt, often long and full of scaffolding. It leaves the transcript and renders, collapsed, as the facts card's Assignment disclosure (§5.3), with markdown.
- **Live tail**: while the agent works, the reader ends with the running tool and intent built from `progress` (§5.3). The transcript file holds only committed messages.

The private store is the contract to protect: a subagent's tool entries must never land in the main tab's `tools` store, or the main transcript would show foreign cards. The overlay reaches only components that read the store through the hook. A static `useToolsStore.getState()` follows the *focused* runtime instead. No production renderer calls it today (only tests do), and the leak test in §9 keeps it that way.

### 6.2 Live follow

While a detail view is open, its agent is working, and the drawer and window are visible, the reader polls `get_subagent_messages` from `nextByte` every 2 s. It appends the new messages and re-hydrates its private store. It stays pinned to the bottom when the reader is at its live edge (`isTranscriptAtLiveEdge`), and otherwise shows the new-steps chip (§5.3). Polling stops when the agent finishes, the detail closes, the tab loses focus or the window hides. One final read runs on the terminal frame.

The first open reads the whole file in one response (§1). The refresh affordance follows activity, not `status === "started"`, which fixes the bug in §1.

### 6.3 Where it is used

- **Drawer detail**: the full reader, under the header and facts card.
- **Dock card inline expansion**: the same reader without the header, height-capped by the dock's existing scroll owner.
- **Hub transcript drawer**: until P3 retires the Hub tab.

---

## 7. Performance

- **Frame coalescing**: `use-rpc-events.ts` queues subagent frames and applies them once per animation frame through `applyFrames(batch)`, a single store write per frame. IPC and the agent are unchanged.
- **Derivations**: `buildSubagentList`, the Active projection and the counts are memoized on the store's `Map` identity. Rows are `memo`, keyed by agent object identity, so a frame re-renders only the agents it touched.
- **No list virtualization** in this version. Most sessions show far fewer rows, and Active hides finished ones. Revisit if the gate in §9 fails at 100 agents.

---

## 8. Consolidation

| Surface | After this plan |
|---|---|
| Dock card | Unchanged role (glance). Gains "Open in sidebar", activity counts and the shared transcript reader. |
| Drawer → Agents | **New**: the monitor |
| Agent Hub → Hub tab | Retired in P3. `⌥A` and `/hub` open the drawer tab. Per-agent abort/revive and pause move into the roster. Definitions stays in the modal (`/agents`). |
| Task tool card | Unchanged in the transcript; each agent row opens that agent's detail in the drawer (P3) |
| Overview → Running | Counts working agents; the line opens the drawer tab |

---

## 9. Phases (~5 days)

| Phase | Delivers | Verification gate |
|---|---|---|
| **P1 — Activity and the drawer tab** (~2 d) | `subagentActivity`; counts and live signals fixed everywhere; frame coalescing; `AgentRoster` with Active/All and Graph, the row anatomy and now-lines (§5.2); the toolbar and the paused banner; the detail with its header and facts card over today's text transcript; the states (§5.4); the tab dot and the header label rule; "Open in sidebar" and the Overview link; en, zh and ru strings | Unit tests: activity mapping (including `live: false` → stopped, and unknown statuses); the Active projection keeps ancestors, orders siblings by activity and does not reorder on a progress-only frame; the now-line precedence, including the silent `task` parent. Component tests: no Agents tab on chat tabs; the tree's keyboard model. Synthetic load: 60 agents emitting progress every 150 ms for 60 s, no main-thread task over 50 ms. Visual review: the Electron review script spawns nested agents with the mock model and screenshots the tab in light and dark at 360, 480 and 720 px; each screenshot is checked against its prototype frame. |
| **P2 — Rich transcripts** (~2 d) | `TranscriptReader`, `MessageBubble readOnly`, the private tools store, the Assignment disclosure, the live tail, the new-steps chip and live follow; used by the drawer, the dock and the Hub; the refresh bug fixed | A subagent `bash` call and its result render as a finished card with output, not a spinner. Edit, fork and retry are absent. The main tab's `tools` store is unchanged after a transcript renders (the leak contract). Fake-timer tests: polling starts only while working and visible, reads from `nextByte`, and stops on terminal, close and blur. Visual review against `detail-working`, `detail-scrolled` and `detail-failed`. |
| **P3 — Consolidation** (~1 d) | Task card rows open the detail; `⌥A` and `/hub` open the drawer tab; abort/revive in the detail's ⋯ and pause in the roster's; Hub tab removed | The existing Hub abort/revive tests move to the roster and still pass; shortcut and command routes open the tab; the Definitions tab is unaffected |

Each phase ships with a changelog entry under `[Unreleased]` and a reply on #23 once a build can be tried.

---

## 10. Later

| Feature | Why it waits |
|---|---|
| **Token-level live output** for the open agent | Needs a per-agent `events` subscription in the agent. The 2 s poll plus the live tail covers monitoring without it. |
| **Tail-first loading** for very long transcripts | The RPC reads forward only; reading from the end needs an agent change. Measure transcript sizes first. |
| **Text search** in the roster | Active already narrows dozens of agents to the working few. Add search if users still scroll. |
| **List and detail side by side** at wide drawer widths | The pushed detail works from 360 px up; a split pane is polish. |
| **Collapse finished subtrees** in All | All is the history view; keep it literal until there is feedback. |
| **Notify when a background agent fails** | Overlaps the turn-level notifications; decide after the monitor exists. |

---

## 11. Open questions

1. **Default view.** Active when more than five agents exist, otherwise All? Or always Active, since it shows everything while nothing has finished?
2. **The dock's "View all".** Should it open the drawer tab instead of the in-dock focus mode once the tab exists? That would retire a code path, but it changes a flow design-qa.md signed off.
3. **Retiring the Hub tab.** The TUI maps `⌥A` to its hub table. Is a drawer tab an acceptable equivalent, or should the modal keep a thin Hub tab that links to it?
