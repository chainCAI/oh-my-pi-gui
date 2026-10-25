/**
 * When a scheduled task fires: one-shot instants, fixed intervals, and
 * five-field cron in an IANA time zone. Pure and electron-free so the main
 * process clock and the renderer's confirm-card preview compute the same
 * instants.
 *
 * Cron follows vixie semantics: `minute hour day-of-month month day-of-week`,
 * names for months and weekdays, `7` as Sunday, and when both day fields are
 * restricted a day matching either one fires. Daylight saving is wall-clock:
 * a time skipped by a spring-forward gap does not fire that day, and a time
 * repeated by a fall-back fires once, at its first occurrence.
 */

import type { TaskSchedule } from "./scheduler-types";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Cron searches stop after this many days without a match (e.g. `0 0 31 2 *`). */
const SEARCH_DAYS = 366 * 5;

export interface CronSpec {
	minutes: number[];
	hours: number[];
	days: Set<number>;
	months: Set<number>;
	weekdays: Set<number>;
	/** Day-of-month field was `*` (vixie: then only the weekday restricts). */
	anyDay: boolean;
	/** Day-of-week field was `*`. */
	anyWeekday: boolean;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const MACROS: Record<string, string> = {
	"@hourly": "0 * * * *",
	"@daily": "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@weekly": "0 0 * * 0",
	"@monthly": "0 0 1 * *",
	"@yearly": "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
};

function parseValue(token: string, names: string[] | null, offset: number): number | null {
	if (/^\d+$/.test(token)) return Number(token);
	if (!names) return null;
	const index = names.indexOf(token.toLowerCase());
	return index === -1 ? null : index + offset;
}

function parseField(
	field: string,
	min: number,
	max: number,
	names: string[] | null,
	nameOffset: number,
): number[] | null {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		if (part === "") return null;
		const [range, stepText, extra] = part.split("/");
		if (extra !== undefined) return null;
		const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : 0;
		if (step < 1) return null;
		let low: number;
		let high: number;
		if (range === "*") {
			low = min;
			high = max;
		} else {
			const bounds = range.split("-");
			if (bounds.length > 2) return null;
			const first = parseValue(bounds[0], names, nameOffset);
			if (first === null) return null;
			const last = bounds.length === 2 ? parseValue(bounds[1], names, nameOffset) : null;
			if (bounds.length === 2 && last === null) return null;
			low = first;
			// `5/15` means "from 5 to the end in steps of 15", as in vixie cron.
			high = last ?? (stepText === undefined ? first : max);
		}
		if (low < min || high > max || low > high) return null;
		for (let value = low; value <= high; value += step) values.add(value);
	}
	return [...values].sort((a, b) => a - b);
}

/** Parse a five-field cron expression (or a macro such as `@daily`); null when invalid. */
export function parseCron(expr: string): CronSpec | null {
	const trimmed = expr.trim().toLowerCase();
	const fields = (MACROS[trimmed] ?? trimmed).split(/\s+/);
	if (fields.length !== 5) return null;
	const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
	const minutes = parseField(minuteField, 0, 59, null, 0);
	const hours = parseField(hourField, 0, 23, null, 0);
	const days = parseField(dayField, 1, 31, null, 0);
	const months = parseField(monthField, 1, 12, MONTH_NAMES, 1);
	const weekdays = parseField(weekdayField, 0, 7, WEEKDAY_NAMES, 0);
	if (!minutes || !hours || !days || !months || !weekdays) return null;
	return {
		minutes,
		hours,
		days: new Set(days),
		months: new Set(months),
		// 7 is Sunday too.
		weekdays: new Set(weekdays.map(day => (day === 7 ? 0 : day))),
		anyDay: dayField.startsWith("*"),
		anyWeekday: weekdayField.startsWith("*"),
	};
}

/** True for a zone `Intl` can resolve. */
export function isValidTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

