/**
 * The newest provider quota reading for this window. The sidebar strip polls
 * it and the Usage window publishes every reading it takes, so both show the
 * same numbers. Quotas belong to accounts, not tabs, so any tab's sidecar can
 * answer.
 */

import { create } from "zustand";
import type { UsageReport } from "../../shared/rpc-types";
import { focusedTabRpc, type TabRpc } from "../lib/tab-rpc";

interface QuotaStore {
	/** Null until the first reading; empty when no provider reports quotas. */
	reports: UsageReport[] | null;
	/** When `reports` was read, in epoch ms; 0 before the first reading. */
	fetchedAt: number;
}

export const useQuotaStore = create<QuotaStore>()(() => ({ reports: null, fetchedAt: 0 }));

export function publishQuotaReports(reports: UsageReport[]): void {
	useQuotaStore.setState({ reports, fetchedAt: Date.now() });
}

let inFlight: Promise<void> | null = null;

/** Read quotas once; concurrent callers share the read, and a failure keeps the last reading. */
export function refreshQuotas(rpc: TabRpc = focusedTabRpc()): Promise<void> {
	inFlight ??= (async () => {
		try {
			const res = await rpc.getUsage();
			if (res.success) publishQuotaReports((res.data as { reports?: UsageReport[] } | undefined)?.reports ?? []);
		} catch {
			// Sidecar busy or gone: the next poll retries.
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}
