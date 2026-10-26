/**
 * Launch-argument decoding for the first launch and a refused second instance
 * (`omp <dir>`, `open -n omp --args …`), and Windows/Linux protocol handoff.
 * Contract: a deep link always wins, the first real directory is the workspace
 * to open, flags never masquerade as one, and anything else only raises the
 * running app.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { launchFolder, parseLaunchArgv } from "./launch-argv";

const directories = new Set(["/workspace/app", "/Applications/omp.app"]);
const exists = (path: string): boolean => directories.has(path);

describe("parseLaunchArgv", () => {
	it("prefers the deep link over a directory in the same argv", () => {
		expect(parseLaunchArgv(["/Applications/omp.app", "omp://session/abc", "/workspace/app"], "omp", exists)).toEqual({
			kind: "url",
			url: "omp://session/abc",
		});
	});

	it("opens the first argument naming a real directory", () => {
		expect(parseLaunchArgv(["electron-bin", "/workspace/app", "/nope"], "omp", exists)).toEqual({
			kind: "path",
			path: "/workspace/app",
		});
	});

	it("skips Electron's own switches instead of treating them as paths", () => {
		expect(parseLaunchArgv(["--class=App", "--no-sandbox", "/workspace/app"], "omp", exists)).toEqual({
			kind: "path",
			path: "/workspace/app",
		});
		expect(parseLaunchArgv(["--flag", "./relative", "/missing"], "omp", exists)).toEqual({ kind: "focus" });
	});

	it("only asks for focus when nothing names a link or a workspace", () => {
		expect(parseLaunchArgv(["/tmp/not-a-directory"], "omp", () => false)).toEqual({ kind: "focus" });
	});
});

describe("launchFolder", () => {
	const exe = "/Applications/omp.app/Contents/MacOS/omp";

	it.each([
		// A packaged app has no argv[2] here, so the folder used to be ignored.
		["a packaged launch", [exe, "/workspace/app"], false],
		[
			"a packaged launch behind Chromium's switches",
			[exe, "--inspect=0", "--remote-debugging-port=0", "/workspace/app"],
			false,
		],
		["a dev launch, past Electron's app directory", ["electron", "/Applications/omp.app", "/workspace/app"], true],
	] as const)("opens the folder given to %s", (_name, argv, defaultApp) => {
		expect(launchFolder(argv, defaultApp, "omp", exists)).toBe("/workspace/app");
	});

	it("never mistakes the dev app directory for a workspace", () => {
		expect(launchFolder(["electron", "/Applications/omp.app"], true, "omp", exists)).toBeUndefined();
	});

	it("makes a relative folder absolute so later launches find its window", () => {
		expect(launchFolder([exe, "app"], false, "omp", arg => arg === "app")).toBe(path.resolve("app"));
	});

	it("opens no folder when the launch carries a deep link", () => {
		expect(launchFolder([exe, "omp://new", "/workspace/app"], false, "omp", exists)).toBeUndefined();
	});
});
