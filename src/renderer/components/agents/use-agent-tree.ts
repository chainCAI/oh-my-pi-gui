/**
 * The roster projection, memoized on store identities (plan/24 §8): the
 * spawn-order list, the latest turn's members, and both trees with their
 * counts. Everything reads the runtime in context, so a sidebar row passes
 * its own tab's runtime through `SessionRuntimeProvider`.
 */

import { useMemo } from "react";
import { useStore } from "zustand";
import type { AgentMessage, SubagentSnapshot } from "../../../shared/rpc-types";
import { useMessagesStore } from "../../stores/messages";
import { sessionRuntimeStore } from "../../stores/session-runtime-context";
import { type SubagentsStore, useSubagentsStore } from "../../stores/subagents";
import {
	buildSubagentList,
	extractTaskToolCallIds,
	inSpawnOrder,
	type SubagentListRow,
	useSubagentGraphStore,
} from "../panels/subagent-graph";
import { type AgentTreeRow, buildAgentTree, latestTurn, subagentActivity, subagentTurnMembers } from "./agent-activity";

export type AgentScope = "turn" | "all";

export interface AgentProjection {
	/** Spawn-order list with depths, every agent. */
	rows: SubagentListRow[];
	/** The latest turn's tree, siblings by activity, ancestors kept as context rows. */
	turn: AgentTreeRow[];
	/** Every agent in spawn order. */
	all: AgentTreeRow[];
	turnCount: number;
	allCount: number;
	working: number;
	failed: number;
	byId: ReadonlyMap<string, SubagentSnapshot>;
}

export interface AgentProjectionInput {
	subagents: ReadonlyMap<string, SubagentSnapshot>;
	messages: readonly AgentMessage[];
	/** Tool calls of the message still streaming; they belong to the latest turn. */
	streamingToolCallIds: readonly string[];
	toolCallOwners: ReadonlyMap<string, string>;
}

export function projectAgents(input: AgentProjectionInput): AgentProjection {
	const agents = inSpawnOrder(input.subagents.values());
	const rootToolCallIds = new Set([...extractTaskToolCallIds(input.messages), ...input.streamingToolCallIds]);
	const rows = buildSubagentList(agents, rootToolCallIds, input.toolCallOwners);
	const turnScope = latestTurn(input.messages);
	for (const id of input.streamingToolCallIds) turnScope.toolCallIds.add(id);
	const members = subagentTurnMembers(rows, turnScope);
	const turn = buildAgentTree(rows, members);
	const all = buildAgentTree(rows, null);
	let working = 0;
	let failed = 0;
	for (const agent of agents) {
		const activity = subagentActivity(agent);
		if (activity === "working") working++;
		else if (activity === "failed") failed++;
	}
	return {
		rows,
		turn,
		all,
		turnCount: turn.filter(row => !row.context).length,
		allCount: all.length,
		working,
		failed,
		byId: input.subagents,
	};
}

function streamingToolCallKey(message: AgentMessage | null): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	const ids: string[] = [];
	for (const part of message.content) if (part.type === "toolCall") ids.push(part.id);
	return ids.join("\n");
}

export function useAgentProjection(): AgentProjection {
	const subagents = useSubagentsStore(state => state.subagents);
	const messages = useMessagesStore(state => state.messages);
	// A string, so text deltas of the streaming message don't recompute the tree.
	const streamingKey = useMessagesStore(state => streamingToolCallKey(state.streamingMessage));
	const toolCallOwners = useSubagentGraphStore(state => state.toolCallOwners);
	return useMemo(
		() =>
			projectAgents({
				subagents,
				messages,
				streamingToolCallIds: streamingKey ? streamingKey.split("\n") : [],
				toolCallOwners,
			}),
		[messages, streamingKey, subagents, toolCallOwners],
	);
}

/** One agent of a given tab, outside that tab's runtime provider (tab chips, sidebar rows). */
export function useTabSubagent(tabId: string, agentId: string): SubagentSnapshot | undefined {
	const store = sessionRuntimeStore<SubagentsStore>(tabId, "subagents") ?? useSubagentsStore;
	return useStore(store, state => state.subagents.get(agentId));
}
