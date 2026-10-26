/**
 * Activity and turn scope for subagent rosters (plan/24 §4).
 *
 * The wire status is free-form and "live" lumps parked and idle agents in
 * with working ones. Every count and live signal goes through
 * `subagentActivity` instead, and the default roster shows the latest turn:
 * agents spawned since the last user message, plus anything older that is
 * still working.
 */

import type { AgentMessage, SubagentSnapshot } from "../../../shared/rpc-types";
import type { SubagentListRow } from "../panels/subagent-graph";

export type SubagentActivity = "working" | "waiting" | "failed" | "done" | "stopped";

const ACTIVITY_RANK: Record<SubagentActivity, number> = { working: 0, waiting: 1, failed: 2, done: 3, stopped: 4 };

export function subagentActivity(agent: SubagentSnapshot): SubagentActivity {
	switch (agent.status) {
		case "started":
		case "running":
			return agent.live === false ? "stopped" : "working";
		case "pending":
		case "idle":
		case "parked":
		case "waiting":
			return "waiting";
		case "failed":
			return "failed";
		case "completed":
			return "done";
		default:
			return "stopped";
	}
}

function isTurnStart(message: AgentMessage): boolean {
	return message.role === "user" && !message.steering;
}

/**
 * Ids of the tool calls the latest turn made: everything after the last user
 * message (steering stays inside its turn), including the streaming message.
 */
export function latestTurnToolCallIds(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	let start = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (isTurnStart(messages[index]!)) {
			start = index + 1;
			break;
		}
	}
	for (let index = start; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) if (part.type === "toolCall") ids.add(part.id);
	}
	return ids;
}

/**
 * Agents that belong to the latest turn. A root agent belongs when its
 * spawning tool call is in the turn; a nested agent follows its root. Any
 * agent still working belongs too, whatever turn spawned it.
 */
export function subagentTurnMembers(
	agents: readonly SubagentSnapshot[],
	turnCallIds: ReadonlySet<string>,
): Set<string> {
	const byId = new Map(agents.map(agent => [agent.id, agent]));
	const members = new Set<string>();
	for (const agent of agents) {
		if (subagentActivity(agent) === "working") {
			members.add(agent.id);
			continue;
		}
		// Climb to the topmost known agent. The agent names the main session as a
		// parent too ("Main"), so a parent that isn't a known agent ends the climb.
		let root = agent;
		const seen = new Set<string>([agent.id]);
		while (root.parentSubagentId) {
			const parent = byId.get(root.parentSubagentId);
			if (!parent || seen.has(parent.id)) break;
			seen.add(parent.id);
			root = parent;
		}
		if (root.parentToolCallId && turnCallIds.has(root.parentToolCallId)) members.add(agent.id);
	}
	return members;
}

export interface AgentTreeRow {
	agent: SubagentSnapshot;
	depth: number;
	activity: SubagentActivity;
	/** An ancestor kept so a member is never an indented orphan; not counted. */
	context: boolean;
	/** Visible children directly under this row. */
	childCount: number;
	/** Members anywhere below this row. */
	descendants: number;
	/** A member below this row is working. */
	workingBelow: boolean;
}

interface TreeNode {
	agent: SubagentSnapshot;
	children: TreeNode[];
}

/**
 * Project the spawn-order list into the roster's tree. With `members` the
 * tree keeps only members and their ancestors, ordering siblings by
 * activity; without it, every agent stays in spawn order.
 */
