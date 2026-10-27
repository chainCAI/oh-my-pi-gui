/**
 * The ring beside each tray quota row: a faint track with the used share drawn
 * clockwise from twelve o'clock. Encoded as PNG so every platform reads the
 * same straight RGBA bytes; Electron's raw bitmaps are platform-dependent.
 */

import { crc32, deflateSync } from "node:zlib";

/** Red, green, blue (0–255) and opacity (0–1). */
export type Rgba = readonly [number, number, number, number];

/** Edge samples per pixel side; 4×4 keeps the ring smooth at menu size. */
const SAMPLES = 4;

/** Straight RGBA pixels of a ring `size` pixels across. */
export function ringPixels(size: number, fraction: number, arc: Rgba, track: Rgba): Uint8Array {
	const pixels = new Uint8Array(size * size * 4);
	const center = size / 2;
	const outer = size / 2 - size / 16;
	const inner = outer - size * 0.17;
	const sweep = Math.min(1, Math.max(0, fraction)) * Math.PI * 2;
	const total = SAMPLES * SAMPLES;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let arcHits = 0;
			let trackHits = 0;
			for (let sy = 0; sy < SAMPLES; sy++) {
				for (let sx = 0; sx < SAMPLES; sx++) {
					const dx = x + (sx + 0.5) / SAMPLES - center;
					const dy = y + (sy + 0.5) / SAMPLES - center;
					const radius = Math.hypot(dx, dy);
					if (radius < inner || radius > outer) continue;
					let angle = Math.atan2(dx, -dy);
					if (angle < 0) angle += Math.PI * 2;
					if (angle < sweep) arcHits++;
					else trackHits++;
				}
			}
			const arcAlpha = (arcHits / total) * arc[3];
			const trackAlpha = (trackHits / total) * track[3];
			const alpha = arcAlpha + trackAlpha;
			if (alpha === 0) continue;
			const index = (y * size + x) * 4;
			for (let channel = 0; channel < 3; channel++) {
				pixels[index + channel] = Math.round((arc[channel] * arcAlpha + track[channel] * trackAlpha) / alpha);
			}
			pixels[index + 3] = Math.round(alpha * 255);
		}
	}
	return pixels;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
	return Buffer.concat([head, data, crc]);
}

/** An 8-bit RGBA PNG of `rgba` pixels. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
	const stride = width * 4;
	const scanlines = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		// Filter byte 0 (none), then the row.
		scanlines.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // color type: RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(scanlines)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}
