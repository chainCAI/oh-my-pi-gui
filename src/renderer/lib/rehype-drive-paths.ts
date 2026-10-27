/**
 * Keeps a Windows drive path usable as a link or image address. Sanitize and
 * react-markdown read the `E:` of `E:\src\a.ts` as a URL scheme they do not
 * allow and drop the address, so a reply's `[a.ts](E:\src\a.ts)` rendered as a
 * dead link. Written as a file URL it passes both, and the main process reads
 * the `/E:\src\a.ts` that file URL leaves as the drive path.
 */
interface HastNode {
	type: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
}

// Markdown percent-encodes a backslash in a link destination (`%5C`); raw HTML keeps it.
const DRIVE_PATH = /^[A-Za-z]:(?:[\\/]|%5C)/i;
const ADDRESS_PROPERTY: Record<string, string> = { a: "href", img: "src" };

function rewrite(node: HastNode): void {
	const key = node.tagName ? ADDRESS_PROPERTY[node.tagName] : undefined;
	const value = key ? node.properties?.[key] : undefined;
	if (key && node.properties && typeof value === "string" && DRIVE_PATH.test(value)) {
		node.properties[key] = `file:///${value}`;
	}
	for (const child of node.children ?? []) rewrite(child);
}

export function rehypeDrivePaths(): (tree: HastNode) => void {
	return rewrite;
}
