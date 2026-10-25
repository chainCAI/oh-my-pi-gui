/**
 * The agent's `schedule_task` arguments become a draft the user confirms.
 * The draft can never carry more access than read-only or a model pin, and
 * a malformed call is answered with an error instead of a card.
 */

import { describe, expect, it } from "vitest";
import { parseScheduleToolArgs, scheduleOutcomeText } from "./schedule-tool";

const NOW = Date.parse("2026-10-26T08:00:00Z");
const context = { cwd: "/work/app", now: NOW, timeZone: "Europe/Berlin", sessionPath: "/s/tab.jsonl" };
const args = (overrides: Record<string, unknown> = {}) => ({
	title: "Morning CI",
	prompt: "Summarize failing CI jobs.",
	scheduleKind: "cron",
	cron: "0 9 * * 1-5",
	everyMinutes: 0,
	at: "",
	suggestedModel: "",
	reason: "You asked for a daily summary.",
	...overrides,
});

describe("schedule_task arguments", () => {
	it("drafts read-only with no model pin, keeping the agent's model only as a suggestion", () => {
		const parsed = parseScheduleToolArgs(args({ suggestedModel: "anthropic/claude-opus-5-5" }), context);
		expect(parsed).toMatchObject({
			ok: true,
			suggestedModel: "anthropic/claude-opus-5-5",
			draft: {
				tools: "read_only",
				model: null,
				cwd: "/work/app",
				schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Berlin" },
				origin: { createdBy: "agent", sessionPath: "/s/tab.jsonl" },
			},
		});
	});

	it("maps intervals to milliseconds on a grid starting one interval out, and one-offs to their instant", () => {
		const interval = parseScheduleToolArgs(args({ scheduleKind: "interval", everyMinutes: 30 }), context);
		expect(interval.ok && interval.draft.schedule).toEqual({
			kind: "interval",
			everyMs: 1_800_000,
			anchor: NOW + 1_800_000,
		});
		const once = parseScheduleToolArgs(args({ scheduleKind: "once", at: "2026-10-27T07:30:00Z" }), context);
		expect(once.ok && once.draft.schedule).toEqual({ kind: "once", at: Date.parse("2026-10-27T07:30:00Z") });
	});

	it("refuses a call whose chosen schedule field is missing or unknown", () => {
		for (const bad of [
			args({ cron: "" }),
			args({ scheduleKind: "interval", everyMinutes: 0 }),
			args({ scheduleKind: "once", at: "tomorrow-ish" }),
			args({ scheduleKind: "weekly" }),
			args({ prompt: "  " }),
		]) {
			expect(parseScheduleToolArgs(bad, context).ok).toBe(false);
		}
	});

	it("tells the agent the user's decline reason, or the created task's id", () => {
		expect(scheduleOutcomeText({ kind: "declined", reason: "I check CI myself" })).toContain("I check CI myself");
		expect(
			scheduleOutcomeText({
				kind: "created",
				taskId: "task-42",
				title: "Morning CI",
				nextFireAt: null,
				tools: "read_only",
			}),
		).toContain("task-42");
	});
});
