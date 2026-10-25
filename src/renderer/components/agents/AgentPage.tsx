/**
 * A subagent's page (plan/24 §5.4): the conversation's own column and
 * components over the agent's transcript, with a read-only agent bar where
 * the composer sits.
 *
 * The transcript renders under the page runtime, so its tool cards read a
 * private tools store. The live tail, agent bar and status line render under
 * the session's runtime: their actions (stop, revive) go to the session's
 * sidecar, which the page runtime refuses.
 */

import { Bot, Check, CornerDownRight, MoreHorizontal, RefreshCw, Square, X } from "lucide-react";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, SubagentSnapshot } from "../../../shared/rpc-types";
import { copyText, cx, formatCost, formatTokens, sanitizeToolText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { useTabRpc } from "../../lib/tab-rpc";
import { markFailuresSeen, useAgentPagesStore } from "../../stores/agent-pages";
import type { MessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { SessionRuntimeProvider } from "../../stores/session-runtime-context";
import { useSubagentsStore } from "../../stores/subagents";
import { ensureTabRuntime } from "../../stores/tab-runtime";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { ChatStream } from "../chat/ChatStream";
import { ReadOnlyTranscriptContext } from "../chat/transcript-mode";
import { Spinner } from "../common";
import { ContextMenu, type ContextMenuItem } from "../common/ContextMenu";
import { formatElapsed, subagentElapsedMs, subagentPrimaryLabel } from "../panels/subagent-graph";
import { agentNowLine, type SubagentActivity, subagentActivity } from "./agent-activity";
import { agentPageRuntime, useAgentTranscript } from "./agent-page-runtime";

/** Same cadence as the dock card: parked and idle transitions emit no frame. */
const ROSTER_POLL_MS = 3000;

export const ACTIVITY_TONE: Record<SubagentActivity, string> = {
	working: "var(--omp-accent)",
	waiting: "var(--omp-dim)",
	failed: "var(--omp-error)",
	done: "var(--omp-success)",
	stopped: "var(--omp-dim)",
};

/** The 6 px signal dot; waiting is a ring, so state never rests on colour alone. */
export function AgentSignal({ activity, className }: { activity: SubagentActivity; className?: string }) {
	if (activity === "done" || activity === "stopped") {
		return <span aria-hidden className={cx("inline-block h-1.5 w-1.5 shrink-0", className)} />;
	}
	return (
		<span
			aria-hidden
			className={cx("inline-block h-1.5 w-1.5 shrink-0 rounded-full", className)}
			style={
				activity === "waiting"
					? { boxShadow: `inset 0 0 0 1.25px ${ACTIVITY_TONE.waiting}` }
					: { background: ACTIVITY_TONE[activity] }
			}
		/>
	);
}

export function useActivityLabel(): (agent: SubagentSnapshot) => string {
	const t = useT();
	return useCallback(
		(agent: SubagentSnapshot) => {
			const activity = subagentActivity(agent);
			if (activity === "stopped" && (agent.status === "cancelled" || agent.status === "aborted")) {
				return t("agents.activity.cancelled");
			}
			return t(`agents.activity.${activity}`);
		},
		[t],
	);
}

/** Who an agent takes instructions from: its parent agent, or the conversation. */
export function useParentAgent(agent: SubagentSnapshot | undefined): SubagentSnapshot | undefined {
	return useSubagentsStore(state =>
		agent?.parentSubagentId ? state.subagents.get(agent.parentSubagentId) : undefined,
	);
}

function transcriptText(messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map(block =>
								block.type === "text" ? block.text : block.type === "toolCall" ? `[${block.name}]` : "",
							)
							.filter(Boolean)
							.join("\n")
					: "";
		if (text.trim()) parts.push(`## ${message.role}\n\n${text.trim()}`);
	}
	return parts.join("\n\n");
}

export function AgentPage({ tabId, agentId, beside = false }: { tabId: string; agentId: string; beside?: boolean }) {
	const t = useT();
	const parent = ensureTabRuntime(tabId);
	const runtime = agentPageRuntime(parent, agentId);
	const live = useSubagentsStore(state => state.subagents.get(agentId));
	// An agent that leaves the roster keeps its page as it was (plan/24 §5.6).
	const lastSeen = useRef(live);
	if (live) lastSeen.current = live;
	const agent = live ?? lastSeen.current;
	const gone = live === undefined;
	const parentAgent = useParentAgent(agent);
	const parentLabel = parentAgent ? subagentPrimaryLabel(parentAgent) : null;
	const transcript = useAgentTranscript(runtime, gone ? undefined : agent);
	const readOnly = useMemo(
		() => ({
			authorLabel: parentLabel ? t("agents.page.from", { parent: parentLabel }) : t("agents.page.fromConversation"),
		}),
		[parentLabel, t],
	);

	const parentStreaming = useSessionStore(state => state.isStreaming);
	const refresh = useSubagentsStore(state => state.refresh);
	useEffect(() => {
		if (!parentStreaming) return;
		const timer = window.setInterval(() => void refresh(), ROSTER_POLL_MS);
		return () => window.clearInterval(timer);
	}, [parentStreaming, refresh]);

	// Opening a failed agent's page is seeing the failure.
	const failed = agent?.status === "failed";
	useEffect(() => {
		if (failed) markFailuresSeen([agentId]);
	}, [agentId, failed]);

	if (!agent) {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-omp-md text-[var(--omp-muted)]">
				{t("agents.page.gone")}
				<button
					className="omp-pressable rounded-full border border-[var(--omp-border)] px-3 py-1 text-omp-sm text-[var(--omp-text)] hover:bg-[var(--omp-selected-bg)]"
					onClick={() => useAgentPagesStore.getState().close(tabId, agentId)}
					type="button"
				>
					{t("agents.page.closePage")}
				</button>
			</div>
		);
	}

	const activity = subagentActivity(agent);
	return (
		<div className="omp-agent-page relative flex min-h-0 flex-1 flex-col" data-activity={activity}>
			{beside && <AgentPaneHeader agent={agent} tabId={tabId} />}
			<SessionRuntimeProvider runtime={runtime}>
				<ReadOnlyTranscriptContext.Provider value={readOnly}>
					<ChatStream />
				</ReadOnlyTranscriptContext.Provider>
			</SessionRuntimeProvider>
			<div className="omp-composer-region relative shrink-0 bg-transparent pb-1 pt-2">
				<div className="omp-composer-shell relative w-full">
					{transcript.error && (
						<div
							className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--omp-border-muted)] px-3 py-2 text-omp-sm text-[var(--omp-muted)]"
							role="alert"
						>
							<span className="min-w-0 flex-1 truncate" title={transcript.error}>
								{t("agents.page.loadFailed")}
							</span>
							<button
								className="omp-pressable shrink-0 font-medium text-[var(--omp-link)] hover:underline"
								onClick={transcript.retry}
								type="button"
							>
								{t("common.retry")}
							</button>
						</div>
					)}
					{gone && (
						<div className="mb-2 px-1 text-omp-sm text-[var(--omp-dim)]" role="status">
							{t("agents.page.gone")}
						</div>
					)}
					{!gone && activity === "working" && <AgentLiveTail agent={agent} />}
					<AgentBar
						agent={agent}
						beside={beside}
						disabled={gone}
						messages={() =>
							(runtime.stores.get("messages")?.getState() as MessagesStore | undefined)?.messages ?? []
						}
						parentLabel={parentLabel}
						tabId={tabId}
					/>
					<AgentStatusLine agent={agent} />
				</div>
			</div>
		</div>
	);
}

