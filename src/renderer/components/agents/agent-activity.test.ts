/**
 * Activity, turn scope and the tree the sidebar and the drawer's Agents tab
 * draw (plan/24 §4, §5.2). A regression here shows a parked agent as
 * working, drops a working one from This turn, or hides a failure.
 */

import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentProgress, SubagentSnapshot } from "../../../shared/rpc-types";
import { type AgentTreeRow, agentNowLine, cutAgentTree, subagentActivity, visibleTreeRows } from "./agent-activity";
import { projectAgents } from "./use-agent-tree";

let nextIndex = 0;

function agent(id: string, overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return { id, index: nextIndex++, agent: "explore", status: "completed", lastUpdate: 1, ...overrides };
}

function progress(overrides: Partial<AgentProgress>): AgentProgress {
	return {
		index: 0,
		id: "p",
		agent: "explore",
		agentSource: "bundled",
		status: "running",
		task: "t",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function user(text: string, steering = false): AgentMessage {
	return { role: "user", content: text, ...(steering ? { steering: true } : {}) } as AgentMessage;
}

function task(callId: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "task", arguments: {} }],
	} as AgentMessage;
}

function project(agents: SubagentSnapshot[], messages: AgentMessage[], streaming: string[] = []) {
	return projectAgents({
		subagents: new Map(agents.map(entry => [entry.id, entry])),
		messages,
		streamingToolCallIds: streaming,
		toolCallOwners: new Map(),
	});
}

/** The tree as the user reads it: indent, id, and whether the row is only context. */
function outline(rows: readonly AgentTreeRow[]): string[] {
	return rows.map(row => `${"  ".repeat(row.depth)}${row.agent.id}${row.context ? " (context)" : ""}`);
}

describe("subagentActivity", () => {
	it.each([
		["started", undefined, "working"],
		["running", false, "stopped"],
		["parked", undefined, "waiting"],
		["idle", undefined, "waiting"],
		["failed", undefined, "failed"],
		["completed", undefined, "done"],
		["aborted", undefined, "stopped"],
		["something-new", undefined, "stopped"],
	] as const)("maps %s (live %s) to %s", (status, live, expected) => {
		expect(subagentActivity(agent("a", { status, ...(live === undefined ? {} : { live }) }))).toBe(expected);
	});
});

describe("This turn", () => {
	it("keeps the latest turn's agents and older ones still working, but not older parked or finished ones", () => {
		const projection = project(
			[
				agent("old-done", { parentToolCallId: "c-old" }),
				agent("old-parked", { parentToolCallId: "c-old", status: "parked" }),
				agent("old-working", { parentToolCallId: "c-old", status: "running" }),
				agent("new", { parentToolCallId: "c-new" }),
				agent("new-child", { parentSubagentId: "new" }),
			],
			[user("first"), task("c-old"), user("second"), task("c-new")],
		);

		expect(outline(projection.turn)).toEqual(["old-working", "new", "  new-child"]);
		expect(projection.turnCount).toBe(3);
		expect(projection.allCount).toBe(5);
	});

	it("treats a steering message as part of the turn it interrupts", () => {
		const projection = project(
			[agent("before", { parentToolCallId: "c1" }), agent("after", { parentToolCallId: "c2" })],
			[user("go"), task("c1"), user("also check cookies", true), task("c2")],
		);

		expect(outline(projection.turn)).toEqual(["before", "after"]);
	});

	it("counts agents spawned by the message still streaming", () => {
		const projection = project([agent("streamed", { parentToolCallId: "c-live" })], [user("go")], ["c-live"]);

		expect(outline(projection.turn)).toEqual(["streamed"]);
	});

	it("keeps an older parent as an uncounted context row above its working child", () => {
		const projection = project(
			[
				agent("old-parent", { parentToolCallId: "c-old" }),
				agent("working-child", { parentSubagentId: "old-parent", status: "running" }),
			],
			[user("first"), task("c-old"), user("second")],
		);

		expect(outline(projection.turn)).toEqual(["old-parent (context)", "  working-child"]);
		expect(projection.turnCount).toBe(1);
		expect(projection.turn[0]).toMatchObject({ descendants: 1, workingBelow: true });
	});

	it("orders siblings by activity: working, then waiting, failed, done", () => {
		const projection = project(
			[
				agent("done", { parentToolCallId: "c" }),
				agent("failed", { parentToolCallId: "c", status: "failed" }),
				agent("waiting", { parentToolCallId: "c", status: "parked" }),
				agent("working", { parentToolCallId: "c", status: "running" }),
			],
			[user("go"), task("c")],
		);

		expect(outline(projection.turn)).toEqual(["working", "waiting", "failed", "done"]);
		// All keeps spawn order, so rows don't jump while you scan every agent.
		expect(outline(projection.all)).toEqual(["done", "failed", "waiting", "working"]);
	});
});

