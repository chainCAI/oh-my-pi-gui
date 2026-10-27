/**
 * Contracts for web addresses in captured terminal output: a dev server's
 * "Local: http://localhost:5173/" must be a link the user can open or copy,
 * whether the output is plain or colored, and the text around it must survive.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnsiText, OutputText } from "./ansi";
import { I18nProvider } from "./i18n";

function render(text: string, Component: typeof AnsiText = AnsiText): string {
	return renderToStaticMarkup(
		<I18nProvider>
			<Component text={text} />
		</I18nProvider>,
	);
}

function anchors(html: string): Array<{ href: string; text: string }> {
	return [...html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(match => ({
		href: match[1] ?? "",
		text: match[2] ?? "",
	}));
}

function visibleText(html: string): string {
	return html.replace(/<[^>]+>/g, "");
}

describe("AnsiText web addresses", () => {
	it("links a bare address in plain output and keeps the surrounding text", () => {
		const html = render("  ➜  Local:   http://localhost:5173/\n  ➜  press h for help");
		expect(anchors(html)).toEqual([{ href: "http://localhost:5173/", text: "http://localhost:5173/" }]);
		expect(visibleText(html)).toBe("  ➜  Local:   http://localhost:5173/\n  ➜  press h for help");
	});

	it("links an address inside colored output", () => {
		const html = render("\x1b[36mready\x1b[0m at \x1b[1mhttps://example.com/app\x1b[0m.");
		expect(anchors(html)).toEqual([{ href: "https://example.com/app", text: "https://example.com/app" }]);
		expect(visibleText(html)).toBe("ready at https://example.com/app.");
	});
});

describe("OutputText", () => {
	it("shows long plain output whole, with its address linked", () => {
		// Tool cards showed plain output as raw text; routing it through the
		// colored path would tail-clip it at 20k characters.
		const output = `${"build line\n".repeat(2_500)}  Local:   http://localhost:5173/\n`;
		const html = render(output, OutputText);
		expect(anchors(html)).toEqual([{ href: "http://localhost:5173/", text: "http://localhost:5173/" }]);
		expect(visibleText(html)).toBe(output);
	});
});
