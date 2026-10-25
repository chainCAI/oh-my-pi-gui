/**
 * Subagent pages as child tabs (plan/24 §7): one preview per session, pinned
 * pages that stay, no beside inside a split window, and pages that never
 * outlive their tab or session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentPagesStore } from "./agent-pages";
import { type SessionTab, useTabsStore } from "./tabs";

const originalSwitchTab = useTabsStore.getState().switchTab;

function tab(id: string): SessionTab {
	return { id, cwd: `/work/${id}`, status: "ready", kind: "agent", unreadDone: false };
}

function pagesOf(tabId: string): string[] {
	return (useAgentPagesStore.getState().pages[tabId] ?? []).map(page => `${page.agentId}${page.pinned ? "*" : ""}`);
}

beforeEach(() => {
	useAgentPagesStore.getState().reset();
	useTabsStore.setState({ tabs: [tab("t1"), tab("t2")], activeTabId: "t1", split: null, switchTab: vi.fn() });
});

afterEach(() => {
	useAgentPagesStore.getState().reset();
	useTabsStore.setState({ tabs: [], activeTabId: null, split: null, switchTab: originalSwitchTab });
});

describe("agent pages", () => {
	it("replaces the unpinned preview, and keeps a pinned page beside the next preview", () => {
		const pages = useAgentPagesStore.getState();
		pages.open("t1", "a1", { sessionId: "s" });
		pages.open("t1", "a2", { sessionId: "s" });
		expect(pagesOf("t1")).toEqual(["a2"]);

		useAgentPagesStore.getState().pin("t1", "a2");
		useAgentPagesStore.getState().open("t1", "a3", { sessionId: "s" });
		expect(pagesOf("t1")).toEqual(["a2*", "a3"]);
		expect(useAgentPagesStore.getState().shown.t1).toBe("a3");
	});

	it("switches to the page's session tab when opened from another tab", () => {
		useAgentPagesStore.getState().open("t2", "a1", { sessionId: "s" });

		expect(useTabsStore.getState().switchTab).toHaveBeenCalledWith("t2");
	});

	it("opens beside the conversation, but in place while the window is split", () => {
		useAgentPagesStore.getState().open("t1", "a1", { beside: true, sessionId: "s" });
		expect(useAgentPagesStore.getState()).toMatchObject({ beside: { t1: "a1" }, shown: { t1: null } });

		useAgentPagesStore.getState().reset();
		useTabsStore.setState({ split: { axis: "columns", firstTabId: "t1", secondTabId: "t2", ratio: 0.5 } });
		useAgentPagesStore.getState().open("t1", "a1", { beside: true, sessionId: "s" });
		expect(useAgentPagesStore.getState()).toMatchObject({ beside: { t1: null }, shown: { t1: "a1" } });
	});

	it("shows the conversation again when the shown page closes", () => {
		useAgentPagesStore.getState().open("t1", "a1", { sessionId: "s" });
		useAgentPagesStore.getState().close("t1", "a1");

		expect(pagesOf("t1")).toEqual([]);
		expect(useAgentPagesStore.getState().shown.t1).toBeNull();
	});

	it("drops a tab's pages when the tab closes or starts another session", () => {
		useAgentPagesStore.getState().open("t1", "a1", { sessionId: "s1" });
		useAgentPagesStore.getState().pin("t1", "a1");
		useAgentPagesStore.getState().open("t1", "a2", { sessionId: "s2" });
		expect(pagesOf("t1")).toEqual(["a2"]);

		useAgentPagesStore.getState().open("t2", "b1", { sessionId: "s3" });
		useTabsStore.setState({ tabs: [tab("t1")] });
		expect(useAgentPagesStore.getState().pages.t2).toBeUndefined();
		expect(pagesOf("t1")).toEqual(["a2"]);
	});
});
