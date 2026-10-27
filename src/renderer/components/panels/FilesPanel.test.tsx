/**
 * Right-clicking a file in the Files tree opens the file menu for the tab the
 * panel lists, so Reveal acts on that tab's file even when another tab's
 * workspace has a file at the same relative path.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IpcResolvedPath } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { clearPathResolutionCache } from "../../lib/path-resolver";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { LinkMenuHost } from "../common/LinkMenu";
import { FilesPanel } from "./FilesPanel";

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

const ompWindow = window as unknown as { omp?: unknown };

let root: Root | null = null;
let resolvePaths: Mock;
let revealPath: Mock;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

/** Dispatch inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: Element, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => root?.unmount());
		root = null;
	}
	document.body.innerHTML = "";
	delete ompWindow.omp;
	setFocusedSessionRuntime(null);
	clearPathResolutionCache();
});

describe("FilesPanel right-click", () => {
	it("reveals the right-clicked file of the panel's own tab", async () => {
		const onDisk: IpcResolvedPath = { absolutePath: "/work/b/README.md", kind: "file", relativePath: "README.md" };
		resolvePaths = vi.fn(async (paths: string[]) => paths.map(() => onDisk));
		revealPath = vi.fn(async () => ({ ok: true }));
		ompWindow.omp = {
			fs: {
				list: vi.fn(async () => ({
					ok: true,
					entries: [{ name: "README.md", path: "README.md", kind: "file" }],
					truncated: false,
				})),
			},
			system: { resolvePaths, revealPath, openPath: vi.fn(async () => ({ ok: true })) },
		};
		setFocusedSessionRuntime("tab-b");
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host as unknown as Element);
		await act(async () => {
			root?.render(
				<I18nProvider>
					<FilesPanel />
					<LinkMenuHost />
				</I18nProvider>,
			);
		});
		await flush();

		const row = document.querySelector('[data-tree-id="file:README.md"]');
		if (!row) throw new Error("README.md row missing");
		const event = new Event("contextmenu", { bubbles: true, cancelable: true });
		Object.defineProperties(event, { clientX: { value: 40 }, clientY: { value: 60 } });
		await dispatch(row as unknown as Element, event);

		expect(event.defaultPrevented).toBe(true);
		expect(resolvePaths).toHaveBeenCalledWith(["README.md"], "tab-b");
		const reveal = [...document.querySelectorAll('[role="menuitem"]')].find(item =>
			/Reveal|Show in/.test(item.textContent ?? ""),
		);
		if (!reveal) throw new Error("no reveal item");
		await dispatch(reveal as unknown as Element, new Event("click", { bubbles: true, cancelable: true }));
		expect(revealPath).toHaveBeenCalledWith("/work/b/README.md");
	});
});
