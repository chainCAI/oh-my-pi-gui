/**
 * The built-in browser: web pages that live in an agent tab's side panel and
 * that the tab's agent drives.
 *
 * Each tab owns its pages — WebContentsViews over the tab's window, all in one
 * persistent `persist:omp-browser` session so sign-ins survive restarts and
 * never mix with the app's own session. The page the panel shows sits over the
 * panel's viewport; every other page waits off-screen, where it draws nothing.
 * Pages sleep like a browser's background tabs: off-screen, or in a minimized
 * or covered window, they are hidden to themselves, draw nothing, and run
 * timers about once a second.
 *
 * The agent cannot work in a page that draws nothing: screenshots,
 * requestAnimationFrame and transitions wait for frames. While it works in a
 * page (from its first command there until AGENT_IDLE_MS after its last) the
 * page stays awake even in a minimized or covered window, and if the panel
 * does not show it, it parks overlapping the window's bottom-right corner by
 * one pixel, under a one-pixel cover, at a desktop size at least, so a narrow
 * panel never hands the agent a phone layout. Idle, it sleeps off-screen again.
 * Waking and sleeping take care: see #setAwake.
 *
 * Keystrokes in a focused page reach the page, never the app's window, so the
 * host claims the ones that belong elsewhere: browser keys (reload, back and
 * forward, DevTools, the address bar) act on the page instead of on the app
 * window the native menu would hit, and app keymap chords go to the window.
 *
 * Agent access goes through the tab's sidecar: `browser_host_start` makes it
 * serve a private browser relay, and this host dials that relay as its
 * extension (wire protocol: browser-relay-protocol.ts). The relay sees the
 * pages as browser tabs: it attaches each page's own debugger
 * (`webContents.debugger`), opens pages for the agent, and closes the ones it
 * opened. The user watches every step and can take over at any time.
 */
import {
	app,
	type BrowserWindow,
	type ContextMenuParams,
	clipboard,
	Menu,
	type MenuItemConstructorOptions,
	type Session,
	session,
	shell,
	View,
	type WebContents,
	WebContentsView,
	webContents,
} from "electron";
import { chromeUserAgent, isPageUrl, normalizeAddress } from "../shared/browser-address";
import {
	IPC_EVENTS,
	type IpcBrowserAction,
	type IpcBrowserKeyPayload,
	type IpcBrowserPage,
	type IpcBrowserState,
} from "../shared/ipc-types";
import type { RpcBrowserHostInfo } from "../shared/rpc-types";
import { type PageKeyCommand, pageKeyCommand } from "./browser-keys";
import {
	DISCARDED_TABS_PROTOCOL_VERSION,
	type ExtToRelayMessage,
	type RelayRpcRequest,
	type RelayTabSnapshot,
	type RelayToExtMessage,
} from "./browser-relay-protocol";
import { editableContextMenuTemplate } from "./editable-context-menu";
import { getMainLanguage, mainT } from "./i18n";
import type { SidecarManager } from "./sidecar";

const PARTITION = "persist:omp-browser";
/** Size of hidden pages until the panel has been shown once, and the least a page the agent works in gets. */
const DESKTOP_PAGE_SIZE = { width: 1280, height: 800 } as const;
const OFFSCREEN_GAP = 64;
/** The agent counts as working in a page until this long after its last command there. */
const AGENT_IDLE_MS = 30_000;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;
/** Page permissions granted without asking; the panel has no permission prompt. */
const GRANTED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);
const CAPTURE_JPEG_QUALITY = 85;
const MINIMIZED_CAPTURE_ERROR =
	"The omp window is minimized, so this page cannot be captured until the user restores the window. Other page commands still work.";
/**
 * Group id reported for pages the agent drives. The relay groups exactly the
 * pages a client created or adopted; the panel has no tab groups, so it reads
 * membership as "the agent is driving this page" and echoes one fixed id.
 */
const DRIVEN_GROUP_ID = 1;

/** The Edit menu's Find commands. */
export type BrowserFindCommand = "find" | "next" | "previous";

export interface BrowserRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

let browserSessionInstance: Session | null = null;

/** The pages' session: a plain Chrome user agent, and no permission the user was never asked about. */
function browserSession(): Session {
	if (browserSessionInstance) return browserSessionInstance;
	const ses = session.fromPartition(PARTITION);
	ses.setUserAgent(chromeUserAgent(ses.getUserAgent(), app.getName()));
	ses.setPermissionRequestHandler((_contents, permission, callback) => callback(GRANTED_PERMISSIONS.has(permission)));
	ses.setPermissionCheckHandler((_contents, permission) => GRANTED_PERMISSIONS.has(permission));
	browserSessionInstance = ses;
	return ses;
}

