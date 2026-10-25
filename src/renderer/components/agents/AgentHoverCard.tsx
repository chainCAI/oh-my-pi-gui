/**
 * The hover card (plan/24 §3.5, §5.5): one agent's status, now-line and last
 * three steps, without opening its page. Everything comes from the snapshot
 * and its progress frame; the card never reads a transcript.
 *
 * Resting on a row for 400 ms shows it; moving to another row swaps it at
 * once; leaving hides it after 150 ms. Keyboard focus behaves the same, and
 * Esc hides it. One layer serves every row in the window.
 */

import { Check } from "lucide-react";
import {
	type FocusEvent,
	type KeyboardEvent,
	type PointerEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { sanitizeToolText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { Badge, type BadgeVariant } from "../common";
import { formatElapsed, subagentElapsedMs, subagentPrimaryLabel } from "../panels/subagent-graph";
import { useActivityLabel } from "./AgentPage";
import { agentNowLine, type SubagentActivity, subagentActivity } from "./agent-activity";
import { useTabSubagent } from "./use-agent-tree";

const OPEN_DELAY_MS = 400;
const HIDE_DELAY_MS = 150;
const CARD_WIDTH = 300;
const GAP = 8;
export const AGENT_HOVER_CARD_ID = "omp-agent-hover-card";

interface HoverTarget {
	tabId: string;
	agentId: string;
	/** The row's box in viewport coordinates. */
	top: number;
	bottom: number;
	left: number;
	right: number;
	/** Which side of the row the card sits on, so it never covers its list. */
	side: "right" | "left";
	/** The row itself: a row that unmounts or scrolls fires no pointer leave. */
	anchor: Element;
}

const useHoverCardStore = create<{ target: HoverTarget | null }>()(() => ({ target: null }));

let openTimer: number | null = null;
let hideTimer: number | null = null;

function clearTimers(): void {
	if (openTimer !== null) window.clearTimeout(openTimer);
	if (hideTimer !== null) window.clearTimeout(hideTimer);
	openTimer = null;
	hideTimer = null;
}

function targetFor(element: Element, tabId: string, agentId: string, side: "right" | "left"): HoverTarget {
	const box = element.getBoundingClientRect();
	return { tabId, agentId, top: box.top, bottom: box.bottom, left: box.left, right: box.right, side, anchor: element };
}

function enter(element: Element, tabId: string, agentId: string, side: "right" | "left"): void {
	clearTimers();
	const next = targetFor(element, tabId, agentId, side);
	if (useHoverCardStore.getState().target) {
		useHoverCardStore.setState({ target: next });
		return;
	}
	openTimer = window.setTimeout(() => {
		openTimer = null;
		useHoverCardStore.setState({ target: next });
	}, OPEN_DELAY_MS);
}

function leave(): void {
	if (openTimer !== null) window.clearTimeout(openTimer);
	openTimer = null;
	if (hideTimer !== null) window.clearTimeout(hideTimer);
	hideTimer = window.setTimeout(() => {
		hideTimer = null;
		useHoverCardStore.setState({ target: null });
	}, HIDE_DELAY_MS);
}

export function hideAgentHoverCard(): void {
	clearTimers();
	useHoverCardStore.setState({ target: null });
}

/** Props that make a row show the card for its agent. */
export function useAgentHoverCard(tabId: string, agentId: string, side: "right" | "left" = "right") {
	const shown = useHoverCardStore(state => state.target?.tabId === tabId && state.target.agentId === agentId);
	useEffect(
		() => () => {
			const target = useHoverCardStore.getState().target;
			if (target?.tabId === tabId && target.agentId === agentId && !target.anchor.isConnected) {
				hideAgentHoverCard();
			}
		},
		[agentId, tabId],
	);
	return {
		"aria-describedby": shown ? AGENT_HOVER_CARD_ID : undefined,
		onPointerEnter: (event: PointerEvent<HTMLElement>) => enter(event.currentTarget, tabId, agentId, side),
		onPointerLeave: leave,
		onFocus: (event: FocusEvent<HTMLElement>) => {
			if (event.target === event.currentTarget) enter(event.currentTarget, tabId, agentId, side);
		},
		onBlur: leave,
		// Pressing a row opens its page: the card has done its job.
		onPointerDown: hideAgentHoverCard,
		onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
			if (event.key === "Escape" && useHoverCardStore.getState().target) {
				event.stopPropagation();
				hideAgentHoverCard();
			}
		},
	};
}

const BADGE: Record<SubagentActivity, BadgeVariant> = {
	working: "info",
	waiting: "muted",
	failed: "error",
	done: "success",
	stopped: "muted",
};

export function AgentHoverCardLayer() {
	const target = useHoverCardStore(state => state.target);
	const shown = target !== null;
	// The card is placed against the row's box at the time: any scroll moves the row away.
	useEffect(() => {
		if (!shown) return;
		window.addEventListener("scroll", hideAgentHoverCard, true);
		window.addEventListener("blur", hideAgentHoverCard);
		return () => {
			window.removeEventListener("scroll", hideAgentHoverCard, true);
			window.removeEventListener("blur", hideAgentHoverCard);
		};
	}, [shown]);
	if (!target) return null;
	return createPortal(<AgentHoverCard target={target} />, document.body);
}

function AgentHoverCard({ target }: { target: HoverTarget }) {
	const t = useT();
	const activityLabel = useActivityLabel();
	const agent = useTabSubagent(target.tabId, target.agentId);
	const cardRef = useRef<HTMLDivElement>(null);
	const [top, setTop] = useState(target.top);
	const activity = agent ? subagentActivity(agent) : "stopped";
	const now = useNowTick(activity === "working");
	// Flip vertically to stay in the window.
	useLayoutEffect(() => {
		const height = cardRef.current?.getBoundingClientRect().height ?? 0;
		const below = target.top + height + GAP <= window.innerHeight;
		setTop(below ? target.top : Math.max(GAP, target.bottom - height));
	}, [target]);
	if (!agent) return null;

	const left =
		target.side === "right"
			? Math.min(target.right + GAP, window.innerWidth - CARD_WIDTH - GAP)
			: Math.max(GAP, target.left - CARD_WIDTH - GAP);
	const elapsed = subagentElapsedMs(agent, now);
	const line = agentNowLine(agent);
	const steps = (agent.progress?.recentTools ?? []).slice(-3);
	const model = agent.progress?.resolvedModel;
	const subline = [elapsed !== null ? formatElapsed(elapsed) : null, agent.agent, model].filter(Boolean).join(" · ");

	return (
		<div
			className="omp-agent-hover-card pointer-events-none fixed z-[70] rounded-xl border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] p-3 shadow-[var(--omp-shadow-md)]"
			id={AGENT_HOVER_CARD_ID}
			ref={cardRef}
			role="tooltip"
			style={{ top, left, width: CARD_WIDTH }}
		>
			<div className="line-clamp-2 text-omp-md font-semibold text-[var(--omp-text)]">
				{subagentPrimaryLabel(agent, 120)}
			</div>
			<div className="mt-1.5 flex min-w-0 items-center gap-2">
				<Badge dot variant={BADGE[activity]}>
					{line?.kind === "retry" ? t("agents.hover.retrying") : activityLabel(agent)}
				</Badge>
				<span className="min-w-0 truncate text-omp-xs tabular-nums text-[var(--omp-dim)]">{subline}</span>
			</div>
			{line && (
				<div className="mt-2 truncate text-omp-xs text-[var(--omp-dim)]">
					{line.kind === "tool" ? (
						<>
							<span className="font-mono text-[var(--omp-text-secondary)]">{line.tool}</span>{" "}
							<span className="font-mono">{sanitizeToolText(line.args)}</span>
						</>
					) : line.kind === "retry" ? (
						t("agents.now.retrying", {
							attempt: line.attempt,
							max: line.maxAttempts,
							error: sanitizeToolText(line.error),
						})
					) : (
						sanitizeToolText(line.text)
					)}
				</div>
			)}
			{steps.length > 0 && (
				<ul className="mt-2 space-y-0.5">
					{steps.map((step, index) => (
						<li className="flex min-w-0 items-center gap-1.5 text-omp-xs" key={`${step.endMs}-${index}`}>
							<Check aria-hidden className="shrink-0 text-[var(--omp-success)]" size={11} />
							<span className="shrink-0 font-mono text-[var(--omp-text-secondary)]">{step.tool}</span>
							<span className="min-w-0 truncate font-mono text-[var(--omp-dim)]">
								{sanitizeToolText(step.args)}
							</span>
						</li>
					))}
				</ul>
			)}
			<div className="mt-2 text-omp-xxs text-[var(--omp-dim)]">{t("agents.openHint")}</div>
		</div>
	);
}