describe("tree cuts", () => {
	it("hides a collapsed parent's descendants and nothing after them", () => {
		const projection = project(
			[
				agent("parent", { parentToolCallId: "c" }),
				agent("child", { parentSubagentId: "parent" }),
				agent("grandchild", { parentSubagentId: "child" }),
				agent("sibling", { parentToolCallId: "c" }),
			],
			[user("go"), task("c")],
		);

		expect(outline(visibleTreeRows(projection.all, new Set(["parent"])))).toEqual(["parent", "sibling"]);
	});

	it("says how many hidden members work or failed, without counting context rows", () => {
		const projection = project(
			[
				agent("old-parent", { parentToolCallId: "c-old" }),
				...["a", "b", "c", "d"].map(id => agent(id, { parentToolCallId: "c-new" })),
				agent("hidden-working", { parentSubagentId: "old-parent", status: "running" }),
				agent("hidden-failed", { parentToolCallId: "c-new", status: "failed" }),
				agent("hidden-done", { parentToolCallId: "c-new" }),
			],
			[user("first"), task("c-old"), user("second"), task("c-new")],
		);
		// Context parent first, its working child, then failed before done.
		const cut = cutAgentTree(projection.turn, 2);

		expect(outline(cut.rows)).toEqual(["old-parent (context)", "  hidden-working"]);
		expect(cut).toMatchObject({ hidden: 6, hiddenWorking: 0, hiddenFailed: 1 });
	});
});

describe("agentNowLine", () => {
	it.each([
		[
			"a retry wins over the running tool",
			agent("a", {
				status: "running",
				progress: progress({
					currentTool: "grep",
					retryState: { attempt: 2, maxAttempts: 3, delayMs: 1000, errorMessage: "429", startedAtMs: 0 },
				}),
			}),
			{ kind: "retry", attempt: 2, maxAttempts: 3, error: "429" },
		],
		[
			"a parent running task stays silent",
			agent("a", { status: "running", progress: progress({ currentTool: "task", lastIntent: "Delegating" }) }),
			null,
		],
		[
			"the running tool wins over the intent",
			agent("a", {
				status: "running",
				progress: progress({ currentTool: "read", currentToolArgs: "src/a.ts", lastIntent: "Reading" }),
			}),
			{ kind: "tool", tool: "read", args: "src/a.ts" },
		],
		[
			"the intent shows between tools",
			agent("a", { status: "running", progress: progress({ lastIntent: "  Planning the fix " }) }),
			{ kind: "intent", text: "Planning the fix" },
		],
		[
			"a failure shows its last output",
			agent("a", { status: "failed", progress: progress({ recentOutput: ["first", "Rate limited"] }) }),
			{ kind: "error", text: "Rate limited" },
		],
		[
			"a finished agent has no now-line",
			agent("a", { progress: progress({ currentTool: "read", lastIntent: "Reading" }) }),
			null,
		],
	])("%s", (_name, snapshot, expected) => {
		expect(agentNowLine(snapshot)).toEqual(expected);
	});
});
