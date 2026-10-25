/**
 * Subagent pages (plan/24 §7): renderer-owned child tabs of a session tab.
 *
 * Main's tab list, routing and restore never see a page. The session stays
 * main's active tab while one of its pages is shown, so its sidecar keeps
 * streaming into its stores. Each session keeps at most one unpinned
 * (preview) page; opening another agent replaces it.
 */

import { create } from "zustand";
import type { SessionStore } from "./session";
import { sessionRuntimeStore } from "./session-runtime-context";
import { useTabsStore } from "./tabs";

export interface AgentPage {
	agentId: string;
	pinned: boolean;
}

export interface AgentPagesStore {
	/** Open pages per session tab, pinned first, at most one unpinned. */
	pages: Record<string, AgentPage[]>;
	/** The page each session tab shows in place of its conversation. */
	shown: Record<string, string | null>;
	/** The page open beside each session tab's conversation. */
	beside: Record<string, string | null>;
	/** The session each tab's pages belong to; a new session closes them. */
	sessions: Record<string, string>;
	open: (tabId: string, agentId: string, options?: { beside?: boolean; sessionId?: string }) => void;
	show: (tabId: string, agentId: string | null) => void;
	pin: (tabId: string, agentId: string) => void;
	close: (tabId: string, agentId: string) => void;
	/** Drop every page of a tab: closed tab, or a different session. */
	drop: (tabId: string) => void;
	reset: () => void;
}

function withPage(pages: AgentPage[], agentId: string, pinned: boolean): AgentPage[] {
	const kept = pages.filter(page => page.pinned && page.agentId !== agentId);
	const page = { agentId, pinned };
	return pinned
		? [...kept, page, ...pages.filter(entry => !entry.pinned && entry.agentId !== agentId)]
		: [...kept, page];
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
	if (!(key in record)) return record;
	const next = { ...record };
	delete next[key];
	return next;
}

const initial = { pages: {}, shown: {}, beside: {}, sessions: {} };

export const useAgentPagesStore = create<AgentPagesStore>()((set, get) => ({
	...initial,
	open: (tabId, agentId, options) => {
		const state = get();
		const sessionId =
			options?.sessionId ?? sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId ?? null;
		const sessions =
			sessionId && state.sessions[tabId] !== sessionId ? { ...state.sessions, [tabId]: sessionId } : state.sessions;
		const current = sessions === state.sessions ? (state.pages[tabId] ?? []) : [];
		const existing = current.find(page => page.agentId === agentId);
		const pages = existing ? current : withPage(current, agentId, false);
		// A replaced preview that was beside leaves the split.
		const kept = new Set(pages.map(page => page.agentId));
		const beside = state.beside[tabId] && !kept.has(state.beside[tabId]) ? null : (state.beside[tabId] ?? null);
		// Splits don't nest: beside is refused while the window shows two tabs.
		const splitWindow = useTabsStore.getState().split !== null;
		if (options?.beside && !splitWindow) {
			set({
				sessions,
				pages: { ...state.pages, [tabId]: pages },
				beside: { ...state.beside, [tabId]: agentId },
				shown: { ...state.shown, [tabId]: null },
			});
		} else {
			set({
				sessions,
				pages: { ...state.pages, [tabId]: pages },
				beside: { ...state.beside, [tabId]: beside === agentId ? null : beside },
				shown: { ...state.shown, [tabId]: agentId },
			});
		}
		const tabs = useTabsStore.getState();
		if (tabs.activeTabId !== tabId && tabs.tabs.some(tab => tab.id === tabId)) void tabs.switchTab(tabId);
	},
	show: (tabId, agentId) => {
		const state = get();
		// The page beside the conversation is already on screen.
		if (agentId !== null && state.beside[tabId] === agentId) {
			set({ shown: { ...state.shown, [tabId]: null } });
		} else if (agentId === null || state.pages[tabId]?.some(page => page.agentId === agentId)) {
			set({ shown: { ...state.shown, [tabId]: agentId } });
		}
		const tabs = useTabsStore.getState();
		if (tabs.activeTabId !== tabId) void tabs.switchTab(tabId);
	},
	pin: (tabId, agentId) => {
		const pages = get().pages[tabId];
		if (!pages?.some(page => page.agentId === agentId && !page.pinned)) return;
		set(state => ({ pages: { ...state.pages, [tabId]: withPage(pages, agentId, true) } }));
	},
	close: (tabId, agentId) => {
		set(state => ({
			pages: { ...state.pages, [tabId]: (state.pages[tabId] ?? []).filter(page => page.agentId !== agentId) },
			shown: state.shown[tabId] === agentId ? { ...state.shown, [tabId]: null } : state.shown,
			beside: state.beside[tabId] === agentId ? { ...state.beside, [tabId]: null } : state.beside,
		}));
	},
	drop: tabId => {
		set(state => ({
			pages: omit(state.pages, tabId),
			shown: omit(state.shown, tabId),
			beside: omit(state.beside, tabId),
			sessions: omit(state.sessions, tabId),
		}));
	},
	reset: () => set(initial),
}));

// A closed tab takes its pages with it.
useTabsStore.subscribe((state, previous) => {
	if (state.tabs === previous.tabs) return;
	const open = new Set(state.tabs.map(tab => tab.id));
	for (const tabId of Object.keys(useAgentPagesStore.getState().pages)) {
		if (!open.has(tabId)) useAgentPagesStore.getState().drop(tabId);
	}
});

/** The agent page a session tab shows in place of its conversation, if any. */
export function useShownAgentPage(tabId: string | null): string | null {
	return useAgentPagesStore(state => (tabId ? (state.shown[tabId] ?? null) : null));
}

/**
 * Failures seen in the drawer's Agents tab or on their page. The tab's error
 * dot is for the others (plan/24 §5.6).
 */
export const useSeenFailuresStore = create<{ seen: ReadonlySet<string> }>()(() => ({ seen: new Set() }));

export function markFailuresSeen(ids: Iterable<string>): void {
	const current = useSeenFailuresStore.getState().seen;
	const next = new Set(current);
	for (const id of ids) next.add(id);
	if (next.size !== current.size) useSeenFailuresStore.setState({ seen: next });
}
