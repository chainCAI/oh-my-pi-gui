import { useEffect, useState } from "react";
import type { ContextUsage, RpcContextReportResult, RpcContextUsageBreakdown } from "../../shared/rpc-types";
import { useTabRpc } from "../lib/tab-rpc";
import { useSessionStore } from "../stores/session";

export interface ContextReportHandle {
	/** The session's live reading; null until the session reports one. */
	contextUsage: ContextUsage | null;
	/** The category breakdown for the current reading, or undefined until it loads. */
	breakdown: RpcContextUsageBreakdown | undefined;
	loading: boolean;
	error: boolean;
	retry: () => void;
}

/**
 * The provider-anchored breakdown behind the session's context reading. While
 * `enabled`, it is re-read whenever the reading changes (a turn, a compaction,
 * a session switch), and a breakdown for an older reading is never shown.
 */
export function useContextReport(enabled: boolean): ContextReportHandle {
	const rpc = useTabRpc();
	const contextUsage = useSessionStore(state => state.contextUsage);
	const sessionId = useSessionStore(state => state.sessionId);
	const ready = useSessionStore(state => state.status) === "ready";
	const [report, setReport] = useState<RpcContextReportResult | null>(null);
	const [loadedKey, setLoadedKey] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const [attempt, setAttempt] = useState(0);

	const usageKey = contextUsage ? `${sessionId}:${contextUsage.tokens}:${contextUsage.contextWindow}` : "";

	/* The retry bump is the only reason this effect re-runs; nothing inside reads it. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry re-reads by bump
	useEffect(() => {
		if (!enabled || !ready || !usageKey || usageKey === loadedKey) return;
		let cancelled = false;
		setLoading(true);
		setError(false);
		void rpc
			.getContextReport()
			.then(response => {
				if (cancelled) return;
				if (response.success) {
					setReport(response.data as RpcContextReportResult);
					setLoadedKey(usageKey);
				} else {
					setError(true);
				}
			})
			.catch(() => {
				if (!cancelled) setError(true);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, enabled, loadedKey, ready, usageKey, rpc]);

	return {
		contextUsage,
		breakdown: loadedKey === usageKey ? report?.breakdown : undefined,
		loading,
		error,
		retry: () => setAttempt(count => count + 1),
	};
}