interface BrowserPage {
	readonly id: number;
	readonly view: WebContentsView;
	readonly openedBy: "agent" | "user";
	/** The relay holds this page's debugger. Its CDP client attaches to every page, so this is not "driven". */
	attached: boolean;
	/** The agent drives this page: it created or adopted it (the relay grouped it). */
	driven: boolean;
	/** The relay asked for the detach under way, so its event is an echo rather than the user's doing. */
	detachingForRelay: boolean;
	/** Last main-frame load failure; cleared when the next load starts. */
	error?: string;
	/** Agent commands under way in this page. */
	pending: number;
	/** The agent counts as working in this page until then (epoch ms). */
	activeUntil: number;
	/** Puts the page back to sleep once the agent has been idle long enough. */
	idleTimer: NodeJS.Timeout | null;
	/** Off-screen: neither shown nor parked. */
	away: boolean;
	/** Throttled like a background tab (Electron's `backgroundThrottling`). */
	throttled: boolean;
	/** Woken in a minimized window: no screenshot until the window is shown again. */
	blind: boolean;
	/**
	 * Debugger sessions ("" for the page's own) where the agent turned on focus
	 * emulation. Chromium counts it as a visible capture, which would keep the
	 * page awake for good, so it holds only while the page is awake.
	 */
	focusEmulation: Set<string>;
	/** The latest find request; results of older ones are stale. */
	findRequest?: number;
	find?: { active: number; matches: number };
}

function emptyState(tabId: string): IpcBrowserState {
	return { tabId, pages: [], activePageId: null, agentLinked: false };
}

function isHostInfo(value: unknown): value is RpcBrowserHostInfo {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { extensionUrl?: unknown }).extensionUrl === "string"
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One tab's pages and its link to the tab's sidecar relay. */
class TabBrowser {
	readonly tabId: string;
	readonly win: BrowserWindow;
	#pages = new Map<number, BrowserPage>();
	#activePageId: number | null = null;
	/** Where the panel shows the active page, in window DIPs; null while the panel is hidden. */
	#viewport: BrowserRect | null = null;
	#pageSize: { width: number; height: number } = DESKTOP_PAGE_SIZE;
	#extensionUrl: string | null = null;
	#socket: WebSocket | null = null;
	#helloSent = false;
	#ping: NodeJS.Timeout | null = null;
	#reconnect: NodeJS.Timeout | null = null;
	#reconnectDelay = RECONNECT_MIN_MS;
	#statePending = false;
	#disposed = false;
	/** Covers the corner pixel parked pages show through; present while any page is parked. */
	#cover: View | null = null;
	/** Parked pages follow the window's corner. */
	readonly #onWindowResize = (): void => this.#layout();
	readonly #onWindowShown = (): void => {
		for (const page of this.#pages.values()) page.blind = false;
	};

	readonly #appChords: () => ReadonlySet<string>;

