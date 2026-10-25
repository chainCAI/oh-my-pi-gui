/**
 * Agents under their session in the sidebar (plan/24 §3.1, §5.3): this
 * turn's agents of a session open in a tab, at most five rows, then a line
 * that says how many more there are and how many of them work or failed.
 *
 * The scope renders the session row through a render prop, so the row can
 * carry the disclosure chevron and the collapsed count pill.
 */

import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useAgentPagesStore } from "../../stores/agent-pages";
import { SessionRuntimeProvider, sessionRuntime } from "../../stores/session-runtime-context";
import { useUiStore } from "../../stores/ui";
import { subagentPrimaryLabel } from "../panels/subagent-graph";
import { useAgentHoverCard } from "./AgentHoverCard";
import { AgentSignal, useActivityLabel } from "./AgentPage";
import { type AgentTreeRow, cutAgentTree } from "./agent-activity";
import { useAgentProjection } from "./use-agent-tree";

/** Rows shown under a session before the "N more" line. */
export const SIDEBAR_AGENT_LIMIT = 5;
/** Levels of indent; deeper agents keep the second level's. */
const MAX_LEVEL = 2;
const INDENT = 14;

export interface SidebarAgentsInfo {
	/** This turn's agents, without context rows. */
	count: number;
	working: boolean;
	expanded: boolean;
	toggle: () => void;
	/** One of this session's pages is shown: the agent row holds the selection. */
	pageShown: boolean;
}

/** Your choice sticks per session while it is open; nothing expands on its own later. */
const useSidebarAgentsStore = create<{ expanded: Record<string, boolean> }>()(() => ({ expanded: {} }));

function setExpanded(key: string, value: boolean): void {
	useSidebarAgentsStore.setState(state => ({ expanded: { ...state.expanded, [key]: value } }));
}

export function SessionAgentsScope({
	tabId,
	sessionKey,
	children,
}: {
	tabId: string;
	sessionKey: string;
	children: (info: SidebarAgentsInfo | null) => ReactNode;
}) {
	const runtime = sessionRuntime(tabId);
	if (!runtime) return <>{children(null)}</>;
	return (
		<SessionRuntimeProvider runtime={runtime}>
			<SessionAgents sessionKey={sessionKey} tabId={tabId}>
				{children}
			</SessionAgents>
		</SessionRuntimeProvider>
	);
}

function SessionAgents({
	tabId,
	sessionKey,
	children,
}: {
	tabId: string;
	sessionKey: string;
	children: (info: SidebarAgentsInfo | null) => ReactNode;
}) {
	const projection = useAgentProjection();
	const stored = useSidebarAgentsStore(state => state.expanded[sessionKey]);
	const shownPage = useAgentPagesStore(state => state.shown[tabId] ?? null);
	const count = projection.turnCount;
	// The first time a session has agents in view, it opens.
	useEffect(() => {
		if (count > 0 && stored === undefined) setExpanded(sessionKey, true);
	}, [count, sessionKey, stored]);
	const expanded = stored ?? count > 0;
	const working = projection.turn.some(row => !row.context && row.activity === "working");
	const info = useMemo<SidebarAgentsInfo | null>(
		() =>
			count === 0
				? null
				: {
						count,
						working,
						expanded,
						toggle: () => setExpanded(sessionKey, !expanded),
						pageShown: shownPage !== null,
					},
		[count, expanded, sessionKey, shownPage, working],
	);
	return (
		<>
			{children(info)}
			{info?.expanded && <SidebarAgentRows rows={projection.turn} shownPage={shownPage} tabId={tabId} />}
		</>
	);
}

