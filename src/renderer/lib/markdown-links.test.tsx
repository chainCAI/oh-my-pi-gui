/**
 * Contracts for links inside rendered replies. Inline code that names a file
 * on disk becomes a link that previews the file at the named line; inline code
 * that names nothing stays code; a web address in inline code opens beside the
 * work. Before this, all three rendered as dead text the user had to retype.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IpcResolvedPath } from "../../shared/ipc-types";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";
import { I18nProvider } from "./i18n";
import { MarkdownRenderer } from "./markdown";
import { clearPathResolutionCache } from "./path-resolver";

const { document, window, Event, HTMLElement, Node, Element } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.Element = Element;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const ompWindow = window as unknown as { omp?: unknown };

const ON_DISK: Record<string, IpcResolvedPath> = {
	"src/app.ts": { absolutePath: "/work/src/app.ts", kind: "file", relativePath: "src/app.ts" },
};

let resolvePaths: Mock;
let openPath: Mock;
let browserOpen: Mock;
let host: globalThis.Element;
let root: Root;

async function settle(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function render(content: string): Promise<void> {
	host = document.createElement("div") as unknown as globalThis.Element;
	document.body.appendChild(host as never);
	root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider>
				<MarkdownRenderer content={content} />
			</I18nProvider>,
		);
	});
	await settle();
}

function click(element: globalThis.Element | null, modifiers: { metaKey?: boolean } = {}): void {
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperties(event, { metaKey: { value: modifiers.metaKey ?? false }, ctrlKey: { value: false } });
	element?.dispatchEvent(event);
}

beforeEach(() => {
	resolvePaths = vi.fn(async (paths: string[]) => paths.map(path => ON_DISK[path] ?? null));
	openPath = vi.fn(async () => ({ ok: true }));
	browserOpen = vi.fn(async () => ({}));
	ompWindow.omp = {
		system: { resolvePaths, openPath, openExternal: vi.fn(async () => {}) },
		browser: { open: browserOpen },
	};
	useTabsStore.setState({
		tabs: [{ id: "t0", cwd: "/work", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	document.body.innerHTML = "";
	delete ompWindow.omp;
	clearPathResolutionCache();
	useTabsStore.getState().reset();
	useUiStore.setState({ filePreviewPath: null, filePreviewLine: null });
});

describe("inline code paths", () => {
	it("links a path that exists and leaves one that does not as code, in one lookup", async () => {
		await render("Edit `src/app.ts:12` and `src/gone.ts`, then run `bun run build`.");

		const links = [...host.querySelectorAll('[role="link"]')];
		expect(links.map(link => link.textContent)).toEqual(["src/app.ts:12"]);
		expect([...host.querySelectorAll("code")].map(code => code.textContent)).toEqual([
			"src/app.ts:12",
			"src/gone.ts",
			"bun run build",
		]);
		// Every candidate in the reply goes to the main process together; the
		// command is never asked about.
		expect(resolvePaths).toHaveBeenCalledTimes(1);
		expect(resolvePaths.mock.calls[0]?.[0]).toEqual(["src/app.ts", "src/gone.ts"]);
	});

	it("previews the file at the named line on click and opens it outside on ⌘-click", async () => {
		await render("See `src/app.ts:12`.");
		const link = host.querySelector('[role="link"]');

		await act(async () => click(link));
		expect(useUiStore.getState()).toMatchObject({
			filePreviewPath: "/work/src/app.ts",
			filePreviewLine: 12,
			panelTab: "files",
			panelVisible: true,
		});

		await act(async () => click(link, { metaKey: true }));
		expect(openPath).toHaveBeenCalledWith("/work/src/app.ts");
	});
});

describe("inline code web addresses", () => {
	it("opens the address in the tab's browser panel", async () => {
		await render("The dev server is at `http://localhost:5173/`.");
		const anchor = host.querySelector("a");
		expect(anchor?.getAttribute("href")).toBe("http://localhost:5173/");

		await act(async () => click(anchor));
		expect(browserOpen).toHaveBeenCalledWith("t0", "http://localhost:5173/");
	});

	it("keeps code inside a markdown link part of that one link", async () => {
		await render("[`src/app.ts`](https://example.com/app)");
		await settle();

		expect(host.querySelectorAll("a")).toHaveLength(1);
		expect(host.querySelector('[role="link"]')).toBeNull();
		expect(resolvePaths).not.toHaveBeenCalled();
	});
});
