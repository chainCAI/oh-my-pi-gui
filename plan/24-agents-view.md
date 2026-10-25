# 24 — Agents view: every subagent gets a page, activity first

**Status**: design, revised 2026-10-26. Not started.
**Source**: [nornzach/oh-my-pi-gui#23](https://github.com/nornzach/oh-my-pi-gui/issues/23). The reporter runs sessions with dozens of subagents nested several levels deep. In a follow-up they said they mostly care about the current turn.
**Scope**: GUI only. Everything this needs is already on the wire:
- `parentSubagentId` on every nested snapshot, and `parentToolCallId` on root agents
- `AgentProgress`: current tool, tool args preview, recent tools, last intent, context use, retry state
- `get_subagent_messages` from a byte offset

The sidecar needs no rebuild.
**Out of scope**: token-level live streaming of subagent output (§11), messaging a subagent directly, and changing what the agent reports.
**Prototype**: [`mockups/24-agents-view.html`](mockups/24-agents-view.html) draws every screen in this plan with the GUI's own tokens, in light and dark. §5 is its written contract.

**What changed in this revision.** The first draft opened a subagent's transcript inside the drawer, a column 360 to 840 px wide. Codex and Claude Code give each subagent a full page that reads exactly like the main conversation, and list subagents under their session in the sidebar. This revision does the same:
- the page replaces the drawer detail;
- the sidebar lists agents under their session;
- a hover card previews an agent without opening it;
- "This turn" replaces "Active" as the default filter.

The roster, activity model, transcript reuse and performance work are unchanged.

---

## 0. What we are building

The issue asks for three things:
1. **A docked view.** You can watch agents without covering the conversation.
2. **Activity first.** Agents that are working come before parked, idle and finished ones, without losing the parent-child tree.
3. **Rich transcripts.** A subagent's transcript reads like the main conversation, with tool cards, thinking and formatted messages, not plain text.

North star: *a subagent is a page, as a session is a page.* A page has its own tab and a full-width transcript, and it is reached from wherever the agent is listed. Opening one never disturbs the conversation that spawned it. Today the same agents appear in four places with four implementations. This plan adds one roster and one page, and makes the other places link to them. It does not add a fifth list.

---

## 1. Current state (checked against the code)

| Surface | File | What it does | Gap for #23 |
|---|---|---|---|
| Sidebar | `layout/Sidebar.tsx` | Sessions grouped by workspace; each row shows the open tab's signal (`tabForSession`, `sessionTabSignal`) | Agents are not listed at all |
| Tab strip | `layout/TabBar.tsx` | One chip per pooled sidecar tab (`SessionTab`); the main process owns the list (`GET_TABS`) | No way to show anything but a session |
| Dock card above the composer | `chat/dock/AgentsDockCard.tsx` | Tree in spawn order (`buildSubagentList`), List/Graph toggle, a 5-row preview (`buildAgentDockSummary` keeps live and failed agents plus their ancestors), in-dock "view all" focus, inline transcripts | Shares a dock capped at 45% of the window height with todos, plan and queue; no activity ordering |
| Agent Hub → Hub tab | `panels/AgentHubWindow.tsx` (`HubTab`) | Flat list, live agents first (`hubStatusOrder`); status counts; pause or resume agents, abort the turn, abort or revive one agent; transcript slide-over | A **modal**: it covers the conversation. The flat list loses the hierarchy. |
| Task tool card | `tools/TaskRenderer.tsx` | Live tree for one `task` call, inside the transcript | Scrolls away with the conversation |
| Overview → Running | `panels/OverviewPanel.tsx` | First few live agents with a count | A preview with no destination to open |
| Transcript | `panels/SubagentTranscript.tsx` | `messageText()` keeps only `type === "text"` parts, cut at 1,200 characters, with a raw role label | Drops tool calls, results and thinking. No markdown. |

Findings that shape the design:

- **"Live" doesn't mean "working".** `isLiveSubagentStatus` treats `started`, `running`, `pending`, `idle` and `parked` all as live. So the dock badge (`3/40`), the Overview "N running" line, the pulsing badge and the Hub ordering all lump parked and idle agents in with working ones. This is the heart of ask 2.
- **The wire carries what an agent is doing; the rows drop it.** `progress.currentTool`, `currentToolArgs` (already a short preview, such as a path or a command), `currentToolStartMs`, `recentTools`, `lastIntent`, `retryState`/`retryFailure` and `contextTokens`/`contextWindow` all arrive. The dock row shows only `description`, model, tokens, cost and elapsed time.
- **The hierarchy needs no transcripts.** `parentSubagentId` is explicit on nested snapshots. The tool-call ownership fallback only matters for frames that predate it.
- **Turn membership needs no new field.** A root agent's `parentToolCallId` is the id of a `task` tool call in the main transcript, and that call belongs to one turn. Nested agents inherit their root's turn through `parentSubagentId`.
- **Every open tab already has live agent data.** Main forwards each sidecar's subagent frames with its tab id, and the renderer applies them to that tab's own subagents store, visible or not. One gap: the subscription is set when a tab is shown or hydrated, so a tab that booted in the background and was never shown stays silent until then (`session-hydration.ts`).
- **Sessions that aren't open in a tab have no live data.** Their agents can only be read back from session files.
- **A page can't be a `SessionTab`.** A `SessionTab` is a pooled sidecar that main tracks, restores and routes to. A subagent has no sidecar of its own; its page reads through its parent tab's sidecar.
- **The transcript read is incremental.** `readRpcSubagentTranscript` returns every complete line after `fromByte` in one response. Polling from `nextByte` costs only the new bytes.
- **A refresh bug.** A caught-up transcript keeps its refresh button only while `status === "started"`. An agent reporting `running` loses it.
- **Frame rate.** The agent coalesces progress to at most one frame per 150 ms per agent. Each frame is one IPC message and one subagents-store write, which builds a new `Map` (`hooks/use-rpc-events.ts`). With 40 working agents that can mean hundreds of store writes a second, each re-deriving the tree.
- **History.** 0.7.3 deliberately moved the drawer's Agents tab into the dock ("live execution state moved into the conversation"). The dock card is the right *glance*. The issue asks for a *monitor* and for *reading*, which are different jobs, so this plan keeps the dock card and adds the other two instead of moving the card back.
- **The event stream stays off.** `SUBAGENT_SUBSCRIPTION_LEVEL` is `progress`. The `events` level streams a full message snapshot per token for every subagent and flooded the pipe in #19.
- **The drawer header is already full.** Six views share it, and above 480 px every tab prints its label. With the real labels that strip needs about 645 px in English and 676 px in Russian, so between 480 px and that width it already scrolls sideways (`overflow-x-auto` in `layout/PanelContainer.tsx`) and hides tabs. A seventh tab raises the need to about 730 and 764 px (measured in the prototype with the locale strings; Chinese needs 554).

---

## 2. Decisions

| Decision | Choice | Rejected, and why |
|---|---|---|
| Where a subagent is read | Its own **page**, the conversation's full column, in a child tab next to its session's tab (§3.2) | The drawer detail of the first draft: a 360–840 px column that never reads like the conversation. A modal: it covers the conversation. A separate window: it needs cross-window store sync for a per-tab runtime. |
| What a page tab is | A renderer-owned **child** of a session tab. Main's tab list, routing and restore never see it (§7). | A `SessionTab` per agent: it would need a sidecar per agent, or a special case in every one of the 19 places that read `SessionTab`. |
| How many page tabs | One **preview** page per session, replaced by the next one you open; Keep open pins it | A tab per click: forty agents would bury the tab strip |
| Navigation | Agents listed **under their session in the sidebar**, this turn's only, at most 5 rows (§3.1) | All agents in the sidebar: it would grow without bound. Agents only in the drawer: the reporter wants them in view while they run. |
| Monitor | The drawer **Agents** tab: the full roster with filters, Graph and bulk actions (§3.4). Its rows open pages. | Putting filters and bulk actions in the sidebar: the sidebar navigates, it doesn't manage |
| Quick look | A **hover card** on any agent row (§3.5) | Opening a page to check one fact. An expanding row: it moves the list under the pointer. |
| Default filter | **This turn**, which means the latest turn, plus anything older still working (§4.2) | Active (working, waiting, failed): it keeps every parked agent from earlier turns in view, which the reporter doesn't care about |
| Roster implementation | One `AgentRoster` component: list, rows, filters. The drawer tab uses it; the sidebar uses its row and projection; in P3 it replaces the Hub tab. | A third roster beside the dock and the Hub |
| How much a row says | A title, one "now" line and one time. Model, tokens, cost, context and the assignment live on the page (§5.1). | Three-line rows carrying eight facts each. At 40 agents nothing stands out, and the list stops being scannable. |
| Status signal | The existing 6 px signal dot, static | A pulse on every working row: ten pulsing dots are noise, and plan/22 keeps motion for "needs you" |
| Drawer header with seven tabs | Only the selected tab prints its label; the others are icons with tooltips, at every width | Today's rule (every label above 480 px) already scrolls tabs out of view (§1). A higher breakpoint would have to sit near 770 px to fit Russian, so labels would show only close to the drawer's 840 px maximum, and a per-locale breakpoint breaks with every new string. |
| Transcript implementation | One `TranscriptReader` built on the main conversation's `MessageBubble` and `ToolCard`, used by the page and the dock's inline expansion | A separate set of "lite" renderers that drift from the main ones |
| Live page updates | Poll `get_subagent_messages` from `nextByte` every 1 s for the **shown** pages while their agents work | The `events` subscription (#19). A per-agent subscription (needs an agent change; §11). |
| Frame cost | Coalesce subagent frames per animation frame into one store write | Throttling in the agent: it is shared with the TUI and already at 150 ms |

---

## 3. Where agents appear

```
┌ sidebar ────────────────┬──────────────────────────────────────────────────────────────────┐
│ aurora-web              │ [● Harden the auth flow] [↳ ● Find every verifyToken caller ×] + │  tab strip
│ ● Harden the auth flow  │ … › Map the auth surface › Find every verifyToken caller ● Working│  title bar
│ ├ ● Map the auth surf…  │                                                                  │
│ │ ├ ● Find every veri…  │        ┌──────────── the conversation's column ───────────┐       │
│ │ ├ ● Read the sessio…  │        │                    ↳ From Map the auth surface   │       │
│ │ └ ○ Check the token…  │        │          Find every call site of verifyToken() … │       │
│ ├ ● Rewrite the login…  │        │ I'll start with a repository-wide search …       │       │
│ └ 8 more · 4 working ·… │        │ ✓ grep   verifyToken src/                         │       │
│ ● Fix the flaky e2… (●3)│        │ ◌ grep   verifyToken packages/            0:12    │       │
│                         │        └──────────────────────────────────────────────────┘       │
│                         │        ┌ agent bar, where the composer sits ───────────────┐      │
│                         │        │ ↳ Takes instructions from Map the auth surface     │      │
│                         │        │ explore  claude-sonnet-4.5         [■ Stop agent] ⋯│      │
│                         │        └────────────────────────────────────────────────────┘      │
│                         │          14 steps                               ━━── 31% of 200k   │
└─────────────────────────┴──────────────────────────────────────────────────────────────────┘
```

| Place | Job | Shows |
|---|---|---|
| Sidebar, under the session | Navigate | This turn's agents, at most 5 rows, live |
| Child tab → page | Read | One agent's whole transcript, full width, live |
| Page beside the conversation | Read while watching the parent | The same page in a pane split with its session |
| Drawer → Agents | Monitor and manage | The whole roster: filters, Graph, pause, stop |
| Hover card | Check one agent without opening it | Status, now-line, the last three steps |
| Dock card | Glance from the composer | Unchanged |

### 3.1 Sidebar: agents under their session

A session row that has agents in this turn can expand. Expanded, its agents nest under it as 28 px rows joined by elbow guides, the same row the roster uses (§5.2) without the now-line.

- **Which agents**: the This turn projection (§4.2) in tree order, siblings by activity. The first five rows show, then an "8 more" row that opens the drawer's Agents tab. When the hidden rows include working or failed agents, the row says how many: "8 more · 4 working · 1 failed", so a hidden failure is never silent.
- **Depth**: two levels of indent. A deeper agent sits at the second level, and its page's breadcrumb gives the full path.
- **Toggle**: the sidebar has no free column for a chevron, so the session row's 16 px signal slot shows the disclosure chevron while the row is hovered or focused, and the signal otherwise. ← and → collapse and expand the focused row.
- **Collapsed**: the session row keeps a count pill after its title ("● 3"), led by an accent dot while any of them works. Clicking the pill expands the row. The row's own signal still means the session.
- **Default**: a session expands the first time it spawns agents in a turn. After that your choice sticks for that session while it is open. Nothing expands or collapses on its own later, so rows never move under the pointer.
- **Selected**: a row whose page is shown takes the sidebar's selection fill; its session row drops to the hover fill.
- **Scope**: only sessions open in a tab list agents, because only they have live data (§1). Other sessions keep a plain row (§12.4).

### 3.2 The page, in a child tab

Clicking an agent anywhere (§3.6) opens its page in a **child tab** right after its session's chip. It doesn't leave the session: the conversation keeps running, its scroll and draft are kept, and its chip's signal stays live.

- **Chip**: the `TabChip` shape with a ↳ (corner-down-right) glyph in place of the worktree or chat icon, then the agent's signal and title. A preview chip sets its title in italic, like an editor's preview tab.
- **Preview**: each session has at most one preview page. Opening another agent replaces it. Double-clicking the chip, or Keep open in its menu, pins the page; a pinned page stays until closed.
- **Order**: child chips sit right after their parent, pinned ones first, preview last. They can't be dragged away from their parent.
- **Selection**: a selected child chip takes the active style, and its parent shows the `visible` ring, so you can see whose agent it is. Main's active tab stays the parent (§7).
- **Closing**: × or ⌘W closes the page and shows its session. Closing a session closes its pages, and the session's close confirmation counts its working agents.
- **Restart**: page tabs are not restored in v1 (§12.1).

The page itself is drawn in §5.4: the conversation's column and components, with the agent bar where the composer sits.

### 3.3 Beside the conversation

⌥-clicking an agent, or Open beside in its menu, shows the page in a pane split with its session: the conversation on the left, the page on the right. This reuses the split view's divider, ratio and pane headers. It is still one tab, and its child chip shows a columns glyph.

- **Already split**: when the window shows two tabs side by side, Open beside opens the page in a child tab instead. Splits don't nest.
- **Leaving**: the page pane's × closes the page. Dragging its chip out isn't supported.

### 3.4 The drawer monitor

The **Agents** drawer tab is the monitor: the full roster with filters, Graph and bulk actions (§5.2). It isn't in `CHAT_PANEL_TABS`, because chat tabs have no tools and no subagents. Its rows open pages; there is no detail view inside the drawer.

- **Content**: a list (This turn or All, §4.2) or the Graph (the existing `SubagentDag`).
- **Header**: the tab-label rule in §2, which replaces the 480 px rule in `global.css` for every view, not only this one. Every tab keeps its `aria-label` and tooltip. Below 400 px the selected tab drops its label too, so the seven icons and the close button still fit the 360 px minimum.
- **Narrow windows**: at 1000 px and below the drawer already overlays the conversation, and the tab follows that rule.
- **Split view**: the tab shows the focused pane's runtime, like Diff and Files.
- **A shown page**: its row has the selection fill, so the monitor and the page agree on which agent you are reading.

### 3.5 Hover card

Resting the pointer on an agent row for 400 ms shows a floating card (L2, 300 px wide) beside the row. It works on sidebar rows, roster rows, dock rows and task card rows. Moving to another row swaps the card at once; leaving hides it after 150 ms.

```
╭───────────────────────────────────────╮
│ Find every verifyToken caller         │
│ (● Working)  1m 48s · explore · sonnet│
│ grep  verifyToken · packages/    0:12 │   now-line
│ ✓ grep   verifyToken src/             │   last three steps,
│ ✓ bash   rg -c "verifyToken\(" …      │   from progress.recentTools
│ ✓ read   src/auth/session.ts          │
│ Click to open · ⌥-click to open beside│
╰───────────────────────────────────────╯
```

Everything on the card comes from the snapshot and `progress`, so it never reads a transcript. Keyboard focus on a row shows the same card after the same delay, and Esc hides it.

### 3.6 Entry points

| From | Click | ⌥-click |
|---|---|---|
| A sidebar agent row | Opens the page (preview) | Opens it beside |
| A drawer roster row | Opens the page (preview) | Opens it beside |
| A dock card row | Opens the page (preview) | Opens it beside |
| A task tool card's agent row | Opens the page (preview) | Opens it beside |
| Overview → Running | Opens the drawer's Agents tab | — |
| "8 more" in the sidebar, "Open in sidebar" in the dock card | Opens the drawer's Agents tab | — |
| A page's breadcrumb segment | Opens that ancestor's page, or the session | — |

The dock card's inline transcript expansion stays, behind its own chevron at the start of the row, so the rest of the row can open the page (§6.3).

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
- the sidebar's count pill
- the Agents tab's dot
- the Hub's status badges

### 4.2 Two filters: This turn and All

**This turn** is the latest turn: everything from the last user message on. While the session is idle it still means the turn that just ended, so finished agents stay in view until you send the next message.

`subagentTurnScope(agents, messages)` builds it:
1. Collect the ids of the tool calls in the assistant messages after the last user message, plus the streaming message.
2. A root agent belongs to this turn when its `parentToolCallId` is in that set. A nested agent belongs to the turn of its root, found through `parentSubagentId`.
3. Add any agent from an older turn that is still **working**. A parked agent from an older turn isn't added, because it is doing nothing.
4. Keep each member's ancestors. An ancestor that isn't a member stays as a muted context row, so no row is ever an indented orphan; this reuses `buildAgentDockSummary`'s ancestor walk.
5. Advisors (`kind: "advisor"`) have no tool call; they count while working.

Siblings are ordered working → waiting → failed → done → stopped, with spawn index as the tie-break. A subtree ranks by its most active member, so a context row above a working agent sorts with the working rows and survives the sidebar's five-row cut. Ancestors of working rows start expanded.

**All** is today's spawn-order tree. Nothing is hidden or reordered.

Each segment carries its count ("This turn 13", "All 34"). The count includes agents under a collapsed parent, but not context rows. This is the only number of agents the drawer prints; the sidebar pill shows the same This turn count.

**Order is stable.** A row moves only when its activity group changes. Progress frames never reorder the list, so rows don't jump while you read them.

This turn is the default everywhere. The drawer remembers a switch to All per tab while the tab is open. An empty This turn says so and offers "Show all" (§5.6).

---

## 5. Presentation

The first draft of this plan put every fact the wire carries on every row. The result was hard to read: status was printed twice per row, every working row pulsed, counts appeared in three places and nothing set one row apart from another. This section is the visual contract that replaced it. Each screen below has a frame in the prototype.

### 5.1 Three layers of detail

| Layer | Question it answers | Where | What it shows |
|---|---|---|---|
| **Glance** | Is anything running, or did something break? | The Agents tab's dot, the sidebar pill, the dock card, Overview → Running | A dot or a count |
| **Scan** | Which agents are there, and what is each one doing now? | Sidebar rows, roster rows, the hover card | A signal, a title, one now-line, one time |
| **Inspect** | What exactly has this agent done? | The page | The assignment, the transcript, the live tail, and the facts in the title bar, agent bar and status line |

Each fact has one home. Model, tokens, cost, context share and the assignment belong to the page and never appear on a row; the hover card shows only type and model. A row carries one time; the current tool's own elapsed time is an inspect fact.

### 5.2 Roster

Frames `roster-turn` (dark, 400 px) and `roster-all` (light, 520 px).

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
- **Tree**: each level indents 14 px and draws one hairline guide (`--omp-border-muted`) down from its parent's signal dot. Indentation stops growing after six levels; deeper rows keep the sixth level's indent, and the page's breadcrumb gives the full path. A collapsed parent shows a pill with the number of agents it hides, led by an accent dot when any of them is working.
- **Open**: click opens the page, ⌥-click opens it beside, and the row of the shown page keeps the selection fill.
- **Sanitizing**: all wire text goes through the `lib/format.ts` helpers (tabs, truncation, home-path shortening), as in tool renderers.

**Toolbar** (44 px, sticky; frame `roster-turn`):
- Left: the filter, a small segmented control: "This turn 13 | All 34".
- Right: the presentation (List | Graph) as a separate icon segmented control, so a filter and a view are never the same control. Then ⋯ with Pause agents (or Resume agents), Stop the turn, Expand all and Collapse all.
- The toolbar gets a hairline bottom border only once the list scrolls under it.
- While agents are paused, a warning banner sits under the toolbar: "Agents are paused" with a Resume link. Resume is the one menu action that also appears outside the menu, because it is the way out of a state the user may have forgotten entering.

### 5.3 Sidebar rows

Frame `sidebar-rows` (dark), and the sidebar in `window-page`.

```
●  Harden the auth flow                    2m      session row, expanded
├ ●  Map the auth surface                          agent rows: 28 px, elbow guides
│ ├ ●  Find every verifyToken caller
│ ├ ●  Read the session middleware
│ └ ○  Check the token refresh tests
├ ●  Rewrite the login handler
└    8 more · 4 working · 1 failed
●  Fix the flaky e2e run   (● 3)        14m      collapsed: a count pill
```

- **Row**: the session row's height minus 2 px (28 px), the same radius and fills. The 16 px signal slot, then the title in `text-omp-sm`, then a time only for failed rows ("Failed" in error tone). Working and waiting rows carry no time: the sidebar is too narrow for two numbers per row, and the hover card has it.
- **Tone**: working titles in `--omp-text-secondary`, everything else in `--omp-muted`. The session row stays the brightest thing in its group.
- **Guides**: an elbow (├ └) with a rounded corner from the session's signal dot, then from each parent's dot, in `--omp-border` (the muted border disappears on the sidebar's darker canvas). The indent is 14 px per level, two levels at most.
- **More**: "8 more" in `--omp-dim`, indented like a first-level row, with no signal. Hidden working and failed counts follow it, the failed count in error tone.
- **Count pill**: on a collapsed session row, the pill used for a collapsed roster parent: `text-omp-xxs`, a hairline border, led by a 5 px accent dot while any agent works.
- **Chevron**: hovered or focused, the session row's slot shows ⌄ when expanded and › when collapsed, in `--omp-dim`.

### 5.4 The page

Frames `window-page` (dark, 1280 × 800), `window-beside` (light) and `page-failed` (light).

**Tab chip** (§3.2): ↳, the agent's signal, the title, ×. A preview chip's title is italic. It is never wider than its parent's `max-w-52`.

**Title bar**: the session's breadcrumb gains the agent: "aurora-web › Harden the auth flow › Map the auth surface › Find every verifyToken caller". For a nested agent the middle segments are its ancestors, collapsed to "…" past two; each segment opens that page. The page fills the title bar's slots the way a session does, with the agent's facts in place of the session's:
- after the last segment, the status where the session shows "Ready": "● Working", or "● Failed" in error tone;
- on the right, the agent's tokens, cost and time in the session's mono figures.

**Transcript column**: the conversation's own column (`max-w-[760px]`, centred) and spacing.
1. **Assignment**: the first bubble is the delegated prompt, labelled "From \<parent\>", where the parent is the parent agent's title, or "the conversation" for a root agent. It is collapsed to three lines with "Show all", because a delegated prompt is often long and full of scaffolding. Markdown, read-only.
2. **Messages, thinking and tool cards**: the main conversation's components (§6.1), so a subagent's diff or bash output looks exactly like the parent's.
3. **Live tail**: while the agent works, a row just above the agent bar shows its running tool from `progress` (a spinner, `currentTool` and its args, the time since `currentToolStartMs`) and the intent in `.omp-shimmer-text`. It sits outside the transcript, so it never moves the reader's scroll as messages arrive. The transcript file holds only committed messages, so this is the page's only "now".
4. **Result**: once the agent ends, its final message is the last bubble; the agent bar's top line says where it went (below).
5. **Error card** (failed agents): where the run stopped, as the conversation shows a failed turn. It has an error-dim fill, an alert icon, a one-line summary in error tone ("Stopped after 3 attempts") and the message in secondary text.

**Scrolling**: the conversation's own rules. The page opens at the live edge for a working agent and at the top for a finished one. Scrolled above the live edge, arriving messages show the conversation's "↓ 3 new steps" pill at the bottom centre.

**Agent bar**: a read-only bar in the composer's shell and position, so the page keeps the conversation's shape.
- Top line, where the input sits, in `--omp-dim` with ↳: "Takes instructions from Map the auth surface" while the agent works or waits, so it is clear why you can't type here; "Ended · reported to Map the auth surface" once it has ended.
- Bottom row, where the composer's controls sit:
  - left: the agent type with the bot icon, then the model, where the composer shows its model picker (a fallback model says so in warning tone);
  - right: Stop agent while `(live || stale) && kind !== "advisor"`, Revive while parked and not an advisor, then ⋯ with Open beside (or Open in tab), Keep open, Copy transcript and Show in Agents.
- Stop and Revive keep the Hub's conditions and commands (`abort_subagent`, `revive_subagent`).
- The status line under the bar: steps on the left, and on the right the context bar and share where the session shows its own, when `contextWindow` is known.

So every fact sits where its session counterpart sits: status in the title, tokens and cost on the right of the title bar, model in the bar, context in the status line.

**Beside** (`window-beside`): the conversation and the page are two panes of the split view, each with the 32 px pane header. The page's header shows ↳, the agent's signal, its title and ×. The divider, ratio and minimum widths are the split view's. The column inside each pane is capped at 760 px as usual.

### 5.5 Hover card

Frame `sidebar-rows`.

- L2: `--omp-bg-elevated`, `--omp-border`, `--omp-shadow-md`, `rounded-xl`, 300 px wide, 12 px padding.
- The title in `text-omp-md` semibold, wrapping to two lines at most.
- A subline: the status `Badge` with `dot`, then the time, type and model in `text-omp-xs` `--omp-dim`.
- The now-line from §5.2, without its retry tone when the badge already says Retrying.
- Up to three finished steps from `progress.recentTools`, newest last: a success check, the tool name in mono and its args in mono dim, one line each.
- A footer in `text-omp-xxs` `--omp-dim`: "Click to open · ⌥-click to open beside".
- Placed to the right of a sidebar row, and to the left of a drawer row, so it never covers the list it came from. It flips vertically to stay in the window.

### 5.6 States

Frame `states`, plus the glance frame `glance`.

| State | Shown as |
|---|---|
| The session has no subagents | Drawer: centred icon, "No subagents yet", "When the agent hands work to subagents, they appear here while they run." No toolbar. Sidebar: no chevron on the session row. |
| This turn is empty | Drawer: centred "Nothing this turn", "Agents from earlier turns are under All.", and a Show all button. Sidebar: no chevron. |
| Agents are paused | The warning banner under the toolbar (§5.2); rows keep their states |
| `get_subagents` fails with rows on screen | An error banner, "Couldn't refresh the agents", with Retry; the rows stay |
| `get_subagents` fails with nothing on screen | Centred: "Couldn't load the agents", "The agent didn't answer.", and Retry |
| A page's transcript is still loading after 300 ms | The Assignment bubble and the agent bar show at once, because they come from the snapshot. Under them, placeholder lines shaped like a reply, as `TranscriptLoading` draws them. |
| A page's transcript read fails | Under the Assignment: "Couldn't load the transcript", with Retry. The live tail still shows. |
| The agent leaves the roster while its page is open | The page stays as it was, with "This agent is no longer reported by the session" above the agent bar, whose actions turn off |
| Another drawer tab is selected | The Agents icon carries the glance dot: accent while any agent works, error after a failure you haven't opened the tab or the page since. Error wins. |

### 5.7 Visual system

Elevation:

| Layer | Holds | Treatment |
|---|---|---|
| **L0 canvas** | Rows, the page's transcript | `--omp-bg-primary` |
| **Bars** | Drawer header, toolbar, tab strip, title bar, pane headers | The canvas colour, separated by a 1 px `--omp-border-muted` hairline; no shadow. The toolbar's hairline appears on scroll. |
| **L1 cards** | The agent bar (the composer's shell), the error card, tool cards, message bubbles | As the conversation draws them |
| **L2 floating** | The hover card, the new-steps pill, menus, tooltips | Elevated fill, `--omp-border`, `--omp-shadow-md` |
| **L3 modal** | Definitions (`/agents`) | Unchanged |

The roster and the sidebar have no cards. Cards never nest. The page adds no surface the conversation doesn't already have.

Colour gives each hue one job:
- **Accent**: the working dot, the Working badge, the running tool's rail, the context bar and links.
- **Error**: the failed dot and word, the Failed badge, the error card and a failed tool's rail.
- **Warning**: the retry now-line and the paused banner.
- **Success**: finished tool rails and the hover card's step checks, as `ToolCard` draws them today.

Everything else uses text tones. No row is ever filled with a colour.

Type uses the `text-omp-*` scale only:
- `md` (13.5): roster titles, prose and the hover card title.
- `sm` (12.5): sidebar agent rows, the agent bar, section labels, banners and the pill.
- `xs` (12): now-lines, times, the breadcrumb's last segment and badges.
- `xxs` (11): the count pill and the hover card footer.
- Mono only for tool names, tool arguments and output.
- Tabular figures for every time, count and amount.

Motion follows plan/22: two durations, and no layout animation.
- Rows never animate in, out or between positions. A row moves only when its activity group changes, and then it moves without animation.
- Dots don't pulse. The shimmer runs only on the page's live intent line, never on rows; forty shimmering rows would be noise.
- A page swaps in like a tab does today: no slide.
- The hover card and the new-steps pill fade at `--omp-motion-fast`.
- With `prefers-reduced-motion`: a static muted intent line instead of the shimmer, and instant fades.

### 5.8 Accessibility

- The roster is a `role="tree"`. Each row is a `treeitem` with `aria-level`, `aria-expanded` and `aria-selected`. ↑ and ↓ move. ← collapses or goes to the parent; → expands. Enter opens the page, ⌥Enter opens it beside.
- The sidebar's agent rows are a nested `group` under their session's item, with the same keys.
- A row's accessible name says its state in words: "Find every verifyToken caller, working, 1 minute 48 seconds, grep verifyToken".
- A child chip is a `tab` whose name starts with its parent: "Harden the auth flow, agent: Find every verifyToken caller, working". ⌃Tab and ⌃⇧Tab move through child chips like any tab.
- The hover card is `role="tooltip"`, linked by `aria-describedby`; it never takes focus.
- The agent bar's top line is the page's description, so a screen reader says why there is no input.
- Status never depends on colour alone. Waiting is a different shape; failed and stopped rows carry a word; working rows carry a time and usually a now-line.
- The tab's dot is part of the tab's accessible name: "Agents, 6 working" or "Agents, 1 failed".
- One polite live region announces failures only ("Benchmark the token cache failed"). Progress is never announced.
- The dim text tone meets 4.5:1 on its canvas in both themes: about 5.9:1 in dark and 5.3:1 in light.

---

## 6. Rich transcripts (ask 3)

### 6.1 Reuse, not a second renderer

The page renders the conversation's own `ChatStream` under an overlay runtime (`createAgentPageRuntime`):

- **Stores**: the overlay copies the tab's runtime. Subagents, the spawn graph, settings and model are the tab's own. Session, messages, tools, queue, todo, composer, side questions, plan approval and extension UI are **private** stores, filled from the agent's transcript (`hydrateMessages(messages, { turnIsLive })` for tools). Every renderer in `tools/index.tsx` then works unchanged: diffs, bash output, nested task trees. The overlay is cached per page and never registered, so window-level lookups by tab id still find the session.
- **Commands**: only `get_*` reads pass through to the tab's sidecar; everything else is refused, so nothing on a page can act on the session.
- **Messages**: `ReadOnlyTranscriptContext` hides edit, fork and retry in `MessageBubble`, and the conversation-only parts of `ChatStream` (the empty state, the tools-tab extras); those act on the *main* session. Copy stays.
- **Thinking**: `ThinkingBlock` with `live={false}` reads only the finished text. It still subscribes to one flag in the tab's messages store ("has streamed text started"), which is cheap and harmless here.
- **Assignment**: the subagent's first user message is the delegated prompt. It renders as the "From \<parent\>" bubble (§5.4), collapsed, with markdown.
- **Live tail**: while the agent works, a row above the agent bar shows the running tool and intent built from `progress` (§5.4).

The private store is the contract to protect: a subagent's tool entries must never land in the main tab's `tools` store, or the main transcript would show foreign cards. The overlay reaches only components that read the store through the hook. A static `useToolsStore.getState()` follows the *focused* runtime instead. No production renderer calls it today (only tests do), and the leak test in §10 keeps it that way.

### 6.2 Live follow

While a page is shown (selected in its tab, or open beside), its agent is working and the window is visible, the reader polls `get_subagent_messages` from `nextByte` every 1 s. It appends the new messages and re-hydrates its private store. It stays pinned to the bottom when the reader is at its live edge (`isTranscriptAtLiveEdge`), and otherwise shows the new-steps pill (§5.4). One final read runs on the terminal frame.

Polling stops when:
- the agent finishes;
- the page is closed, or another tab or page is selected;
- the window hides.

A pinned page that isn't shown keeps its messages and catches up from `nextByte` when it is shown again. The 1 s interval costs one small command per shown page. Each read waits in the tab's sidecar command queue; since the coding-agent fix for #19, a running compaction or handoff no longer holds that queue. P2 checks that the poll doesn't delay the conversation's own commands.

The first open reads the whole file in one response (§1). The refresh affordance follows activity, not `status === "started"`, which fixes the bug in §1.

### 6.3 Where it is used

- **The page**: the full reader, from the Assignment bubble to the live tail.
- **Dock card inline expansion**: today's `SubagentTranscript`, unchanged, behind the row's chevron. Moving it to the overlay runtime is follow-up work.
- **Hub transcript drawer**: until P3 retires the Hub tab.

---

## 7. Page tabs: model and routing

Pages are renderer state, kept beside the tabs store, never in it:

```ts
interface AgentPage {
	agentId: string;
	pinned: boolean;
}
interface AgentPagesState {
	/** Open pages per session tab, pinned first, at most one unpinned. */
	pages: Record<string, AgentPage[]>;
	/** What each session tab shows: its conversation, or one of its pages. */
	shown: Record<string, string | null>;
	/** A page open beside its session's conversation, per session tab. */
	beside: Record<string, string | null>;
}
```

- **Routing**: main's active tab stays the parent session whether its conversation or a page is shown. `routeTabView`, `visibleTabIds` and `SET_ACTIVE_TAB` don't change, so the parent's sidecar keeps streaming into its stores.
- **Selecting a child chip**: sets `shown[parent] = agentId` and, if the parent isn't active, switches to the parent first. Selecting the parent's chip sets `shown[parent] = null`.
- **The session pane**: renders the conversation or the page by `shown`. The conversation unmounts while a page is shown and comes back as it was: `ChatStream` saves its scroll anchor to the session store's transcript view on unmount (the path tab switching uses), the draft lives in the tab's composer store, and streaming state lives in the tab's stores.
- **Beside**: `beside[parent]` renders the session pane as a two-pane split. It is refused while the window split holds two tabs.
- **Split view between tabs**: each pane follows its own tab's `shown`. Child chips of both tabs show in the strip.
- **Closing**: closing a session tab deletes its entries. An agent that leaves the roster leaves its page open (§5.6).
- **Persistence**: none in v1. Pages close with the window (§12.1).
- **Background tabs**: the sidebar lists agents for every open tab, so P3 sets the `progress` subscription on every ready tab, not only on shown or hydrated ones (§1). It goes through the tab-addressed command (`commandForTab`); without one, only the shown tab subscribes, because the active-tab fallback would reach the wrong sidecar. Frame coalescing (§8) carries the cost.

---

## 8. Performance

- **Frame coalescing**: `use-rpc-events.ts` queues subagent frames and applies them once per animation frame through `applyFrames(batch)`, a single store write per frame. IPC and the agent are unchanged.
- **Derivations**: `buildSubagentList`, `subagentTurnScope`, the counts and the sidebar's five-row cut are memoized on the store's `Map` identity and the messages store's tool-call ids. Rows are `memo`, keyed by agent object identity, so a frame re-renders only the agents it touched.
- **Sidebar**: the sidebar subscribes to each open tab's subagents store only while that session row is expanded; a collapsed row reads the count once per coalesced frame.
- **Pages**: a page that isn't shown doesn't poll and doesn't re-render on frames, apart from its chip's signal.
- **No list virtualization** in this version. Most sessions show far fewer rows, and This turn hides older ones. Revisit if the gate in §10 fails at 100 agents.

---

## 9. Consolidation

| Surface | After this plan |
|---|---|
| Sidebar | **New**: this turn's agents under each open session |
| Page | **New**: where every agent is read |
| Drawer → Agents | **New**: the monitor; rows open pages |
| Dock card | Unchanged role (glance). Gains "Open in sidebar", activity counts, the shared transcript reader, and rows that open pages. |
| Agent Hub → Hub tab | Retired in P3. `⌥A` and `/hub` open the drawer tab. Per-agent stop and revive move to the page's agent bar; pause moves to the roster. Definitions stays in the modal (`/agents`). |
| Task tool card | Unchanged in the transcript; each agent row opens that agent's page |
| Overview → Running | Counts working agents; the line opens the drawer tab |

---

## 10. Phases (~6 days)

| Phase | Delivers | Verification gate |
|---|---|---|
| **P1 — Activity, turn scope and the monitor** (~2 d) | `subagentActivity` and `subagentTurnScope`; counts and live signals fixed everywhere; frame coalescing; `AgentRoster` with This turn/All and Graph, the row anatomy and now-lines (§5.2); the toolbar and the paused banner; the states (§5.6); the tab dot and the header label rule; "Open in sidebar" and the Overview link; rows open today's Hub transcript until P2; en, zh and ru strings | Unit tests: activity mapping (including `live: false` → stopped, and unknown statuses); turn scope (a root agent from an earlier turn drops out, a nested agent follows its root, an older working agent stays, an older parked one doesn't, an advisor counts only while working); the projection keeps ancestors, orders siblings by activity and does not reorder on a progress-only frame; the now-line precedence, including the silent `task` parent. Component tests: no Agents tab on chat tabs; the tree's keyboard model. Synthetic load: 60 agents emitting progress every 150 ms for 60 s, no main-thread task over 50 ms. Visual review: the Electron review script spawns nested agents with the mock model and screenshots the tab in light and dark at 360, 480 and 720 px against `roster-turn` and `roster-all`. |
| **P2 — The page** (~2.5 d) | `TranscriptReader`, `MessageBubble readOnly`, the private tools store, the Assignment bubble, the live tail, the result line and live follow; the page tab model (§7), child chips, preview and Keep open; the breadcrumb and the agent bar with Stop and Revive; Open beside; every roster, dock and task card row opens the page; the refresh bug fixed | A subagent `bash` call and its result render as a finished card with output, not a spinner. Edit, fork and retry are absent. The main tab's `tools` store is unchanged after a page renders (the leak contract). Showing a page leaves main's active tab, the conversation's scroll position and its draft unchanged, and the parent keeps streaming. Opening a second agent replaces the preview; a pinned page stays. Closing the session closes its pages. Fake-timer tests: polling starts only while shown and working, reads from `nextByte`, and stops on terminal, close, switch and hide. Visual review against `window-page`, `window-beside` and `page-failed`. |
| **P3 — Sidebar, hover card and consolidation** (~1.5 d) | Agents under their session in the sidebar (§5.3) with the pill and "N more"; the `progress` subscription on every ready tab; the hover card on every agent row; `⌥A` and `/hub` open the drawer tab; pause in the roster's ⋯; Hub tab removed | The sidebar's five-row cut keeps ancestors and counts hidden working agents; a collapsed row's pill matches the drawer's This turn count; a background tab's agents appear without showing the tab. The hover card opens after 400 ms, swaps between rows without a delay and never reads a transcript. The existing Hub abort/revive tests move to the agent bar and still pass; shortcut and command routes open the tab; the Definitions tab is unaffected. Visual review against `sidebar-rows`. |

Each phase ships with a changelog entry under `[Unreleased]` and a reply on #23 once a build can be tried.

**Status (2026-10-26).** Built in the order the issue's reporter ranked it (page and sidebar first, the drawer tab last): activity and This turn, the page in a child tab with the agent bar, Stop/Revive, the breadcrumb and Open beside, the sidebar rows with the pill and "N more", the hover card on sidebar and roster rows, and the Agents tab with This turn/All, Graph, the ⋯ menu, the paused banner, the states and the tab dot. Still to do:
- task tool cards' agent rows open pages, and the hover card on dock and task card rows;
- "Open in sidebar" in the dock card;
- retiring the Hub tab: `⌥A` and `/hub` still open the Agent Hub window;
- frame coalescing and the synthetic load gate (§8), the new-steps pill on pages, and the visual review at 480 and 720 px.

---

## 11. Later

| Feature | Why it waits |
|---|---|
| **Token-level live output** on a page | Needs a per-agent `events` subscription in the agent. The 1 s poll plus the live tail covers reading without it. |
| **Messaging a subagent** from its agent bar | No RPC sends a message to a subagent; the agent would need one, and the parent would need to know. |
| **Agents of sessions not open in a tab** | They have no live data; listing them means reading session files. Decide after §12.4. |
| **Restoring page tabs** after a restart | Needs main to persist renderer state it doesn't own today (§12.1) |
| **Tail-first loading** for very long transcripts | The RPC reads forward only; reading from the end needs an agent change. Measure transcript sizes first. |
| **Text search** in the roster | This turn already narrows dozens of agents to the few that matter. Add search if users still scroll. |
| **Collapse finished subtrees** in All | All is the history view; keep it literal until there is feedback. |
| **Notify when a background agent fails** | Overlaps the turn-level notifications; decide after the monitor exists. |

---

## 12. Open questions

1. **Restoring pages.** Is it acceptable that page tabs close on restart in v1, or should pinned pages come back with their session?
2. **The dock's "View all".** Should it open the drawer tab instead of the in-dock focus mode once the tab exists? That would retire a code path, but it changes a flow design-qa.md signed off.
3. **Retiring the Hub tab.** The TUI maps `⌥A` to its hub table. Is a drawer tab an acceptable equivalent, or should the modal keep a thin Hub tab that links to it?
4. **Sessions not open in a tab.** Should their rows list the agents of their last turn, read once from the session file, or stay plain as planned?