	constructor(tabId: string, win: BrowserWindow, appChords: () => ReadonlySet<string>) {
		this.tabId = tabId;
		this.win = win;
		this.#appChords = appChords;
		win.on("resize", this.#onWindowResize);
		win.on("restore", this.#onWindowShown);
		win.on("show", this.#onWindowShown);
	}

	get state(): IpcBrowserState {
		const pages: IpcBrowserPage[] = [];
		for (const page of this.#pages.values()) {
			const contents = page.view.webContents;
			if (contents.isDestroyed()) continue;
			pages.push({
				pageId: page.id,
				url: contents.getURL(),
				title: contents.getTitle(),
				loading: contents.isLoading(),
				canGoBack: contents.navigationHistory.canGoBack(),
				canGoForward: contents.navigationHistory.canGoForward(),
				openedBy: page.openedBy,
				agentDriving: page.driven,
				...(page.error ? { error: page.error } : {}),
				...(page.find ? { find: page.find } : {}),
			});
		}
		return { tabId: this.tabId, pages, activePageId: this.#activePageId, agentLinked: this.#helloSent };
	}

	// ── panel ────────────────────────────────────────────────────────────────

	/** Open a page the user asked for and show it. */
	openForUser(address: string): void {
		const page = this.#addPage({ openedBy: "user", select: true });
		this.#load(page, normalizeAddress(address));
	}

	action(pageId: number, action: IpcBrowserAction): void {
		const page = this.#pages.get(pageId);
		if (!page) return;
		const contents = page.view.webContents;
		switch (action.action) {
			case "navigate":
				this.#load(page, normalizeAddress(action.url));
				return;
			case "back":
				if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
				return;
			case "forward":
				if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
				return;
			case "reload":
				contents.reload();
				return;
			case "stop":
				contents.stop();
				return;
			case "select":
				this.#select(pageId);
				return;
			case "close":
				this.#closePage(pageId);
				return;
			case "devtools":
				// Chromium hands the page's debugger to DevTools: the agent loses this page.
				contents.openDevTools({ mode: "detach" });
				return;
			case "external": {
				const url = contents.getURL();
				if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
				return;
			}
			case "find":
				if (!action.text) {
					this.#endFind(page, "clearSelection");
					return;
				}
				page.findRequest = contents.findInPage(action.text, {
					forward: !action.backward,
					// Electron's `findNext` starts a new search; a follow-up steps through the current one.
					findNext: !action.next,
				});
				return;
			case "stopFind":
				this.#endFind(page, "keepSelection");
				if (action.focusPage && this.#viewport !== null && pageId === this.#activePageId) contents.focus();
				return;
		}
	}

	/** The Edit menu's Find commands, for the page on screen or the focused one. */
	findKey(command: BrowserFindCommand): void {
		if (command === "find") {
			// The find field is in the window: type there.
			this.#focusWindow();
			this.#sendKey({ tabId: this.tabId, kind: "find" });
			return;
		}
		this.#sendKey({ tabId: this.tabId, kind: "findNext", backward: command === "previous" });
	}

	/** True when `contents` is one of this tab's pages. */
	owns(contents: WebContents): boolean {
		return this.#pages.get(contents.id)?.view.webContents === contents;
	}

	/** The panel shows one of this tab's pages. */
	get showing(): boolean {
		return this.#viewport !== null && this.#activePageId !== null;
	}

	/** Show the active page over `rect` (window DIPs), or hide it. */
	setViewport(rect: BrowserRect | null): void {
		const shown =
			this.#viewport !== null && this.#activePageId !== null ? this.#pages.get(this.#activePageId) : undefined;
		this.#viewport = rect && rect.width > 0 && rect.height > 0 ? rect : null;
		// Keystrokes would keep going to a page the user can no longer see.
		if (!this.#viewport && shown && !shown.view.webContents.isDestroyed() && shown.view.webContents.isFocused()) {
			this.#focusWindow();
		}
		if (this.#viewport) this.#pageSize = { width: this.#viewport.width, height: this.#viewport.height };
		this.#layout();
	}

	/** Still of the page the panel shows, for display while a dialog covers the live view. */
	async capture(): Promise<string | null> {
		const page = this.#activePageId === null ? undefined : this.#pages.get(this.#activePageId);
		if (!page || page.view.webContents.isDestroyed()) return null;
		const image = await page.view.webContents.capturePage();
		if (image.isEmpty()) return null;
		return `data:image/jpeg;base64,${image.toJPEG(CAPTURE_JPEG_QUALITY).toString("base64")}`;
	}

	// ── relay link ───────────────────────────────────────────────────────────

	/** Dial the tab sidecar's relay (a restarted sidecar serves a new one). */
	link(extensionUrl: string): void {
		if (this.#disposed) return;
		if (this.#extensionUrl === extensionUrl && this.#socket) return;
		this.#dropSocket();
		this.#extensionUrl = extensionUrl;
		this.#reconnectDelay = RECONNECT_MIN_MS;
		this.#connect();
	}

	/** The sidecar stopped serving: hang up and release every page's debugger. Pages stay. */
	unlink(): void {
		this.#extensionUrl = null;
		if (this.#reconnect) clearTimeout(this.#reconnect);
		this.#reconnect = null;
		this.#dropSocket();
	}

	dispose(): void {
		this.unlink();
		this.#disposed = true;
		for (const page of [...this.#pages.values()]) this.#closePage(page.id);
		if (this.win.isDestroyed()) return;
		this.win.off("resize", this.#onWindowResize);
		this.win.off("restore", this.#onWindowShown);
		this.win.off("show", this.#onWindowShown);
	}

	#connect(): void {
		if (this.#disposed || !this.#extensionUrl || this.#socket) return;
		const socket = new WebSocket(this.#extensionUrl);
		this.#socket = socket;
		socket.onopen = () => {
			if (this.#socket !== socket) return;
			this.#reconnectDelay = RECONNECT_MIN_MS;
			const tabs: RelayTabSnapshot[] = [];
			for (const page of this.#pages.values()) tabs.push(this.#snapshot(page));
			this.#post({
				t: "hello",
				userAgent: browserSession().getUserAgent(),
				browserVersion: `Chrome/${process.versions.chrome}`,
				tabs,
				// Debuggers never outlive a link (see #dropSocket).
				attachedTabIds: [],
				discardedTabsProtocol: DISCARDED_TABS_PROTOCOL_VERSION,
				instanceId: `omp-gui-${this.tabId}`,
			});
			this.#helloSent = true;
			this.#ping = setInterval(() => this.#post({ t: "ping" }), PING_INTERVAL_MS);
			this.#changed();
		};
		socket.onmessage = event => {
			if (this.#socket === socket && typeof event.data === "string") this.#onRelayMessage(event.data);
		};
		socket.onclose = () => {
			if (this.#socket !== socket) return;
			this.#dropSocket();
			this.#scheduleReconnect();
		};
		socket.onerror = () => socket.close();
	}

	#scheduleReconnect(): void {
		if (this.#disposed || !this.#extensionUrl || this.#reconnect) return;
		const delay = this.#reconnectDelay;
		this.#reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
		this.#reconnect = setTimeout(() => {
			this.#reconnect = null;
			this.#connect();
		}, delay);
	}

	/**
	 * Forget the socket and detach every debugger: domains the old relay enabled
	 * (request interception, for one) would otherwise stay armed on pages no
	 * client drives any more.
	 */
	#dropSocket(): void {
		const socket = this.#socket;
		this.#socket = null;
		this.#helloSent = false;
		if (this.#ping) clearInterval(this.#ping);
		this.#ping = null;
		if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close();
		for (const page of this.#pages.values()) {
			// The relay's groups end with its connection, and the agent's work with them.
			page.driven = false;
			page.activeUntil = 0;
			page.focusEmulation.clear();
			if (!page.attached) continue;
			page.attached = false;
			const debuggerHandle = page.view.webContents.debugger;
			if (debuggerHandle.isAttached()) debuggerHandle.detach();
		}
		// Pages the agent was working in go back to sleep.
		this.#layout();
		this.#changed();
	}

	#post(message: ExtToRelayMessage): void {
		if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
	}

	#onRelayMessage(raw: string): void {
		let message: RelayToExtMessage;
		try {
			message = JSON.parse(raw) as RelayToExtMessage;
		} catch {
			return;
		}
		if (message.t !== "rpc") return;
		const { id } = message;
		this.#runRpc(message).then(
			result => this.#post({ t: "rpcResult", id, ok: true, result }),
			(error: unknown) => this.#post({ t: "rpcResult", id, ok: false, error: errorText(error) }),
		);
	}

	async #runRpc(request: RelayRpcRequest): Promise<unknown> {
		switch (request.op) {
			case "attach": {
				const page = this.#requirePage(request.tabId);
				if (!page.attached) {
					page.view.webContents.debugger.attach("1.3");
					page.attached = true;
					this.#changed();
				}
				return {};
			}
			case "detach": {
				const page = this.#pages.get(request.tabId);
				if (page?.attached) {
					page.detachingForRelay = true;
					page.view.webContents.debugger.detach();
					// The relay waits for the detach echo before the result.
					this.#debuggerDetached(page, "target_closed");
				}
				return {};
			}
			case "send": {
				const page = this.#requirePage(request.tabId);
				if (!page.attached) throw new Error(`Debugger is not attached to tab ${request.tabId}`);
				// The relay's client sends to every page; only one the agent drives is worked in.
				if (page.driven) this.#agentWorks(page);
				// Bringing a page to the front focuses it, pulling keyboard focus out
				// of the composer; the agent's pages paint where they are.
				if (request.method === "Page.bringToFront" && !request.sessionId) return {};
				// Chromium would wait for the window instead of failing.
				if (page.blind && request.method === "Page.captureScreenshot") throw new Error(MINIMIZED_CAPTURE_ERROR);
				if (request.method === "Emulation.setFocusEmulationEnabled") {
					const session = request.sessionId ?? "";
					if (request.params?.enabled === true) page.focusEmulation.add(session);
					else page.focusEmulation.delete(session);
					// A sleeping page gets it when it wakes.
					if (page.throttled) return {};
				}
				page.pending++;
				try {
					return await page.view.webContents.debugger.sendCommand(
						request.method,
						request.params ?? {},
						request.sessionId,
					);
				} finally {
					page.pending--;
					// Idle counts from the last command's end, not its start.
					if (page.driven) this.#agentWorks(page);
				}
			}
			case "createTab": {
				const page = this.#addPage({ openedBy: "agent", select: request.active !== false, agentWorks: true });
				this.#load(page, request.url);
				return { tab: this.#snapshot(page) };
			}
			case "removeTab":
				this.#closePage(request.tabId);
				return {};
			case "activateTab": {
				const page = this.#requirePage(request.tabId);
				if (page.driven) this.#agentWorks(page);
				this.#select(request.tabId);
				return {};
			}
			case "group": {
				const grouped: Record<string, number> = {};
				for (const tabId of request.tabIds) {
					const page = this.#pages.get(tabId);
					if (!page) continue;
					page.driven = true;
					this.#agentWorks(page, { layout: false });
					grouped[String(tabId)] = DRIVEN_GROUP_ID;
				}
				this.#layout();
				this.#changed();
				return { grouped };
			}
			case "ungroup":
				for (const tabId of request.tabIds) {
					const page = this.#pages.get(tabId);
					if (!page) continue;
					// The agent let go of the page: it can sleep now.
					page.driven = false;
					page.activeUntil = 0;
				}
				this.#layout();
				this.#changed();
				return {};
		}
	}

	#requirePage(pageId: number): BrowserPage {
		const page = this.#pages.get(pageId);
		if (!page || page.view.webContents.isDestroyed()) throw new Error(`No tab with id: ${pageId}`);
		return page;
	}

	#debuggerDetached(page: BrowserPage, reason: string): void {
		if (!page.attached) return;
		page.attached = false;
		page.focusEmulation.clear();
		const relayInitiated = page.detachingForRelay;
		page.detachingForRelay = false;
		if (this.#pages.get(page.id) === page) this.#post({ t: "detached", tabId: page.id, reason, relayInitiated });
		this.#changed();
	}

	#snapshot(page: BrowserPage): RelayTabSnapshot {
		const contents = page.view.webContents;
		const destroyed = contents.isDestroyed();
		return {
			tabId: page.id,
			url: destroyed ? "" : contents.getURL(),
			title: destroyed ? "" : contents.getTitle(),
			active: page.id === this.#activePageId,
			discarded: false,
			windowId: this.win.isDestroyed() ? -1 : this.win.id,
			pinned: false,
			groupId: page.driven ? DRIVEN_GROUP_ID : -1,
		};
	}

	#pageUpdated(page: BrowserPage): void {
		if (this.#pages.get(page.id) === page) this.#post({ t: "tabUpdated", tab: this.#snapshot(page) });
		this.#changed();
	}

	// ── pages ────────────────────────────────────────────────────────────────

	#addPage(options: {
		openedBy: "agent" | "user";
		select: boolean;
		/** The agent opens the page to work in it: it starts awake instead of being woken. */
		agentWorks?: boolean;
		webContents?: WebContents;
	}): BrowserPage {
		if (this.#disposed || this.win.isDestroyed()) throw new Error("The browser panel's window is closed");
		const view = new WebContentsView(
			options.webContents
				? { webContents: options.webContents }
				: {
						webPreferences: {
							session: browserSession(),
							sandbox: true,
							contextIsolation: true,
							nodeIntegration: false,
							spellcheck: true,
							backgroundThrottling: options.agentWorks !== true,
						},
					},
		);
		view.setBackgroundColor("#ffffff");
		const contents = view.webContents;
		const page: BrowserPage = {
			id: contents.id,
			view,
			openedBy: options.openedBy,
			attached: false,
			driven: false,
			detachingForRelay: false,
			pending: 0,
			activeUntil: 0,
			idleTimer: null,
			away: true,
			// A popup's contents come with their own setting.
			throttled: contents.getBackgroundThrottling(),
			blind: false,
			focusEmulation: new Set(),
		};
		this.#pages.set(page.id, page);
		this.#wirePage(page);
		if (options.agentWorks) this.#agentWorks(page, { layout: false });
		this.win.contentView.addChildView(view);
		if (options.select || this.#activePageId === null) this.#activePageId = page.id;
		this.#layout();
		this.#post({ t: "tabCreated", tab: this.#snapshot(page) });
		this.#changed();
		return page;
	}

	#wirePage(page: BrowserPage): void {
		const contents = page.view.webContents;
		contents.on("did-start-loading", () => {
			page.error = undefined;
			this.#changed();
		});
		contents.on("did-stop-loading", () => this.#changed());
		contents.on("did-navigate", () => {
			// A new document: the old matches are gone.
			page.find = undefined;
			page.findRequest = undefined;
			this.#pageUpdated(page);
		});
		contents.on("found-in-page", (_event, result) => {
			if (result.requestId !== page.findRequest) return;
			page.find = { active: Math.max(0, result.activeMatchOrdinal), matches: result.matches };
			this.#changed();
		});
		contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
			if (isMainFrame) this.#pageUpdated(page);
		});
		contents.on("page-title-updated", () => this.#pageUpdated(page));
		contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
			// -3 is ERR_ABORTED: a navigation the user or the page replaced.
			if (!isMainFrame || errorCode === -3) return;
			page.error = `${errorDescription} (${validatedURL})`;
			this.#changed();
		});
		contents.on("render-process-gone", (_event, details) => {
			page.error = details.reason;
			this.#changed();
		});
		contents.on("will-navigate", event => {
			if (!isPageUrl(event.url)) event.preventDefault();
		});
		contents.setWindowOpenHandler(details => {
			if (!isPageUrl(details.url)) return { action: "deny" };
			return {
				action: "allow",
				// Popups become pages of this panel. Electron supplies the
				// webContents when the opener keeps a handle to the popup.
				createWindow: popupOptions => {
					const adopted = (popupOptions as { webContents?: WebContents }).webContents;
					const popup = this.#addPage({
						openedBy: page.openedBy,
						select: details.disposition !== "background-tab",
						webContents: adopted,
					});
					return popup.view.webContents;
				},
			};
		});
		contents.on("context-menu", (_event, params) => this.#contextMenu(page, params));
		contents.on("before-input-event", (event, input) => {
			const command = pageKeyCommand(input, this.#appChords());
			if (!command) return;
			event.preventDefault();
			if (!input.isAutoRepeat) this.#pageKey(page, command);
		});
		contents.debugger.on("message", (_event, method, params, sessionId) => {
			if (!page.attached) return;
			this.#post({
				t: "cdpEvent",
				tabId: page.id,
				...(sessionId ? { sessionId } : {}),
				method,
				params: params as Record<string, unknown> | undefined,
			});
		});
		contents.debugger.on("detach", (_event, reason) => this.#debuggerDetached(page, reason));
		// The page closed itself (`window.close()` from a popup it opened).
		contents.on("destroyed", () => this.#forget(page));
	}

	#pageKey(page: BrowserPage, command: PageKeyCommand): void {
		switch (command.kind) {
			case "reload":
				if (command.ignoreCache) page.view.webContents.reloadIgnoringCache();
				else page.view.webContents.reload();
				return;
			case "back":
				this.action(page.id, { action: "back" });
				return;
			case "forward":
				this.action(page.id, { action: "forward" });
				return;
			case "devtools":
				this.action(page.id, { action: "devtools" });
				return;
			case "focusAddress":
				this.#focusWindow();
				this.#sendKey({ tabId: this.tabId, kind: "focusAddress" });
				return;
			case "shortcut":
				// The app answers in its own window (a palette, a dialog): focus follows.
				this.#focusWindow();
				this.#sendKey({ tabId: this.tabId, kind: "shortcut", key: command.key });
				return;
		}
	}

	#focusWindow(): void {
		if (!this.win.isDestroyed()) this.win.webContents.focus();
	}

	#sendKey(payload: IpcBrowserKeyPayload): void {
		if (!this.win.isDestroyed()) this.win.webContents.send(IPC_EVENTS.BROWSER_KEY, payload);
	}

	#load(page: BrowserPage, url: string): void {
		if (!isPageUrl(url)) {
			page.error = `Blocked address: ${url}`;
			this.#changed();
			return;
		}
		// Failures surface through did-fail-load; the rejection carries nothing more.
		page.view.webContents.loadURL(url).catch(() => {});
	}

	#select(pageId: number): void {
		const page = this.#pages.get(pageId);
		if (!page || pageId === this.#activePageId) return;
		this.#activePageId = pageId;
		this.#layout();
		this.#pageUpdated(page);
	}

	#closePage(pageId: number): void {
		const page = this.#pages.get(pageId);
		if (!page) return;
		this.#forget(page);
		const contents = page.view.webContents;
		if (!contents.isDestroyed()) contents.close();
	}

	#forget(page: BrowserPage): void {
		if (this.#pages.get(page.id) !== page) return;
		this.#pages.delete(page.id);
		if (page.idleTimer) clearTimeout(page.idleTimer);
		page.idleTimer = null;
		if (!this.win.isDestroyed()) this.win.contentView.removeChildView(page.view);
		this.#post({ t: "tabRemoved", tabId: page.id });
		if (this.#activePageId === page.id) {
			const next = [...this.#pages.values()].at(-1);
			this.#activePageId = next?.id ?? null;
			if (next) this.#pageUpdated(next);
		}
		this.#layout();
		this.#changed();
	}

	/**
	 * The active page over the viewport. Pages the agent works in that the panel
	 * does not show park one pixel into the window's bottom-right corner (under
	 * the cover, and the window's rounded corner) so they keep painting; the rest
	 * wait off-screen. Hidden pages keep the panel's size so showing one needs no
	 * relayout; the agent's get a desktop size at least. Pages the agent works in
	 * are awake, the rest sleep.
	 */
	#layout(): void {
		if (this.win.isDestroyed()) return;
		const [windowWidth = 0, windowHeight = 0] = this.win.getContentSize();
		const corner = { x: windowWidth - 1, y: windowHeight - 1 };
		const panelSize = this.#pageSize;
		const agentSize = {
			width: Math.max(panelSize.width, DESKTOP_PAGE_SIZE.width),
			height: Math.max(panelSize.height, DESKTOP_PAGE_SIZE.height),
		};
		let parked = false;
		for (const page of this.#pages.values()) {
			if (page.view.webContents.isDestroyed()) continue;
			const size = page.driven ? agentSize : panelSize;
			const working = this.#agentWorking(page);
			let bounds: BrowserRect;
			page.away = false;
			if (this.#viewport !== null && page.id === this.#activePageId) {
				bounds = this.#viewport;
			} else if (working) {
				bounds = { ...corner, ...size };
				parked = true;
			} else {
				bounds = { x: -(size.width + OFFSCREEN_GAP), y: 0, ...size };
				page.away = true;
			}
			if (working === page.throttled) this.#setAwake(page, working, bounds);
			else page.view.setBounds(bounds);
		}
		this.#placeCover(parked ? corner : null);
	}

	/**
	 * Wake `page` for the agent, or put it back to sleep, and place it at
	 * `bounds`. Electron re-shows a hidden page itself when its throttling
	 * changes, and a page re-shown that way never yields another screenshot. So
	 * a page wakes while a visible capture holds it shown the regular way (even
	 * in a minimized or covered window), and sleeps by turning throttling on
	 * while still shown (an unthrottled page never hides), then having a hidden
	 * capture make Chromium apply the window's visibility it ignored while awake.
	 * The agent's focus emulation, a visible capture of its own, holds only while
	 * the page is awake.
	 */
	#setAwake(page: BrowserPage, awake: boolean, bounds: BrowserRect): void {
		const contents = page.view.webContents;
		// The images are never used.
		if (awake) {
			page.view.setBounds(bounds);
			contents.capturePage(undefined, { stayHidden: false }).catch(() => {});
			contents.setBackgroundThrottling(false);
			// Chromium cannot capture it until the window is shown.
			page.blind = !this.win.isVisible() || this.win.isMinimized();
		} else {
			contents.setBackgroundThrottling(true);
			page.view.setBounds(bounds);
			contents.capturePage(undefined, { stayHidden: true }).catch(() => {});
			page.blind = false;
		}
		page.throttled = !awake;
		// Sent ahead of the agent's command that woke the page, in its session's order.
		if (!page.attached) return;
		for (const session of page.focusEmulation) {
			contents.debugger
				.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: awake }, session || undefined)
				.catch(() => page.focusEmulation.delete(session));
		}
	}

	#agentWorking(page: BrowserPage): boolean {
		return (page.driven && page.pending > 0) || Date.now() < page.activeUntil;
	}

	/** The agent acts in `page`: wake it where it paints, and keep it so until the agent has been idle a while. */
	#agentWorks(page: BrowserPage, options: { layout: boolean } = { layout: true }): void {
		page.activeUntil = Date.now() + AGENT_IDLE_MS;
		page.idleTimer ??= setTimeout(() => this.#agentIdleCheck(page), AGENT_IDLE_MS);
		if (options.layout && (page.away || page.throttled)) this.#layout();
	}

	#agentIdleCheck(page: BrowserPage): void {
		page.idleTimer = null;
		if (this.#pages.get(page.id) !== page) return;
		if (this.#agentWorking(page)) {
			const remaining = page.activeUntil - Date.now();
			page.idleTimer = setTimeout(() => this.#agentIdleCheck(page), remaining > 0 ? remaining : AGENT_IDLE_MS);
			return;
		}
		this.#layout();
	}

	#endFind(page: BrowserPage, selection: "clearSelection" | "keepSelection"): void {
		page.findRequest = undefined;
		page.find = undefined;
		page.view.webContents.stopFindInPage(selection);
		this.#changed();
	}

	/** One window-colored pixel over the parked pages' corner; null removes it. */
	#placeCover(corner: { x: number; y: number } | null): void {
		if (!corner) {
			if (this.#cover) this.win.contentView.removeChildView(this.#cover);
			this.#cover = null;
			return;
		}
		this.#cover ??= new View();
		this.#cover.setBackgroundColor(this.win.getBackgroundColor());
		// Re-adding moves it above pages added since.
		this.win.contentView.addChildView(this.#cover);
		this.#cover.setBounds({ ...corner, width: 1, height: 1 });
	}

	#contextMenu(page: BrowserPage, params: ContextMenuParams): void {
		const contents = page.view.webContents;
		const language = getMainLanguage();
		const items: MenuItemConstructorOptions[] = [];
		const separate = (): void => {
			if (items.length > 0 && items.at(-1)?.type !== "separator") items.push({ type: "separator" });
		};
		if (params.linkURL && isPageUrl(params.linkURL)) {
			const link = params.linkURL;
			items.push({ label: mainT("browser.openLinkInNewPage", language), click: () => this.openForUser(link) });
			if (/^https?:\/\//i.test(link)) {
				items.push({
					label: mainT("browser.openLinkExternally", language),
					click: () => void shell.openExternal(link),
				});
			}
			items.push({ label: mainT("browser.copyLink", language), click: () => clipboard.writeText(link) });
			separate();
		}
		if (params.mediaType === "image" && params.srcURL) {
			const source = params.srcURL;
			items.push(
				{ label: mainT("browser.copyImage", language), click: () => contents.copyImageAt(params.x, params.y) },
				{ label: mainT("browser.copyImageAddress", language), click: () => clipboard.writeText(source) },
			);
			separate();
		}
		if (params.isEditable) {
			items.push(
				...editableContextMenuTemplate(params, mainT("menu.addToDictionary", language), {
					replaceMisspelling: suggestion => contents.replaceMisspelling(suggestion),
					addToDictionary: word => contents.session.addWordToSpellCheckerDictionary(word),
				}),
			);
			separate();
		} else if (params.selectionText) {
			items.push({ role: "copy" });
			separate();
		}
		items.push(
			{
				label: mainT("browser.back", language),
				enabled: contents.navigationHistory.canGoBack(),
				click: () => contents.navigationHistory.goBack(),
			},
			{
				label: mainT("browser.forward", language),
				enabled: contents.navigationHistory.canGoForward(),
				click: () => contents.navigationHistory.goForward(),
			},
			{ label: mainT("browser.reload", language), click: () => contents.reload() },
			{ type: "separator" },
			{ label: mainT("browser.inspect", language), click: () => contents.inspectElement(params.x, params.y) },
		);
		if (!this.win.isDestroyed()) Menu.buildFromTemplate(items).popup({ window: this.win });
	}

	/** Push the state to the window once per turn, however many page events fired. */
	#changed(): void {
		if (this.#statePending) return;
		this.#statePending = true;
		setImmediate(() => {
			this.#statePending = false;
			if (!this.win.isDestroyed()) this.win.webContents.send(IPC_EVENTS.BROWSER_STATE, this.state);
		});
	}
}

