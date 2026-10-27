/**
 * Keeps the window's provider quota reading fresh for the tray menu (#28): a
 * read once the sidecar is ready, then every five minutes like the CLI status
 * line, after each finished reply, when the window regains focus, and just
 * after a window resets. It keeps polling while the window is hidden, since the
 * tray is read from outside it. The agent caches provider usage for about five
 * minutes, so the extra reads do not multiply calls to provider endpoints.
 */

import { useEffect, useMemo, useRef } from "react";
import { nextQuotaReset, QUOTA_RESET_GRACE_MS, quotaRows } from "../lib/quota-rows";
import { useModelStore } from "../stores/model";
import { refreshQuotas, useQuotaStore } from "../stores/quotas";
import { useSessionStore } from "../stores/session";

const POLL_MS = 5 * 60_000;
/** Re-reads triggered by events reuse a reading younger than this. */
const MIN_REREAD_MS = 60_000;
/** Past this a reset timer would overflow setTimeout; the poll catches it as it nears. */
const MAX_RESET_TIMER_MS = 24 * 60 * 60_000;

function rereadIfOlderThan(ms: number): void {
	if (Date.now() - useQuotaStore.getState().fetchedAt >= ms) void refreshQuotas();
}

export function useQuotaPolling(): void {
	const ready = useSessionStore(s => s.status) === "ready";
	const isStreaming = useSessionStore(s => s.isStreaming);
	const reports = useQuotaStore(s => s.reports);
	const catalogEmpty = useModelStore(s => s.providers.length === 0);
	const refreshProviders = useModelStore(s => s.refreshProviders);

	useEffect(() => {
		if (!ready) return;
		rereadIfOlderThan(MIN_REREAD_MS);
		const timer = window.setInterval(() => rereadIfOlderThan(MIN_REREAD_MS), POLL_MS);
		const onFocus = () => rereadIfOlderThan(MIN_REREAD_MS);
		window.addEventListener("focus", onFocus);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", onFocus);
		};
	}, [ready]);

	// A finished reply has spent quota; the agent's cache already holds the
	// provider's response headers from it.
	const wasStreaming = useRef(isStreaming);
	useEffect(() => {
		if (ready && wasStreaming.current && !isStreaming) rereadIfOlderThan(MIN_REREAD_MS);
		wasStreaming.current = isStreaming;
	}, [ready, isStreaming]);

	const nextReset = useMemo(() => nextQuotaReset(reports, Date.now()), [reports]);
	useEffect(() => {
		if (!ready || nextReset === undefined) return;
		const delay = Math.max(0, nextReset - Date.now()) + QUOTA_RESET_GRACE_MS;
		if (delay > MAX_RESET_TIMER_MS) return;
		const timer = window.setTimeout(() => void refreshQuotas(), delay);
		return () => window.clearTimeout(timer);
	}, [ready, nextReset]);

	// Reports name providers by id; the catalog that names them may not be
	// loaded yet if the Providers window was never opened.
	const needsNames = ready && catalogEmpty && quotaRows(reports).length > 0;
	useEffect(() => {
		if (needsNames) void refreshProviders().catch(() => {});
	}, [needsNames, refreshProviders]);
}
