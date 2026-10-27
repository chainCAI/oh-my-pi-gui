/**
 * Which quota rows the tray menu and the sidebar strip show first. A wrong rank
 * hides the provider nearest its limit behind "More quotas", or reorders rows
 * between readings so they jump while being read.
 */
import { describe, expect, it } from "vitest";
import type { TrayQuota } from "./ipc-types";
import { fullestWindow, quotaLevel, splitQuotaRows } from "./quotas";

const window = (name: string, fraction: number, exhausted = false) => ({
	window: name,
	fraction,
	exhausted,
	limits: [],
});

describe("quota ranking", () => {
	it("rings the used-up window before a fuller one, on the Usage window's thresholds", () => {
		expect(fullestWindow({ name: "Claude", windows: [window("5h", 0.42), window("7d", 0.6)] })?.window).toBe("7d");
		expect(fullestWindow({ name: "Go", windows: [window("5h", 0.92), window("wk", 0.5, true)] })?.window).toBe("wk");
		expect(
			[window("5h", 0.74), window("5h", 0.75), window("5h", 0.9), window("5h", 0.2, true)].map(quotaLevel),
		).toEqual(["ok", "warning", "critical", "critical"]);
	});

	it("shows the rows nearest a limit, ties to the earlier, both parts in provider order", () => {
		const row = (name: string, fraction: number, exhausted = false): TrayQuota => ({
			name,
			windows: [window("5h", fraction, exhausted)],
		});
		const rows = [
			row("A", 0.6),
			row("B", 0.93),
			row("C", 0.8),
			row("D", 0.3),
			row("E", 0.1, true),
			row("F", 0.55),
			row("G", 0.7),
			row("H", 0.6),
		];
		const { top, more } = splitQuotaRows(rows, 5);
		expect(top.map(quota => quota.name)).toEqual(["A", "B", "C", "E", "G"]);
		expect(more.map(quota => quota.name)).toEqual(["D", "F", "H"]);
		expect(splitQuotaRows(rows.slice(0, 5), 5)).toEqual({ top: rows.slice(0, 5), more: [] });
	});
});