interface WallTime {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
	let formatter = formatters.get(tz);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
		});
		formatters.set(tz, formatter);
	}
	return formatter;
}

function wallTimeAt(instant: number, tz: string): WallTime {
	const parts: Record<string, number> = {};
	for (const part of formatterFor(tz).formatToParts(new Date(instant))) {
		if (part.type !== "literal") parts[part.type] = Number(part.value);
	}
	return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
}

function sameWall(a: WallTime, b: WallTime): boolean {
	return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

/** Offset of `tz` from UTC at `instant`, in ms (positive east of Greenwich). */
function zoneOffset(instant: number, tz: string): number {
	const wall = wallTimeAt(instant, tz);
	const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
	return asUtc - Math.floor(instant / MINUTE_MS) * MINUTE_MS;
}

/**
 * The first instant whose wall clock in `tz` reads `wall`, or null when a
 * daylight-saving gap skips that time.
 */
export function wallTimeToInstant(wall: WallTime, tz: string): number | null {
	const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
	// Offsets run from UTC-12 to UTC+14, so the real instant lies within a day
	// of the naive one; the offsets a day either side are the two in force
	// around it (equal outside transitions). Half a day misses both sides in
	// zones past UTC+12, such as Chatham's 03:45 fall-back at UTC+13:45.
	const offsets = new Set([zoneOffset(naive - DAY_MS, tz), zoneOffset(naive + DAY_MS, tz)]);
	const candidates = [...offsets]
		.map(offset => naive - offset)
		.filter(instant => sameWall(wallTimeAt(instant, tz), wall))
		.sort((a, b) => a - b);
	return candidates[0] ?? null;
}

function cronDayMatches(spec: CronSpec, day: number, weekday: number): boolean {
	if (spec.anyDay && spec.anyWeekday) return true;
	if (spec.anyDay) return spec.weekdays.has(weekday);
	if (spec.anyWeekday) return spec.days.has(day);
	return spec.days.has(day) || spec.weekdays.has(weekday);
}

function nextCronFire(spec: CronSpec, tz: string, after: number): number | null {
	const start = wallTimeAt(after, tz);
	for (let offset = 0; offset < SEARCH_DAYS; offset++) {
		// Civil-date arithmetic in UTC: independent of the zone's offsets.
		const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
		const year = date.getUTCFullYear();
		const month = date.getUTCMonth() + 1;
		const day = date.getUTCDate();
		if (!spec.months.has(month) || !cronDayMatches(spec, day, date.getUTCDay())) continue;
		for (const hour of spec.hours) {
			if (offset === 0 && hour < start.hour) continue;
			for (const minute of spec.minutes) {
				if (offset === 0 && hour === start.hour && minute < start.minute) continue;
				const instant = wallTimeToInstant({ year, month, day, hour, minute }, tz);
				if (instant !== null && instant > after) return instant;
			}
		}
	}
	return null;
}

/** The first fire strictly after `after`, or null when the schedule is done or invalid. */
export function nextFireAfter(schedule: TaskSchedule, after: number): number | null {
	switch (schedule.kind) {
		case "once":
			return schedule.at > after ? schedule.at : null;
		case "interval": {
			if (!(schedule.everyMs > 0)) return null;
			if (schedule.anchor > after) return schedule.anchor;
			const elapsed = Math.floor((after - schedule.anchor) / schedule.everyMs) + 1;
			return schedule.anchor + elapsed * schedule.everyMs;
		}
		case "cron": {
			const spec = parseCron(schedule.expr);
			if (!spec || !isValidTimeZone(schedule.tz)) return null;
			return nextCronFire(spec, schedule.tz, after);
		}
	}
}

/** Up to `count` consecutive fires after `after`. */
export function nextFires(schedule: TaskSchedule, after: number, count: number): number[] {
	const fires: number[] = [];
	let cursor = after;
	while (fires.length < count) {
		const next = nextFireAfter(schedule, cursor);
		if (next === null) break;
		fires.push(next);
		cursor = next;
	}
	return fires;
}

export type ScheduleProblem = "schedule_invalid" | "schedule_in_past" | "too_frequent";

/**
 * Why a schedule can't be saved, or null. "Too frequent" looks at the
 * shortest gap among the next fires, so `*\/2 * * * *` is caught as well as
 * a short interval.
 */
export function scheduleProblem(schedule: TaskSchedule, now: number, minIntervalMs: number): ScheduleProblem | null {
	switch (schedule.kind) {
		case "once":
			if (!Number.isFinite(schedule.at)) return "schedule_invalid";
			return schedule.at > now ? null : "schedule_in_past";
		case "interval":
			if (!Number.isFinite(schedule.everyMs) || !Number.isFinite(schedule.anchor) || schedule.everyMs <= 0) {
				return "schedule_invalid";
			}
			return schedule.everyMs < minIntervalMs ? "too_frequent" : null;
		case "cron": {
			if (!parseCron(schedule.expr) || !isValidTimeZone(schedule.tz)) return "schedule_invalid";
			const fires = nextFires(schedule, now, 24);
			if (fires.length === 0) return "schedule_invalid";
			for (let index = 1; index < fires.length; index++) {
				if (fires[index] - fires[index - 1] < minIntervalMs) return "too_frequent";
			}
			return null;
		}
	}
}

/** Fires that fell inside `(from, to]`: what passed while the app was closed or asleep. */
export function countFiresBetween(schedule: TaskSchedule, from: number, to: number, cap = 1000): number {
	let count = 0;
	let cursor = from;
	while (count < cap) {
		const next = nextFireAfter(schedule, cursor);
		if (next === null || next > to) break;
		count++;
		cursor = next;
	}
	return count;
}

/**
 * A structured description of a schedule for the UI to word: the renderer
 * maps `key` to a translation and fills `params`. Expressions without a
 * friendly shape fall back to `cron.raw`.
 */
export interface ScheduleDescription {
	key: string;
	params: Record<string, string | number>;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function describeSchedule(schedule: TaskSchedule): ScheduleDescription {
	if (schedule.kind === "once") return { key: "once", params: { at: schedule.at } };
	if (schedule.kind === "interval") {
		const minutes = Math.round(schedule.everyMs / MINUTE_MS);
		if (minutes % 1440 === 0) return { key: "everyDays", params: { count: minutes / 1440 } };
		if (minutes % 60 === 0) return { key: "everyHours", params: { count: minutes / 60 } };
		return { key: "everyMinutes", params: { count: minutes } };
	}
	const spec = parseCron(schedule.expr);
	if (!spec) return { key: "cron.raw", params: { expr: schedule.expr } };
	const allMonths = spec.months.size === 12;
	const singleTime = spec.minutes.length === 1 && spec.hours.length === 1;
	const time = singleTime ? `${pad(spec.hours[0])}:${pad(spec.minutes[0])}` : "";
	if (spec.hours.length === 24 && spec.minutes.length === 1 && spec.anyDay && spec.anyWeekday && allMonths) {
		return { key: "cron.hourly", params: { minute: pad(spec.minutes[0]) } };
	}
	if (!singleTime || !allMonths) return { key: "cron.raw", params: { expr: schedule.expr } };
	if (spec.anyDay && spec.anyWeekday) return { key: "cron.daily", params: { time } };
	if (spec.anyDay) {
		const weekdays = [...spec.weekdays].sort((a, b) => a - b).join(",");
		if (weekdays === "1,2,3,4,5") return { key: "cron.weekdays", params: { time } };
		if (spec.weekdays.size === 1) return { key: "cron.weekly", params: { time, weekday: [...spec.weekdays][0] } };
	}
	if (spec.anyWeekday && spec.days.size === 1) {
		return { key: "cron.monthly", params: { time, day: [...spec.days][0] } };
	}
	return { key: "cron.raw", params: { expr: schedule.expr } };
}
