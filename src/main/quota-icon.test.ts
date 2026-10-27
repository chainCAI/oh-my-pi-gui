/**
 * The tray quota ring's pixels and PNG bytes. A wrong sweep shows the wrong
 * share beside a provider; a malformed PNG leaves the row without a ring on
 * every platform.
 */
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng, type Rgba, ringPixels } from "./quota-icon";

const RED: Rgba = [200, 40, 40, 1];
const TRACK: Rgba = [0, 0, 0, 0.16];
const SIZE = 32;

function pixel(pixels: Uint8Array, x: number, y: number): number[] {
	const index = (y * SIZE + x) * 4;
	return [...pixels.subarray(index, index + 4)];
}

describe("ringPixels", () => {
	it("sweeps the used share clockwise from twelve o'clock over a faint track", () => {
		const half = ringPixels(SIZE, 0.5, RED, TRACK);
		const track = [0, 0, 0, Math.round(0.16 * 255)];
		expect(pixel(half, 27, 16)).toEqual([...RED.slice(0, 3), 255]); // three o'clock: used
		expect(pixel(half, 4, 16)).toEqual(track); // nine o'clock: not yet
		expect(pixel(half, 16, 16)[3]).toBe(0); // the middle stays clear
		expect(pixel(ringPixels(SIZE, 0.2, RED, TRACK), 27, 16)).toEqual(track);
	});
});

describe("encodePng", () => {
	it("writes an RGBA PNG whose image data inflates back to the pixels", () => {
		const pixels = ringPixels(SIZE, 0.7, RED, TRACK);
		const png = encodePng(SIZE, SIZE, pixels);
		expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(png.toString("ascii", 12, 16)).toBe("IHDR");
		expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([SIZE, SIZE, 8, 6]);
		const idatLength = png.readUInt32BE(33);
		expect(png.toString("ascii", 37, 41)).toBe("IDAT");
		const scanlines = inflateSync(png.subarray(41, 41 + idatLength));
		const rows = Array.from({ length: SIZE }, (_, y) =>
			scanlines.subarray(y * (SIZE * 4 + 1) + 1, (y + 1) * (SIZE * 4 + 1)),
		);
		expect(Buffer.concat(rows).equals(Buffer.from(pixels))).toBe(true);
		expect(png.toString("ascii", png.length - 8, png.length - 4)).toBe("IEND");
	});
});