/**
 * The page's only "now": the transcript file holds committed messages, so the
 * running tool and the intent come from the progress frame.
 */
function AgentLiveTail({ agent }: { agent: SubagentSnapshot }) {
	const t = useT();
	const now = useNowTick(true);
	const line = agentNowLine(agent);
	const progress = agent.progress;
	const intent = progress?.lastIntent?.trim();
	if (!line && !intent) return null;
	const toolElapsed =
		line?.kind === "tool" && progress?.currentToolStartMs ? formatElapsed(now - progress.currentToolStartMs) : null;
	return (
		<div aria-live="off" className="omp-agent-live-tail mb-2 flex min-w-0 flex-col gap-0.5 px-3">
			{line?.kind === "retry" ? (
				<div className="truncate text-omp-sm text-[var(--omp-warning)]">
					{t("agents.now.retrying", {
						attempt: line.attempt,
						max: line.maxAttempts,
						error: sanitizeToolText(line.error),
					})}
				</div>
			) : line?.kind === "tool" ? (
				<div className="flex min-w-0 items-center gap-2 text-omp-sm">
					<Spinner size="sm" />
					<span className="shrink-0 font-mono text-[var(--omp-text-secondary)]">{line.tool}</span>
					<span className="min-w-0 flex-1 truncate font-mono text-[var(--omp-dim)]">
						{sanitizeToolText(line.args)}
					</span>
					{toolElapsed && (
						<span className="shrink-0 text-omp-xs tabular-nums text-[var(--omp-dim)]">{toolElapsed}</span>
					)}
				</div>
			) : null}
			{intent && line?.kind !== "intent" ? (
				<div className="omp-shimmer-text truncate text-omp-sm">{sanitizeToolText(intent)}</div>
			) : line?.kind === "intent" ? (
				<div className="flex min-w-0 items-center gap-2 text-omp-sm">
					<Spinner size="sm" />
					<span className="omp-shimmer-text min-w-0 truncate">{sanitizeToolText(line.text)}</span>
				</div>
			) : null}
		</div>
	);
}

