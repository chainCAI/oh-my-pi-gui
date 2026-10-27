/**
 * The tray quota rows' reduction of usage reports: which limits become
 * windows, how they are named and ordered, and which figure a merged window
 * shows. A regression here prints a wrong or missing quota in the tray menu.
 */
import { describe, expect, it } from "vitest";
import type { UsageLimit, UsageReport } from "../../shared/rpc-types";
import { quotaRows, quotaWindow, trayQuotas } from "./quota-rows";

function limit(label: string, windowLabel: string | undefined, figures: Partial<UsageLimit>): UsageLimit {
	return { id: label, label, windowLabel, ...figures };
}

function report(provider: string, limits: UsageLimit[], account?: string): UsageReport {
	return { provider, fetchedAt: 0, limits, account };
}

describe("quotaWindow", () => {
	it("shortens each provider's window wording and keeps its length for ordering", () => {
		expect(quotaWindow("5 Hour")).toEqual({ short: "5h", hours: 5 });
		expect(quotaWindow("rolling 5h")).toEqual({ short: "5h", hours: 5 });
		expect(quotaWindow("7 days")).toEqual({ short: "7d", hours: 168 });
		expect(quotaWindow("30d")).toEqual({ short: "30d", hours: 720 });
		expect(quotaWindow("90 minutes")).toEqual({ short: "90m", hours: 1.5 });
		expect(quotaWindow("Weekly")).toEqual({ short: "wk", hours: 168 });
		expect(quotaWindow("Monthly")).toEqual({ short: "mo", hours: 720 });
	});

	it("names an unrecognized window by its first word and sorts it after every sized window", () => {
		expect(quotaWindow("Plan Period")).toEqual({ short: "plan", hours: Number.POSITIVE_INFINITY });
		expect(quotaWindow("Quota window").short).toBe("quota");
		expect(quotaWindow("Interval").short).toBe("interval");
		const [row] = quotaRows([
			report("devin", [
				limit("Prompt Credits", "Plan Period", { usedFraction: 0.4 }),
				limit("Weekly Quota", "Weekly", { usedFraction: 0.35 }),
			]),
		]);
		expect(row.windows.map(window => window.window)).toEqual(["wk", "plan"]);
	});
});

describe("quotaRows", () => {
	it("merges limits sharing a window into one entry showing the fullest, and leaves out unwindowed ones", () => {
		const [row] = quotaRows([
			report("anthropic", [
				limit("Claude 5 Hour", "5 Hour", { usedFraction: 0.42, resetsAt: 9_000 }),
				limit("Claude 7 Day", "7 Day", { usedFraction: 0.13 }),
				limit("Claude 7 Day (Opus)", "7 Day", { usedFraction: 0.6 }),
				limit("Claude Extra Usage", undefined, { usedFraction: 0.5 }),
			]),
		]);
		expect(row.windows.map(window => [window.window, window.fraction])).toEqual([
			["5h", 0.42],
			["7d", 0.6],
		]);
		expect(row.windows[1].limits.map(entry => entry.label)).toEqual(["Claude 7 Day (Opus)", "Claude 7 Day"]);
		expect(row.windows[0].limits[0].resetsAt).toBe(9_000);
	});

	it("orders windows by length whatever order the provider lists them in", () => {
		const [row] = quotaRows([
			report("opencode-go", [
				limit("Monthly limit", "Monthly", { usedFraction: 0.1 }),
				limit("5 Hour limit", "5 Hour", { usedFraction: 0.2 }),
				limit("Weekly limit", "Weekly", { usedFraction: 0.3 }),
			]),
		]);
		expect(row.windows.map(window => window.window)).toEqual(["5h", "wk", "mo"]);
	});

	it("reads the used fraction from counts or the remaining share, and flags a used-up window", () => {
		const [row] = quotaRows([
			report("github-copilot", [
				limit("Premium requests", "Monthly", { used: 240, limit: 300 }),
				limit("Daily chat", "Daily", { remainingFraction: 0.25 }),
				limit("Hourly burst", "1 hour", { usedFraction: 1.2 }),
				limit("Weekly agent", "Weekly", { usedFraction: 0.5, status: "exhausted" }),
				limit("Unmetered", "5 Hour", {}),
			]),
		]);
		expect(row.windows.map(window => [window.window, window.fraction, window.exhausted])).toEqual([
			["1h", 1, true],
			["1d", 0.75, false],
			["wk", 0.5, true],
			["mo", 0.8, false],
		]);
	});
});

describe("trayQuotas", () => {
	const catalog: Record<string, string> = { anthropic: "Anthropic (Claude Pro/Max)", "opencode-go": "OpenCode Go" };
	const name = (id: string) => catalog[id] ?? id;

	it("names rows without the plan note, adds the account only when a provider has several, and drops unwindowed providers", () => {
		const rows = trayQuotas(
			[
				report("anthropic", [limit("Claude 5 Hour", "5 Hour", { usedFraction: 0.1 })], "work@example.com"),
				report("anthropic", [limit("Claude 5 Hour", "5 Hour", { usedFraction: 0.9 })], "home@example.com"),
				report("opencode-go", [limit("Weekly limit", "Weekly", { usedFraction: 0.3 })], "solo@example.com"),
				report("charm-hyper", [limit("Credit balance", undefined, { used: 3, limit: 10 })]),
			],
			name,
		);
		expect(rows.map(row => [row.name, row.windows[0].fraction])).toEqual([
			["Anthropic · work@example.com", 0.1],
			["Anthropic · home@example.com", 0.9],
			["OpenCode Go", 0.3],
		]);
		expect(trayQuotas(null, name)).toEqual([]);
	});

	it("cuts the middle of a long account name so one address does not widen the menu", () => {
		const rows = trayQuotas(
			[
				report("anthropic", [limit("Claude 5 Hour", "5 Hour", { usedFraction: 0.1 })], "work@example.com"),
				report(
					"anthropic",
					[limit("Claude 5 Hour", "5 Hour", { usedFraction: 0.2 })],
					"zach.personal.account@verylongdomain.example.com",
				),
			],
			name,
		);
		expect(rows.map(row => row.name)).toEqual([
			"Anthropic · work@example.com",
			"Anthropic · zach.person…example.com",
		]);
	});
});
