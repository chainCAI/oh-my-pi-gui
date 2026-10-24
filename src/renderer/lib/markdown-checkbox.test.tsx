/**
 * Contract tests for GFM task-list checkboxes in the markdown renderer
 * (plan/17 §7.1): the feature renders, and the two-layer hardening (sanitize
 * attribute-value pin + forced readonly component) keeps raw-HTML inputs in
 * model output from becoming interactive controls.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import { MarkdownRenderer } from "./markdown";

function render(content: string): string {
	return renderToStaticMarkup(
		<I18nProvider>
			<MarkdownRenderer content={content} />
		</I18nProvider>,
	);
}

describe("task-list checkboxes", () => {
	it("renders GFM checked/unchecked items as disabled checkboxes", () => {
		const html = render("- [x] done\n- [ ] pending");
		const inputs = html.match(/<input[^>]*>/g) ?? [];
		expect(inputs).toHaveLength(2);
		expect(inputs[0]).toContain('type="checkbox"');
		expect(inputs[0]).toContain("checked");
		expect(inputs[0]).toContain("disabled");
		expect(inputs[1]).toContain('type="checkbox"');
		expect(inputs[1]).not.toContain("checked");
		expect(inputs[1]).toContain("disabled");
	});

	it("forces readonly even if the raw HTML claims otherwise", () => {
		const html = render('<input type="checkbox">');
		expect(html).toContain("disabled");
		expect(html).toContain('tabindex="-1"');
	});

	it("neutralizes type confusion from raw HTML — password", () => {
		const html = render('<input type="password" value="secret">');
		expect(html).not.toContain('type="password"');
		expect(html).not.toContain('value="secret"');
		expect(html).toContain('type="checkbox"');
		expect(html).toContain("disabled");
	});

	it("neutralizes type confusion from raw HTML — file", () => {
		const html = render('<input type="file" name="upload">');
		expect(html).not.toContain('type="file"');
		expect(html).not.toContain("name=");
		expect(html).toContain('type="checkbox"');
		expect(html).toContain("disabled");
	});

	it("neutralizes type confusion from raw HTML — text with handlers", () => {
		const html = render('<input type="text" value="x" onfocus="alert(1)">');
		expect(html).not.toContain('type="text"');
		expect(html).not.toContain("onfocus");
		expect(html).not.toContain("alert");
		expect(html).toContain('type="checkbox"');
		expect(html).toContain("disabled");
	});

	it("gives a checkbox item no bullet while a plain item keeps one", () => {
		const html = render('- [x] done\n- plain\n\n<ul><li class="fixed inset-0">raw</li></ul>');
		const items = html.match(/<li[^>]*>/g) ?? [];
		expect(items).toHaveLength(3);
		expect(items[0]).toContain("list-none");
		expect(items[1]).toContain("ml-4");
		// Only GFM's own marker class gets through; raw HTML cannot style an item.
		expect(items[2]).not.toContain("fixed");
		expect(items[2]).toContain("ml-4");
	});
});
