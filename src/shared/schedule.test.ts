/**
 * Fire-time contract for scheduled tasks: the clock must fire cron at the
 * same wall time across daylight saving, never twice in a repeated hour,
 * never in a skipped one, and must refuse schedules it cannot honour.
 */

import { describe, expect, it } from "vitest";
import {
	countFiresBetween,
	describeSchedule,
	nextFireAfter,
	nextFires,
	parseCron,
	scheduleProblem,
	wallTimeToInstant,
} from "./schedule";

const NY = "America/New_York";
const iso = (instant: number | null) => (instant === null ? null : new Date(instant).toISOString());
const at = (text: string) => Date.parse(text);

describe("cron parsing", () => {
	it("expands steps, ranges, lists and names, and folds 7 into Sunday", () => {
		const spec = parseCron("*/15 9-17/4 1,15 jan-mar sun,7");
		expect(spec?.minutes).toEqual([0, 15, 30, 45]);
		expect(spec?.hours).toEqual([9, 13, 17]);
		expect([...(spec?.days ?? [])]).toEqual([1, 15]);
		expect([...(spec?.months ?? [])]).toEqual([1, 2, 3]);
		expect([...(spec?.weekdays ?? [])]).toEqual([0]);
		expect(parseCron("@daily")?.hours).toEqual([0]);
	});

	it("rejects out-of-range values, inverted ranges, zero steps and wrong field counts", () => {
		for (const expr of [
			"60 * * * *",
			"* 24 * * *",
			"5-1 * * * *",
			"*/0 * * * *",
			"* * *",
			"* * * * * *",
			"0 0 0 * *",
			"x * * * *",
		]) {
			expect(parseCron(expr), expr).toBeNull();
		}
	});
});

describe("cron fire times", () => {
	it("keeps 09:00 wall time across the spring-forward change", () => {
		const fires = nextFires({ kind: "cron", expr: "0 9 * * *", tz: NY }, at("2026-03-07T00:00:00Z"), 3);
		// EST (UTC-5) on the 7th, EDT (UTC-4) from the 8th.
		expect(fires.map(iso)).toEqual([
			"2026-03-07T14:00:00.000Z",
			"2026-03-08T13:00:00.000Z",
			"2026-03-09T13:00:00.000Z",
		]);
	});

	it("skips a time the spring-forward gap removes", () => {
		// 02:30 does not exist in New York on 2026-03-08.
		const next = nextFireAfter({ kind: "cron", expr: "30 2 * * *", tz: NY }, at("2026-03-07T08:00:00Z"));
		expect(iso(next)).toBe("2026-03-09T06:30:00.000Z");
		expect(wallTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY)).toBeNull();
	});

	it("fires a repeated fall-back time once, at its first occurrence", () => {
		const schedule = { kind: "cron", expr: "30 1 * * *", tz: NY } as const;
		const first = nextFireAfter(schedule, at("2026-11-01T00:00:00Z"));
		expect(iso(first)).toBe("2026-11-01T05:30:00.000Z");
		// The second 01:30 (06:30Z, EST) must not fire again the same night.
		expect(iso(nextFireAfter(schedule, first ?? 0))).toBe("2026-11-02T06:30:00.000Z");
	});

	it("finds wall times around a transition in a zone more than 12 hours ahead of UTC", () => {
		// Chatham falls back at 03:45 (UTC+13:45 → +12:45) on 2026-04-05; 02:30
		// that morning is still daylight time and happens once, at 12:45Z.
		const chatham = { kind: "cron", expr: "30 2 * * *", tz: "Pacific/Chatham" } as const;
		expect(nextFires(chatham, at("2026-04-03T12:45:00Z"), 2).map(iso)).toEqual([
			"2026-04-04T12:45:00.000Z",
			"2026-04-05T13:45:00.000Z",
		]);
	});

	it("fires on either restricted day field, as vixie cron does", () => {
		// The 13th, or any Friday: Fri 2 Oct, Fri 9 Oct, Tue 13 Oct, Fri 16 Oct.
		const fires = nextFires({ kind: "cron", expr: "0 0 13 * fri", tz: "UTC" }, at("2026-10-01T00:00:00Z"), 4);
		expect(fires.map(iso)).toEqual([
			"2026-10-02T00:00:00.000Z",
			"2026-10-09T00:00:00.000Z",
			"2026-10-13T00:00:00.000Z",
			"2026-10-16T00:00:00.000Z",
		]);
	});

	it("returns null for a date that never comes", () => {
		expect(nextFireAfter({ kind: "cron", expr: "0 0 31 2 *", tz: "UTC" }, at("2026-01-01T00:00:00Z"))).toBeNull();
	});
});

