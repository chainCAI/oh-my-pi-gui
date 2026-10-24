/**
 * Find in this conversation. The transcript is virtualized, so the browser's own
 * find never sees rows scrolled out of view: matches are counted from the message
 * data, and the rows that are mounted are highlighted through the CSS Custom
 * Highlight API, which marks text without touching React's DOM.
 */
import type { AgentMessage } from "../../../shared/rpc-types";
import { messageText } from "../../lib/messages";
import type { Row } from "./chat-stream-utils";

/** One occurrence: the row that holds it and which occurrence in that row. */
export interface FindMatch {
	rowIndex: number;
	occurrence: number;
}

/** Highlight registry names; their colors live in components.css. */
export const FIND_HIGHLIGHT = "omp-find";
export const FIND_HIGHLIGHT_CURRENT = "omp-find-current";

/** Only what the transcript shows as prose: user and assistant text, not tool output. */
function searchableText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
		case "assistant":
		case "custom":
		case "hookMessage":
			return messageText(message);
		default:
			return "";
	}
}

function rowMessages(row: Row): readonly AgentMessage[] {
	switch (row.kind) {
		case "message":
		case "streaming":
			return [row.message];
		case "process":
			return row.messages;
		default:
			return [];
	}
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
	return count;
}

/** Every occurrence of `query` (case-insensitive), in transcript order. */
export function findTranscriptMatches(rows: readonly Row[], query: string): FindMatch[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const matches: FindMatch[] = [];
	for (const [rowIndex, row] of rows.entries()) {
		let count = 0;
		for (const message of rowMessages(row)) count += countOccurrences(searchableText(message).toLowerCase(), needle);
		for (let occurrence = 0; occurrence < count; occurrence++) matches.push({ rowIndex, occurrence });
	}
	return matches;
}

/** A point inside a run of text nodes: which node, and the offset in it. */
export interface TextPoint {
	node: number;
	offset: number;
}

/**
 * Every occurrence of `query` (case-insensitive) across consecutive text nodes,
 * as start and end points. The nodes are read as one string, so a match that
 * crosses inline formatting (`**bold**`, `code`) still resolves to one span.
 */
export function findTextSpans(texts: readonly string[], query: string): { start: TextPoint; end: TextPoint }[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const starts: number[] = [];
	let joined = "";
	for (const text of texts) {
		starts.push(joined.length);
		joined += text;
	}
	const point = (offset: number, edge: "start" | "end"): TextPoint => {
		// An offset on a node boundary ends the earlier node but starts the later one.
		let node = starts.length - 1;
		while (node > 0 && (edge === "start" ? starts[node]! > offset : starts[node]! >= offset)) node--;
		return { node, offset: offset - starts[node]! };
	};
	const spans: { start: TextPoint; end: TextPoint }[] = [];
	const lower = joined.toLowerCase();
	for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
		spans.push({ start: point(at, "start"), end: point(at + needle.length, "end") });
	}
	return spans;
}

/** Ranges for every occurrence of `query` in the prose of one mounted row. */
export function findRangesInRow(row: HTMLElement, query: string): Range[] {
	const ranges: Range[] = [];
	for (const scope of row.querySelectorAll<HTMLElement>(".markdown-body")) {
		const nodes: Text[] = [];
		const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
		for (const { start, end } of findTextSpans(
			nodes.map(node => node.data),
			query,
		)) {
			const range = document.createRange();
			range.setStart(nodes[start.node]!, start.offset);
			range.setEnd(nodes[end.node]!, end.offset);
			ranges.push(range);
		}
	}
	return ranges;
}

/** Replace the window's find highlights; empty lists clear them. */
export function paintFindHighlights(all: readonly Range[], current: Range | null): void {
	if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
	if (all.length === 0) CSS.highlights.delete(FIND_HIGHLIGHT);
	else CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...all));
	if (current) CSS.highlights.set(FIND_HIGHLIGHT_CURRENT, new Highlight(current));
	else CSS.highlights.delete(FIND_HIGHLIGHT_CURRENT);
}
