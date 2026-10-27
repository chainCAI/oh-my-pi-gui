/**
 * RepositoryChanges refresh contract (linkedom, same pattern as
 * QueuePanel.test.tsx): the header refresh re-reads the checkout WITHOUT
 * wiping the file list. A reload is not an initial load — if the second read
 * fails, the rows that loaded successfully stay on screen under the error,
 * instead of the panel collapsing to "Loading" and then nothing.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IpcResolvedPath } from "../../../shared/ipc-types";
import type { RpcGitChanges } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { clearPathResolutionCache } from "../../lib/path-resolver";
import { useSessionStore } from "../../stores/session";
import { LinkMenuHost } from "../common/LinkMenu";
import { RepositoryChanges } from "./RepositoryChanges";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
Object.defineProperties(window, { innerWidth: { value: 1440 }, innerHeight: { value: 900 } });

const { createRoot } = await import("react-dom/client");

interface TestElement {
	disabled: boolean;
	textContent: string | null;
	remove: () => void;
	dispatchEvent: (event: object) => boolean;
	getAttribute: (name: string) => string | null;
}

function changes(...paths: string[]): RpcGitChanges {
	return {
		isRepo: true,
		root: "/work",
		base: "main",
		files: paths.map(path => ({ path, status: "M" })),
		truncated: false,
	};
}

let getGitChanges: Mock<() => Promise<unknown>>;

function installMockOmp(next: () => Promise<unknown>): void {
	getGitChanges = vi.fn(next);
	const getGitDiff = vi.fn(async (path: string) => ({
		type: "response",
		command: "get_git_diff",
		success: true,
		data: {
			path,
			diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n-old\n+new\n+more`,
			kind: "text",
			truncated: false,
		},
	}));
	(window as unknown as { omp: { rpc: { getGitChanges: Mock; getGitDiff: Mock } } }).omp = {
		rpc: { getGitChanges, getGitDiff },
	};
}

/** Paths of the change rows on screen. */
function rowPaths(): string[] {
	return queryAll("[data-change-path]").map(row => row.getAttribute("data-change-path") ?? "");
}

let root: ReturnType<typeof createRoot>;
let container: TestElement;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<RepositoryChanges />
				<LinkMenuHost />
			</I18nProvider>,
		);
	});
	await flush();
}

function queryAll(selector: string): TestElement[] {
	return Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
}

function bodyText(): string {
	return document.body.textContent ?? "";
}

