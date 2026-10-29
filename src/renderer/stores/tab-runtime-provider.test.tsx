/**
 * A provider fed by useTabRuntime follows its tab's runtime when a session
 * switch in place replaces it. Left on the old runtime, the sidebar read the
 * session it switched away from as open, and a click on it did nothing (gui#29).
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { type SessionStore, useSessionStore } from "./session";
import { deleteSessionRuntime, SessionRuntimeProvider, sessionRuntimeStore } from "./session-runtime-context";
import { createTabRuntime, replaceTabRuntime, useTabRuntime } from "./tab-runtime";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	deleteSessionRuntime("tab-a");
});

function SessionId() {
	return <span>{useSessionStore(state => state.sessionId)}</span>;
}

function Probe() {
	const runtime = useTabRuntime("tab-a");
	return runtime ? (
		<SessionRuntimeProvider runtime={runtime}>
			<SessionId />
		</SessionRuntimeProvider>
	) : null;
}

const setSessionId = (sessionId: string) =>
	sessionRuntimeStore<SessionStore>("tab-a", "session")?.setState({ sessionId });

describe("useTabRuntime", () => {
	it("moves the provider to the runtime that replaced the tab's old one", () => {
		createTabRuntime("tab-a");
		setSessionId("fig");
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container as unknown as Element);
		act(() => root?.render(<Probe />));
		expect(container.textContent).toBe("fig");

		act(() => {
			replaceTabRuntime("tab-a");
			setSessionId("kiwi");
		});
		expect(container.textContent).toBe("kiwi");
	});
});