function reasonKey(reason: string | undefined): string {
	switch (reason) {
		case "advisor_readonly":
			return "agentHub.hub.reason.advisorReadonly";
		case "main_agent":
			return "agentHub.hub.reason.mainAgent";
		case "not_found":
			return "agentHub.hub.reason.notFound";
		case "not_parked":
			return "agentHub.hub.reason.notParked";
		default:
			return "agentHub.hub.reason.abortFailed";
	}
}

function AgentBar({
	agent,
	beside,
	disabled,
	messages,
	parentLabel,
	tabId,
}: {
	agent: SubagentSnapshot;
	beside: boolean;
	disabled: boolean;
	messages: () => AgentMessage[];
	parentLabel: string | null;
	tabId: string;
}) {
	const t = useT();
	const rpc = useTabRpc();
	const ready = useSessionStore(state => state.status === "ready");
	const refresh = useSubagentsStore(state => state.refresh);
	const pages = useAgentPagesStore(state => state.pages[tabId]);
	const splitWindow = useTabsStore(state => state.split !== null);
	const [confirming, setConfirming] = useState(false);
	const [working, setWorking] = useState(false);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const activity = subagentActivity(agent);
	const ended = activity === "done" || activity === "failed" || activity === "stopped";
	const live = activity === "working" || activity === "waiting";
	const advisor = agent.kind === "advisor";
	// The Hub's conditions (plan/24 §5.4).
	const abortable = (live || agent.status === "stale") && !advisor && !disabled;
	const revivable = agent.status === "parked" && !advisor && !disabled;
	const pinned = pages?.some(page => page.agentId === agent.id && page.pinned) ?? false;
	const progress = agent.progress;
	const model = progress?.resolvedModel;

	useEffect(() => {
		if (!abortable) setConfirming(false);
	}, [abortable]);

	const run = async (action: "abort" | "revive") => {
		setWorking(true);
		const failedKey = action === "abort" ? "agentHub.hub.abortAgentFailed" : "agentHub.hub.reviveFailed";
		try {
			const response = action === "abort" ? await rpc.abortSubagent(agent.id) : await rpc.reviveSubagent(agent.id);
			if (!response.success) {
				toast({ variant: "error", title: t(failedKey), message: response.error });
				return;
			}
			const data = response.data as { ok?: boolean; reason?: string } | undefined;
			if (!data?.ok) {
				toast({ variant: "error", title: t(failedKey), message: t(reasonKey(data?.reason)) });
				return;
			}
			await refresh();
		} catch (cause) {
			toast({ variant: "error", title: t(failedKey), message: String(cause) });
		} finally {
			setWorking(false);
			setConfirming(false);
		}
	};

	const menuItems: ContextMenuItem[] = [
		beside
			? {
					id: "tab",
					label: t("agents.page.openInTab"),
					onSelect: () => useAgentPagesStore.getState().open(tabId, agent.id),
				}
			: {
					id: "beside",
					label: t("agents.page.openBeside"),
					disabled: splitWindow,
					disabledReason: t("agents.page.besideSplit"),
					onSelect: () => useAgentPagesStore.getState().open(tabId, agent.id, { beside: true }),
				},
		{
			id: "keep",
			label: t("agents.page.keepOpen"),
			disabled: pinned,
			onSelect: () => useAgentPagesStore.getState().pin(tabId, agent.id),
		},
		{
			id: "copy",
			label: t("agents.page.copyTranscript"),
			onSelect: () => void copyText(transcriptText(messages())),
		},
		{
			id: "roster",
			label: t("agents.page.showInAgents"),
			onSelect: () => useUiStore.getState().setPanelTab("agents"),
		},
	];
	const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
		const bounds = event.currentTarget.getBoundingClientRect();
		setMenu({ x: bounds.left, y: bounds.top - 4 });
	};

	const instruction = ended
		? parentLabel
			? t("agents.page.reportedTo", { parent: parentLabel })
			: t("agents.page.reportedToConversation")
		: parentLabel
			? t("agents.page.takesInstructions", { parent: parentLabel })
			: t("agents.page.takesInstructionsConversation");

	return (
		<div aria-label={instruction} className="omp-composer-box omp-agent-bar overflow-hidden" role="group">
			<div className="flex min-w-0 items-center gap-1.5 px-4 pb-1 pt-3 text-omp-md text-[var(--omp-dim)]">
				<CornerDownRight aria-hidden className="shrink-0" size={14} />
				<span className="min-w-0 truncate">{instruction}</span>
			</div>
			<div className="omp-composer-toolbar flex h-11 min-w-0 items-center gap-1 px-2 pb-2 pt-1">
				<span className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-omp-md font-medium text-[var(--omp-muted)]">
					<Bot aria-hidden size={14} />
					{agent.agent}
				</span>
				{model && (
					<span
						className={cx(
							"min-w-0 truncate px-1 font-mono text-omp-sm",
							progress?.resolvedModelIsFallback ? "text-[var(--omp-warning)]" : "text-[var(--omp-dim)]",
						)}
						title={progress?.resolvedModelIsFallback ? t("agents.page.fallbackModel", { model }) : model}
					>
						{model}
					</span>
				)}
				<div className="ml-auto flex shrink-0 items-center gap-1">
					{abortable && !confirming && (
						<button
							className="omp-pressable flex h-8 items-center gap-1.5 rounded-full border border-[var(--omp-border)] px-3 text-omp-sm font-medium text-[var(--omp-text)] hover:border-[color-mix(in_srgb,var(--omp-error)_40%,transparent)] hover:text-[var(--omp-error)] disabled:opacity-50"
							disabled={working || !ready}
							onClick={() => setConfirming(true)}
							title={ready ? undefined : t("agentHub.notConnected")}
							type="button"
						>
							<Square aria-hidden fill="currentColor" size={10} />
							{t("agents.page.stop")}
						</button>
					)}
					{abortable && confirming && (
						<span className="flex items-center gap-1">
							<button
								className="omp-pressable flex h-8 items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--omp-error)_40%,transparent)] px-3 text-omp-sm font-medium text-[var(--omp-error)] disabled:opacity-50"
								disabled={working || !ready}
								onClick={() => void run("abort")}
								type="button"
							>
								<Check aria-hidden size={12} />
								{t("agents.page.confirmStop")}
							</button>
							<button
								aria-label={t("common.cancel")}
								className="omp-pressable flex h-8 w-8 items-center justify-center rounded-full text-[var(--omp-dim)] hover:bg-[var(--omp-selected-bg)]"
								onClick={() => setConfirming(false)}
								title={t("common.cancel")}
								type="button"
							>
								<X size={13} />
							</button>
						</span>
					)}
					{revivable && (
						<button
							className="omp-pressable flex h-8 items-center gap-1.5 rounded-full border border-[var(--omp-border)] px-3 text-omp-sm font-medium text-[var(--omp-text)] hover:bg-[var(--omp-selected-bg)] disabled:opacity-50"
							disabled={working || !ready}
							onClick={() => void run("revive")}
							type="button"
						>
							<RefreshCw aria-hidden size={12} />
							{t("agents.page.revive")}
						</button>
					)}
					<button
						aria-haspopup="menu"
						aria-label={t("agents.page.more")}
						className="omp-pressable flex h-8 w-8 items-center justify-center rounded-full text-[var(--omp-dim)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
						onClick={openMenu}
						title={t("agents.page.more")}
						type="button"
					>
						<MoreHorizontal size={15} />
					</button>
				</div>
			</div>
			{menu && (
				<ContextMenu items={menuItems} onClose={() => setMenu(null)} placement="above" x={menu.x} y={menu.y} />
			)}
		</div>
	);
}

