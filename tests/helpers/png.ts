import { deflateSync } from "node:zlib";

/** Encodes a solid-colour RGBA PNG — real files for upload and validation tests. */
export function createPNG(
	width: number,
	height: number,
	rgba: [number, number, number, number] = [255, 0, 0, 255],
) {
	const chunk = (type: string, data: Uint8Array) => {
		const out = new Uint8Array(12 + data.length);
		const view = new DataView(out.buffer);
		view.setUint32(0, data.length);
		out.set(new TextEncoder().encode(type), 4);
		out.set(data, 8);
		view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
		return out;
	};

	const header = new Uint8Array(13);
	const headerView = new DataView(header.buffer);
	headerView.setUint32(0, width);
	headerView.setUint32(4, height);
	header[8] = 8; // bit depth
	header[9] = 6; // colour type RGBA

	const row = new Uint8Array(1 + width * 4);
	for (let x = 0; x < width; x++) row.set(rgba, 1 + x * 4);
	const raw = new Uint8Array(row.length * height);
	for (let y = 0; y < height; y++) raw.set(row, y * row.length);

	const parts = [
		Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", new Uint8Array()),
	];

	const png = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		png.set(part, offset);
		offset += part.length;
	}
	return png;
}

/** A small valid OptiFine "PlayerItem" model (a hat). */
export function createModel(overrides: Record<string, unknown> = {}) {
	return {
		type: "PlayerItem",
		credit: "Made with Blockbench",
		textureSize: [64, 32],
		models: [
			{
				type: "ModelBox",
				attachTo: "head",
				invertAxis: "xy",
				translate: [0, 10, 0],
				boxes: [{ coordinates: [-4, 0, -4, 8, 2, 8], textureOffset: [0, 0] }],
				submodels: [
					{
						id: "top",
						invertAxis: "xy",
						translate: [0, 2, 0],
						boxes: [{ coordinates: [-2, 0, -2, 4, 3, 4], textureOffset: [0, 10] }],
					},
				],
			},
		],
		...overrides,
	};
}
