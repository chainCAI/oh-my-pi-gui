/**
 * The title bar while a page is shown (plan/24 §5.4): the session's
 * breadcrumb gains the agent and its ancestors, and the status and figures
 * slots carry the agent's facts in place of the session's.
 */

import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useAgentPagesStore } from "../../stores/agent-pages";
import { useSubagentsStore } from "../../stores/subagents";
import { subagentPrimaryLabel } from "../panels/subagent-graph";
import { ACTIVITY_TONE, AgentFacts, AgentSignal, useActivityLabel } from "./AgentPage";
import { subagentActivity } from "./agent-activity";

/** Middle segments past this many collapse to "…" (the page has the full path). */
const MAX_ANCESTORS = 2;

function ancestorsOf(agent: SubagentSnapshot, byId: ReadonlyMap<string, SubagentSnapshot>): SubagentSnapshot[] {
	const out: SubagentSnapshot[] = [];
	const seen = new Set([agent.id]);
	let current = agent.parentSubagentId ? byId.get(agent.parentSubagentId) : undefined;
	while (current && !seen.has(current.id)) {
		out.unshift(current);
		seen.add(current.id);
		current = current.parentSubagentId ? byId.get(current.parentSubagentId) : undefined;
	}
	return out;
}

export function AgentCrumbs({ tabId, agentId }: { tabId: string; agentId: string }) {
	const t = useT();
	const subagents = useSubagentsStore(state => state.subagents);
	const agent = subagents.get(agentId);
	if (!agent) return null;
	const ancestors = ancestorsOf(agent, subagents);
	const hidden = ancestors.length > MAX_ANCESTORS ? ancestors.slice(0, ancestors.length - MAX_ANCESTORS) : [];
	const shownAncestors = ancestors.slice(hidden.length);
	const title = subagentPrimaryLabel(agent);
	return (
		<>
			{hidden.length > 0 && (
				<>
					<ChevronRight className="shrink-0 text-[var(--omp-dim)]" size={14} />
					<span
						className="shrink-0 px-1 text-omp-md text-[var(--omp-dim)]"
						title={hidden.map(entry => subagentPrimaryLabel(entry)).join(" › ")}
					>
						…
					</span>
				</>
			)}
			{shownAncestors.map(ancestor => (
				<Fragment key={ancestor.id}>
					<ChevronRight className="shrink-0 text-[var(--omp-dim)]" size={14} />
					<button
						className="omp-pressable min-w-0 max-w-40 truncate rounded-lg px-2 py-1.5 text-omp-md text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
						onClick={() => useAgentPagesStore.getState().open(tabId, ancestor.id)}
						title={t("agents.title.openAncestor", { title: subagentPrimaryLabel(ancestor) })}
						type="button"
					>
						{subagentPrimaryLabel(ancestor)}
					</button>
				</Fragment>
			))}
			<ChevronRight className="shrink-0 text-[var(--omp-dim)]" size={14} />
			<span
				aria-current="page"
				className="min-w-0 max-w-72 truncate px-2 py-1.5 text-omp-lg font-semibold text-[var(--omp-text)]"
				title={title}
			>
				{title}
			</span>
		</>
	);
}

export function AgentTitleStatus({ agentId }: { agentId: string }) {
	const activityLabel = useActivityLabel();
	const agent = useSubagentsStore(state => state.subagents.get(agentId));
	if (!agent) return null;
	const activity = subagentActivity(agent);
	const label = activityLabel(agent);
	return (
		<div className="omp-titlebar-status no-drag flex shrink-0 items-center gap-1.5 px-1 text-omp-sm font-medium text-[var(--omp-muted)]">
			<AgentSignal activity={activity} />
			<span
				className="omp-titlebar-status-label"
				style={activity === "failed" ? { color: ACTIVITY_TONE.failed } : undefined}
			>
				{label}
			</span>
		</div>
	);
}

export function AgentTitleFacts({ agentId }: { agentId: string }) {
	const agent = useSubagentsStore(state => state.subagents.get(agentId));
	if (!agent) return null;
	return (
		<span className="omp-session-metrics no-drag flex shrink-0 items-center px-1.5">
			<AgentFacts agent={agent} />
		</span>
	);
}