/** Steps on the left; the context bar where the session shows its own. */
function AgentStatusLine({ agent }: { agent: SubagentSnapshot }) {
	const t = useT();
	const progress = agent.progress;
	const steps = progress?.toolCount ?? 0;
	const contextWindow = progress?.contextWindow;
	const used = progress?.contextTokens;
	const share = contextWindow && used !== undefined ? Math.min(1, used / contextWindow) : null;
	return (
		<div className="omp-context-bar flex h-6 min-w-0 items-center justify-between gap-2 px-2.5 text-omp-xs text-[var(--omp-dim)]">
			<span className="tabular-nums">
				{t("agents.page.steps", { count: steps, plural: steps === 1 ? "" : "s" })}
			</span>
			{share !== null && contextWindow && (
				<span className="flex items-center gap-2 tabular-nums">
					<span aria-hidden className="h-1 w-16 overflow-hidden rounded-full bg-[var(--omp-border-muted)]">
						<span
							className="block h-full rounded-full bg-[var(--omp-accent)]"
							style={{ width: `${Math.round(share * 100)}%` }}
						/>
					</span>
					{t("agents.page.contextShare", {
						percent: Math.round(share * 100),
						window: formatTokens(contextWindow),
					})}
				</span>
			)}
		</div>
	);
}