describe("interval and one-shot fire times", () => {
	it("stays on the anchor's grid instead of drifting from the last check", () => {
		const anchor = at("2026-10-25T10:00:00Z");
		const schedule = { kind: "interval", everyMs: 3_600_000, anchor } as const;
		expect(nextFireAfter(schedule, anchor - 1)).toBe(anchor);
		expect(iso(nextFireAfter(schedule, anchor + 2.5 * 3_600_000))).toBe("2026-10-25T13:00:00.000Z");
		expect(iso(nextFireAfter(schedule, anchor + 3_600_000))).toBe("2026-10-25T12:00:00.000Z");
	});

	it("fires a one-shot once and then never", () => {
		const schedule = { kind: "once", at: at("2026-10-26T09:00:00Z") } as const;
		expect(nextFires(schedule, at("2026-10-25T00:00:00Z"), 5)).toEqual([schedule.at]);
		expect(nextFireAfter(schedule, schedule.at)).toBeNull();
	});

	it("counts the slots that passed while the app was away", () => {
		const schedule = { kind: "cron", expr: "0 * * * *", tz: "UTC" } as const;
		expect(countFiresBetween(schedule, at("2026-10-25T00:30:00Z"), at("2026-10-25T05:30:00Z"))).toBe(5);
		expect(countFiresBetween(schedule, at("2026-10-25T00:30:00Z"), at("2026-10-25T00:59:00Z"))).toBe(0);
	});
});

describe("schedule problems", () => {
	const now = at("2026-10-25T12:00:00Z");
	const min = 5 * 60_000;

	it("refuses schedules that fire closer than the floor", () => {
		expect(scheduleProblem({ kind: "cron", expr: "*/2 * * * *", tz: "UTC" }, now, min)).toBe("too_frequent");
		expect(scheduleProblem({ kind: "cron", expr: "0,3 9 * * *", tz: "UTC" }, now, min)).toBe("too_frequent");
		expect(scheduleProblem({ kind: "interval", everyMs: 4 * 60_000, anchor: now }, now, min)).toBe("too_frequent");
		expect(scheduleProblem({ kind: "cron", expr: "*/5 * * * *", tz: "UTC" }, now, min)).toBeNull();
	});

	it("refuses past one-shots, unknown zones and dates that never come", () => {
		expect(scheduleProblem({ kind: "once", at: now - 1 }, now, min)).toBe("schedule_in_past");
		expect(scheduleProblem({ kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" }, now, min)).toBe(
			"schedule_invalid",
		);
		expect(scheduleProblem({ kind: "cron", expr: "0 0 31 2 *", tz: "UTC" }, now, min)).toBe("schedule_invalid");
	});
});

describe("schedule descriptions", () => {
	it("names the common shapes and falls back to the raw expression", () => {
		const cron = (expr: string) => describeSchedule({ kind: "cron", expr, tz: "UTC" });
		expect(cron("0 9 * * 1-5")).toEqual({ key: "cron.weekdays", params: { time: "09:00" } });
		expect(cron("30 8 * * mon")).toEqual({ key: "cron.weekly", params: { time: "08:30", weekday: 1 } });
		expect(cron("0 7 1 * *")).toEqual({ key: "cron.monthly", params: { time: "07:00", day: 1 } });
		expect(cron("15 * * * *")).toEqual({ key: "cron.hourly", params: { minute: "15" } });
		expect(cron("0 9,17 * * *")).toEqual({ key: "cron.raw", params: { expr: "0 9,17 * * *" } });
		expect(describeSchedule({ kind: "interval", everyMs: 90 * 60_000, anchor: 0 })).toEqual({
			key: "everyMinutes",
			params: { count: 90 },
		});
	});
});