function SidebarAgentRows({
	tabId,
	rows,
	shownPage,
}: {
	tabId: string;
	rows: readonly AgentTreeRow[];
	shownPage: string | null;
}) {
	const t = useT();
	const cut = useMemo(() => cutAgentTree(rows, SIDEBAR_AGENT_LIMIT), [rows]);
	const openDrawer = () => useUiStore.getState().setPanelTab("agents");
	return (
		<div className="omp-sidebar-agents relative" role="group">
			{cut.rows.map((row, index) => (
				<SidebarAgentRow
					hasNextSibling={hasNextSibling(cut.rows, index) || (cut.hidden > 0 && row.depth === 0)}
					key={row.agent.id}
					rootGuide={row.depth > 0 && (cut.hidden > 0 || laterRoot(cut.rows, index))}
					row={row}
					selected={shownPage === row.agent.id}
					tabId={tabId}
				/>
			))}
			{cut.hidden > 0 && (
				<button
					className="omp-sidebar-agent-row omp-color-fade relative flex h-7 w-full items-center rounded-lg pr-2 text-left text-omp-sm text-[var(--omp-dim)] hover:bg-[var(--omp-sidebar-item-hover)]"
					onClick={openDrawer}
					style={{ paddingLeft: 8 + INDENT + 16 + 8 }}
					type="button"
				>
					<span aria-hidden className="omp-sidebar-agent-elbow" style={{ left: 15 }} />
					<span className="min-w-0 truncate">
						{t("agents.sidebar.more", { count: cut.hidden })}
						{cut.hiddenWorking > 0 && <> · {t("agents.sidebar.moreWorking", { count: cut.hiddenWorking })}</>}
						{cut.hiddenFailed > 0 && (
							<span className="text-[var(--omp-error)]">
								{" "}
								· {t("agents.sidebar.moreFailed", { count: cut.hiddenFailed })}
							</span>
						)}
					</span>
				</button>
			)}
		</div>
	);
}

function laterRoot(rows: readonly AgentTreeRow[], index: number): boolean {
	return rows.slice(index + 1).some(row => row.depth === 0);
}

/** A later row at the same depth before any shallower one: the guide continues down. */
function hasNextSibling(rows: readonly AgentTreeRow[], index: number): boolean {
	const depth = rows[index]?.depth ?? 0;
	for (let next = index + 1; next < rows.length; next++) {
		const candidate = rows[next]!.depth;
		if (candidate === depth) return true;
		if (candidate < depth) return false;
	}
	return false;
}

function SidebarAgentRow({
	tabId,
	row,
	selected,
	hasNextSibling,
	rootGuide,
}: {
	tabId: string;
	row: AgentTreeRow;
	selected: boolean;
	hasNextSibling: boolean;
	/** A first-level sibling follows this nested row: the first level's guide runs through it. */
	rootGuide: boolean;
}) {
	const t = useT();
	const activityLabel = useActivityLabel();
	const hover = useAgentHoverCard(tabId, row.agent.id, "right");
	const level = Math.min(row.depth, MAX_LEVEL - 1) + 1;
	// The session's signal dot sits at 16 px; each level's dot 14 px further in.
	const parentDot = 16 + (level - 1) * INDENT;
	const title = subagentPrimaryLabel(row.agent);
	const state = activityLabel(row.agent);
	return (
		<button
			{...hover}
			aria-current={selected ? "page" : undefined}
			aria-label={t("agents.sidebar.rowLabel", { title, state })}
			className={cx(
				"omp-sidebar-agent-row omp-color-fade relative flex h-7 w-full items-center rounded-lg pr-2 text-left",
				selected ? "bg-[var(--omp-selected-bg)]" : "hover:bg-[var(--omp-sidebar-item-hover)]",
			)}
			onClick={event => useAgentPagesStore.getState().open(tabId, row.agent.id, { beside: event.altKey })}
			style={{ paddingLeft: 8 + level * INDENT }}
			title={title}
			type="button"
		>
			<span aria-hidden className="omp-sidebar-agent-elbow" style={{ left: parentDot - 1 }} />
			{hasNextSibling && <span aria-hidden className="omp-sidebar-agent-guide" style={{ left: parentDot - 1 }} />}
			{rootGuide && (
				<span aria-hidden className="omp-sidebar-agent-guide omp-sidebar-agent-guide--full" style={{ left: 15 }} />
			)}
			<span aria-hidden className="mr-2 flex w-4 shrink-0 justify-center">
				<AgentSignal activity={row.activity} />
			</span>
			<span
				className={cx(
					"min-w-0 flex-1 truncate text-omp-sm",
					row.activity === "working" && !row.context
						? "text-[var(--omp-text-secondary)]"
						: "text-[var(--omp-muted)]",
				)}
			>
				{title}
			</span>
			{row.activity === "failed" && (
				<span className="ml-2 shrink-0 text-omp-xs text-[var(--omp-error)]">{state}</span>
			)}
		</button>
	);
}