/** Beside the conversation, the page pane carries the split view's 32 px header. */
function AgentPaneHeader({ agent, tabId }: { agent: SubagentSnapshot; tabId: string }) {
	const t = useT();
	return (
		<header className="relative flex h-8 shrink-0 items-center gap-2 border-b border-[var(--omp-border-muted)] px-3 text-omp-sm">
			<CornerDownRight aria-hidden className="shrink-0 text-[var(--omp-dim)]" size={13} />
			<AgentSignal activity={subagentActivity(agent)} />
			<span className="min-w-0 flex-1 truncate font-medium text-[var(--omp-text)]">
				{subagentPrimaryLabel(agent)}
			</span>
			<AgentFacts agent={agent} />
			<button
				aria-label={t("agents.page.closePage")}
				className="omp-pressable flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--omp-dim)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
				onClick={() => useAgentPagesStore.getState().close(tabId, agent.id)}
				title={t("agents.page.closePage")}
				type="button"
			>
				<X size={13} />
			</button>
		</header>
	);
}

/** Tokens, cost and time, in the session's mono figures. */
export function AgentFacts({ agent }: { agent: SubagentSnapshot }) {
	const activity = subagentActivity(agent);
	const now = useNowTick(activity === "working");
	const elapsed = subagentElapsedMs(agent, now);
	const progress = agent.progress;
	return (
		<span className="flex shrink-0 items-center gap-2 font-mono text-omp-xs tabular-nums text-[var(--omp-dim)]">
			{progress?.tokens ? <span>{formatTokens(progress.tokens)}</span> : null}
			{progress?.cost ? <span>{formatCost(progress.cost, progress.cost < 1 ? 3 : 2)}</span> : null}
			{elapsed !== null && <span>{formatElapsed(elapsed)}</span>}
		</span>
	);
}
