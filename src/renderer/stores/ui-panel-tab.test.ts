/**
 * setPanelTab chat clamp: a tool-free chat tab only carries files in the
 * workspace drawer (todo/plan/agents/queue moved to the center dock), so
 * force-opening the diff tab there is a no-op. The clamp lives in the ui
 * store — not just the PanelContainer tab list — because several call sites
 * force the panel open.
 */
import { afterEach, describe, expect, it } from "vitest";
import { useTabsStore } from "./tabs";
import { useUiStore } from "./ui";

function seedActiveTab(kind: "agent" | "chat"): void {
	useTabsStore.setState({
		tabs: [{ id: "t0", cwd: "/work", status: "ready", kind, unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
}

afterEach(() => {
	useTabsStore.getState().reset();
	useUiStore.setState({ panelTab: "files", panelVisible: false, diffScope: "repository" });
});

describe("setPanelTab chat clamp", () => {
	it("refuses the diff tab in a chat tab but allows files and side questions", () => {
		seedActiveTab("chat");
		// Baseline: a chat-visible tab, so a clamped no-op leaves a provable state.
		useUiStore.setState({ panelTab: "files", panelVisible: false });
		useUiStore.getState().setPanelTab("diff");
		expect(useUiStore.getState().panelTab).toBe("files");
		expect(useUiStore.getState().panelVisible).toBe(false);

		useUiStore.getState().setPanelTab("files");
		expect(useUiStore.getState().panelTab).toBe("files");
		expect(useUiStore.getState().panelVisible).toBe(true);

		useUiStore.getState().setPanelTab("btw");
		expect(useUiStore.getState().panelTab).toBe("btw");
		expect(useUiStore.getState().panelVisible).toBe(true);
	});

	it("opens every tab in an agent tab", () => {
		seedActiveTab("agent");
		for (const tab of ["diff", "files"] as const) {
			useUiStore.getState().setPanelTab(tab);
			expect(useUiStore.getState().panelTab).toBe(tab);
		}
	});
});

describe("openChanges", () => {
	// The transcript's "Review" link must land on the edits it counted, not on
	// whichever scope the drawer was last left at.
	it("opens the drawer on Changes at the requested scope", () => {
		seedActiveTab("agent");
		useUiStore.getState().openChanges("current");
		expect(useUiStore.getState()).toMatchObject({ panelVisible: true, panelTab: "diff", diffScope: "current" });
	});

	it("leaves a chat tab's drawer and scope alone", () => {
		seedActiveTab("chat");
		useUiStore.getState().openChanges("current");
		expect(useUiStore.getState()).toMatchObject({ panelVisible: false, panelTab: "files", diffScope: "repository" });
	});
});