export function buildAgentTree(rows: readonly SubagentListRow[], members: ReadonlySet<string> | null): AgentTreeRow[] {
	const roots: TreeNode[] = [];
	const stack: TreeNode[] = [];
	for (const row of rows) {
		const node: TreeNode = { agent: row.agent, children: [] };
		stack.length = Math.min(stack.length, row.depth);
		const parent = stack.at(-1);
		if (parent) parent.children.push(node);
		else roots.push(node);
		stack.push(node);
	}

	const keep = (node: TreeNode): boolean => {
		node.children = node.children.filter(keep);
		return !members || members.has(node.agent.id) || node.children.length > 0;
	};
	const kept = roots.filter(keep);

	// A subtree ranks by its most active member, so a context parent of a
	// working agent sorts with the working ones and survives the sidebar's cut.
	const ranks = new Map<TreeNode, number>();
	const rankOf = (node: TreeNode): number => {
		let best =
			!members || members.has(node.agent.id)
				? ACTIVITY_RANK[subagentActivity(node.agent)]
				: Number.POSITIVE_INFINITY;
		for (const child of node.children) best = Math.min(best, rankOf(child));
		ranks.set(node, best);
		return best;
	};
	const sortSiblings = (nodes: TreeNode[]): void => {
		if (members) nodes.sort((a, b) => ranks.get(a)! - ranks.get(b)! || a.agent.index - b.agent.index);
		for (const node of nodes) sortSiblings(node.children);
	};
	if (members) for (const node of kept) rankOf(node);
	sortSiblings(kept);

	const out: AgentTreeRow[] = [];
	const visit = (node: TreeNode, depth: number): { members: number; working: boolean } => {
		const activity = subagentActivity(node.agent);
		const context = members !== null && !members.has(node.agent.id);
		const row: AgentTreeRow = {
			agent: node.agent,
			depth,
			activity,
			context,
			childCount: node.children.length,
			descendants: 0,
			workingBelow: false,
		};
		out.push(row);
		for (const child of node.children) {
			const below = visit(child, depth + 1);
			row.descendants += below.members;
			row.workingBelow ||= below.working;
		}
		return {
			members: row.descendants + (context ? 0 : 1),
			working: row.workingBelow || (!context && activity === "working"),
		};
	};
	for (const node of kept) visit(node, 0);
	return out;
}

/** Hide rows under collapsed parents. */
export function visibleTreeRows(rows: readonly AgentTreeRow[], collapsed: ReadonlySet<string>): AgentTreeRow[] {
	const out: AgentTreeRow[] = [];
	let hiddenBelow: number | null = null;
	for (const row of rows) {
		if (hiddenBelow !== null) {
			if (row.depth > hiddenBelow) continue;
			hiddenBelow = null;
		}
		out.push(row);
		if (row.childCount > 0 && collapsed.has(row.agent.id)) hiddenBelow = row.depth;
	}
	return out;
}

export interface AgentTreeCut {
	rows: AgentTreeRow[];
	hidden: number;
	hiddenWorking: number;
	hiddenFailed: number;
}

/** The sidebar's first rows, and what the "N more" line says about the rest. */
export function cutAgentTree(rows: readonly AgentTreeRow[], limit: number): AgentTreeCut {
	const shown = rows.slice(0, limit);
	let hidden = 0;
	let hiddenWorking = 0;
	let hiddenFailed = 0;
	for (const row of rows.slice(limit)) {
		if (row.context) continue;
		hidden++;
		if (row.activity === "working") hiddenWorking++;
		else if (row.activity === "failed") hiddenFailed++;
	}
	return { rows: shown, hidden, hiddenWorking, hiddenFailed };
}

export type AgentNowLine =
	| { kind: "retry"; attempt: number; maxAttempts: number; error: string }
	| { kind: "tool"; tool: string; args: string }
	| { kind: "intent"; text: string }
	| { kind: "error"; text: string };

/** What a row says about an agent right now (plan/24 §5.2); the first match wins. */
export function agentNowLine(agent: SubagentSnapshot): AgentNowLine | null {
	const progress = agent.progress;
	const activity = subagentActivity(agent);
	if (activity === "working" && progress) {
		const retry = progress.retryState;
		if (retry) {
			return { kind: "retry", attempt: retry.attempt, maxAttempts: retry.maxAttempts, error: retry.errorMessage };
		}
		// A parent running `task` is doing what its children do.
		if (progress.currentTool === "task") return null;
		if (progress.currentTool)
			return { kind: "tool", tool: progress.currentTool, args: progress.currentToolArgs ?? "" };
		if (progress.lastIntent?.trim()) return { kind: "intent", text: progress.lastIntent.trim() };
		return null;
	}
	if (activity === "failed") {
		const text = progress?.retryFailure?.errorMessage ?? progress?.recentOutput?.at(-1);
		return text?.trim() ? { kind: "error", text: text.trim() } : null;
	}
	return null;
}