/** Every tab's built-in browser. */
export class BrowserHost {
	#tabs = new Map<string, TabBrowser>();
	/** Chords the app keymap dispatches (the renderer reports them; prefs can remap). */
	#appChords: ReadonlySet<string> = new Set();
	/** Bumped whenever a tab's sidecar comes up or goes down, so a stale link attempt drops its result. */
	#linkGeneration = new Map<string, number>();

	/** The tab's sidecar is serving: have it host a relay for this tab's pages, then dial in. */
	async link(tab: { tabId: string; win: BrowserWindow; sidecar: SidecarManager }): Promise<void> {
		const generation = this.#bump(tab.tabId);
		const client = tab.sidecar.rpcClient;
		if (!client) return;
		let info: RpcBrowserHostInfo;
		try {
			const response = await client.command({ type: "browser_host_start" });
			// An older sidecar without the command simply runs its own browser.
			if (!response.success || !isHostInfo(response.data)) return;
			info = response.data;
		} catch {
			return;
		}
		if (this.#linkGeneration.get(tab.tabId) !== generation || tab.win.isDestroyed()) return;
		this.#ensure(tab.tabId, tab.win).link(info.extensionUrl);
	}

	/** The tab's sidecar stopped (restart, crash, exit). Its pages stay open for the next one. */
	unlink(tabId: string): void {
		this.#bump(tabId);
		this.#tabs.get(tabId)?.unlink();
	}

	/** The tab is gone: close its pages. */
	release(tabId: string): void {
		this.#linkGeneration.delete(tabId);
		this.#tabs.get(tabId)?.dispose();
		this.#tabs.delete(tabId);
	}

	state(tabId: string): IpcBrowserState {
		return this.#tabs.get(tabId)?.state ?? emptyState(tabId);
	}

	setAppShortcuts(chords: readonly string[]): void {
		this.#appChords = new Set(chords);
	}

	/**
	 * The Edit menu's Find commands. Their shortcuts reach the menu only when
	 * the focused page did not take the keys itself, as in Chrome: a web app
	 * with its own ⌘F keeps it. They act on the focused page; with focus in the
	 * window instead this returns false and the window decides what to search
	 * (the conversation, or the panel's page).
	 */
	find(command: BrowserFindCommand): boolean {
		const focused = webContents.getFocusedWebContents();
		const owner = focused ? [...this.#tabs.values()].find(tab => tab.owns(focused)) : undefined;
		owner?.findKey(command);
		return owner !== undefined;
	}

	open(tabId: string, win: BrowserWindow, address: string): IpcBrowserState {
		const tab = this.#ensure(tabId, win);
		tab.openForUser(address);
		return tab.state;
	}

	action(tabId: string, pageId: number, action: IpcBrowserAction): IpcBrowserState {
		const tab = this.#tabs.get(tabId);
		if (!tab) return emptyState(tabId);
		tab.action(pageId, action);
		return tab.state;
	}

	/**
	 * Place the tab's active page over the panel. `bounds` are the renderer's
	 * CSS pixels; the window's zoom turns them into the DIPs views are laid out
	 * in. Showing one tab's page hides every other tab's in that window.
	 */
	setViewport(tabId: string, win: BrowserWindow, bounds: BrowserRect | null): void {
		if (bounds) {
			for (const other of this.#tabs.values()) {
				if (other.tabId !== tabId && other.win === win) other.setViewport(null);
			}
		}
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		if (!bounds) {
			tab.setViewport(null);
			return;
		}
		const zoom = win.webContents.getZoomFactor();
		tab.setViewport({
			x: Math.round(bounds.x * zoom),
			y: Math.round(bounds.y * zoom),
			width: Math.round(bounds.width * zoom),
			height: Math.round(bounds.height * zoom),
		});
	}

	async capture(tabId: string): Promise<string | null> {
		return (await this.#tabs.get(tabId)?.capture()) ?? null;
	}

	disposeAll(): void {
		for (const tabId of [...this.#tabs.keys()]) this.release(tabId);
	}

	#ensure(tabId: string, win: BrowserWindow): TabBrowser {
		let tab = this.#tabs.get(tabId);
		if (!tab) {
			tab = new TabBrowser(tabId, win, () => this.#appChords);
			this.#tabs.set(tabId, tab);
		}
		return tab;
	}

	#bump(tabId: string): number {
		const next = (this.#linkGeneration.get(tabId) ?? 0) + 1;
		this.#linkGeneration.set(tabId, next);
		return next;
	}
}
