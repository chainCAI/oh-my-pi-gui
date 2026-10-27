/**
 * Contracts for resolving paths named in replies and tool output. The renderer
 * turns a path into a link only when this says it exists, and its menu offers
 * the relative path only when this returns one, so a wrong answer is either a
 * dead link or a path the user cannot paste back into the workspace.
 */
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveExistingPath } from "./workspace-paths";

let root: string;
let workspace: string;

beforeAll(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-paths-")));
	workspace = path.join(root, "work");
	await fs.mkdir(path.join(workspace, "src"), { recursive: true });
	await fs.writeFile(path.join(workspace, "src", "app.ts"), "export {};\n");
	await fs.writeFile(path.join(root, "outside.txt"), "outside\n");
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("resolveExistingPath", () => {
	it("resolves a relative path inside the workspace with its kind and relative form", async () => {
		expect(await resolveExistingPath("src/app.ts", workspace)).toEqual({
			absolutePath: path.join(workspace, "src", "app.ts"),
			kind: "file",
			relativePath: path.join("src", "app.ts"),
		});
		expect(await resolveExistingPath("./src", `${workspace}${path.sep}`)).toEqual({
			absolutePath: path.join(workspace, "src"),
			kind: "directory",
			relativePath: "src",
		});
	});

	it("never links a relative path that climbs out of the workspace, even when it exists", async () => {
		expect(await resolveExistingPath("../outside.txt", workspace)).toBeNull();
		expect(await resolveExistingPath("src/app.ts", null)).toBeNull();
	});

	it("resolves absolute paths anywhere, offering a relative form only inside the workspace", async () => {
		expect(await resolveExistingPath(path.join(root, "outside.txt"), workspace)).toEqual({
			absolutePath: path.join(root, "outside.txt"),
			kind: "file",
		});
		expect(await resolveExistingPath(path.join(workspace, "src", "..", "src", "app.ts"), workspace)).toMatchObject({
			absolutePath: path.join(workspace, "src", "app.ts"),
			relativePath: path.join("src", "app.ts"),
		});
	});

	it("expands ~/ to the home directory", async () => {
		vi.spyOn(os, "homedir").mockReturnValue(root);
		expect(await resolveExistingPath("~/outside.txt", workspace)).toMatchObject({
			absolutePath: path.join(root, "outside.txt"),
			kind: "file",
		});
	});

	it("answers null for missing paths and non-strings", async () => {
		expect(await resolveExistingPath("src/missing.ts", workspace)).toBeNull();
		expect(await resolveExistingPath(path.join(root, "missing.txt"), workspace)).toBeNull();
		expect(await resolveExistingPath("  ", workspace)).toBeNull();
		expect(await resolveExistingPath(42, workspace)).toBeNull();
	});
});