/** Dispatch inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
}

function refreshButton(): TestElement {
	const match = queryAll("button").find(button => button.getAttribute("title") === "Refresh");
	if (!match) throw new Error("refresh button not found");
	return match;
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useSessionStore.getState().reset();
	clearPathResolutionCache();
	vi.unstubAllGlobals();
});

describe("RepositoryChanges", () => {
	it("keeps the loaded file list on screen when a refresh fails", async () => {
		installMockOmp(async () => ({
			type: "response",
			command: "get_git_changes",
			success: true,
			data: changes("src/a.ts"),
		}));
		await mount();
		expect(rowPaths()).toEqual(["src/a.ts"]);
		// A small change set opens with its diff and line counts.
		expect(bodyText()).toContain("+2");
		expect(getGitChanges).toHaveBeenCalledTimes(1);

		getGitChanges.mockResolvedValueOnce({
			type: "response",
			command: "get_git_changes",
			success: false,
			error: "git status failed",
		});
		await click(refreshButton());
		await flush();

		// The user was looking at real changes; a failed re-read may not turn the
		// panel into an empty "clean tree".
		expect(rowPaths()).toEqual(["src/a.ts"]);
		expect(bodyText()).not.toContain("Working tree clean");
		expect(bodyText()).toContain("git status failed");
	});

	it("replaces the rows when the retried refresh succeeds", async () => {
		installMockOmp(async () => ({
			type: "response",
			command: "get_git_changes",
			success: true,
			data: changes("src/a.ts"),
		}));
		await mount();
		getGitChanges
			.mockResolvedValueOnce({
				type: "response",
				command: "get_git_changes",
				success: false,
				error: "git status failed",
			})
			.mockResolvedValueOnce({
				type: "response",
				command: "get_git_changes",
				success: true,
				data: changes("src/b.ts"),
			});
		await click(refreshButton());
		await flush();
		expect(bodyText()).toContain("git status failed");

		await click(refreshButton());
		await flush();

		expect(rowPaths()).toEqual(["src/b.ts"]);
		expect(bodyText()).not.toContain("git status failed");
	});

	it("re-reads the checkout when a run settles", async () => {
		// An open drawer follows the agent's work: the files it just wrote appear
		// without a manual refresh.
		installMockOmp(async () => ({
			type: "response",
			command: "get_git_changes",
			success: true,
			data: changes("src/a.ts"),
		}));
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await mount();
		getGitChanges.mockResolvedValueOnce({
			type: "response",
			command: "get_git_changes",
			success: true,
			data: changes("src/a.ts", "src/new.ts"),
		});

		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await flush();

		expect(rowPaths()).toEqual(["src/a.ts", "src/new.ts"]);
	});
});

describe("RepositoryChanges right-click", () => {
	/** A right-click on a row's header, as the user makes it. */
	async function rightClick(path: string): Promise<void> {
		const header = queryAll(`[data-change-path="${path}"] .omp-diff-card-header`)[0];
		if (!header) throw new Error(`no row for ${path}`);
		const event = new Event("contextmenu", { bubbles: true, cancelable: true });
		Object.defineProperties(event, { clientX: { value: 40 }, clientY: { value: 60 } });
		await dispatch(header, event);
		await flush();
	}

	function menuItem(label: string): TestElement {
		const item = queryAll('[role="menuitem"]').find(entry => entry.textContent === label);
		if (!item) throw new Error(`no menu item ${label}; menu: ${menuLabels().join(", ")}`);
		return item;
	}

	function menuLabels(): string[] {
		return queryAll('[role="menuitem"]').map(entry => entry.textContent ?? "");
	}

	it("reveals a changed file from the repository root and only copies a deleted one", async () => {
		installMockOmp(async () => ({
			type: "response",
			command: "get_git_changes",
			success: true,
			// The workspace is a subfolder; git names files from the repository root above it.
			data: {
				isRepo: true,
				root: "/repo",
				base: "main",
				files: [
					{ path: "app/src/a.ts", status: " M" },
					{ path: "app/old.ts", status: " D" },
				],
				truncated: false,
			},
		}));
		const onDisk: Record<string, IpcResolvedPath> = {
			"/repo/app/src/a.ts": { absolutePath: "/repo/app/src/a.ts", kind: "file", relativePath: "src/a.ts" },
		};
		const resolvePaths = vi.fn(async (paths: string[]) => paths.map(path => onDisk[path] ?? null));
		const revealPath = vi.fn(async () => ({ ok: true }));
		const writeText = vi.fn(async () => {});
		vi.stubGlobal("navigator", { platform: "MacIntel", clipboard: { writeText } });
		const omp = (window as unknown as { omp: Record<string, unknown> }).omp;
		omp.system = { resolvePaths, revealPath, openPath: vi.fn(async () => ({ ok: true })) };
		await mount();

		await rightClick("app/src/a.ts");
		expect(resolvePaths.mock.calls[0]?.[0]).toEqual(["/repo/app/src/a.ts"]);
		expect(menuLabels()).toContain("Copy relative path");
		await click(
			queryAll('[role="menuitem"]').find(entry => /Reveal|Show in/.test(entry.textContent ?? "")) as TestElement,
		);
		expect(revealPath).toHaveBeenCalledWith("/repo/app/src/a.ts");

		// Nothing is left on disk to open or reveal; the path can still be copied.
		await rightClick("app/old.ts");
		expect(menuLabels()).toEqual(["Copy path"]);
		await click(menuItem("Copy path"));
		await flush();
		expect(writeText).toHaveBeenCalledWith("/repo/app/old.ts");
	});
});
