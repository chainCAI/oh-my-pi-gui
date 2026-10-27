import { useEffect } from "react";
import { useSessionStore } from "../stores/session";
import { useSubagentsStore } from "../stores/subagents";
import { useTabGuard } from "./use-tab-guard";

/** Poll cadence while a turn streams (covers frame-less parked/idle transitions). */
const STREAM_POLL_MS = 3000;

/**
 * Stream-time polling of get_subagents. Lifecycle/progress frames keep the
 * subagents store fresh while agents run, but parked/idle transitions ride the
 * AgentRegistry and emit NO wire frame — without polling, a watchdog-parked
 * agent would show "running" until the next session hydration. The workspace
 * dock owns it rather than the Agents card: the card hides whenever no agent
 * is working or `display.pinnedAgents` is off, and the sidebar and drawer
 * still read this roster.
 */
export function useSubagentStreamPoll(pollMs = STREAM_POLL_MS): void {
	const { capture, isActive } = useTabGuard();
	const isStreaming = useSessionStore(s => s.isStreaming);
	const hasAgents = useSubagentsStore(state => state.subagents.size > 0);
	const refresh = useSubagentsStore(state => state.refresh);

	useEffect(() => {
		if (!isStreaming || !hasAgents) return;
		const timer = setInterval(() => {
			// A poll resolving after a tab/session switch must not paint this
			// tab's agents over the new foreground session — the guard is
			// re-checked inside the store AFTER the await, before the write.
			const origin = capture();
			if (!isActive(origin)) return;
			void refresh({ expect: () => isActive(origin) });
		}, pollMs);
		return () => clearInterval(timer);
	}, [capture, hasAgents, isActive, isStreaming, pollMs, refresh]);
}
