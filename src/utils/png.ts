/**
 * Minimal structural PNG validation without decoding pixels: signature, chunk layout, CRC32 of
 * every chunk, a well-formed IHDR, at least one IDAT and a final IEND with nothing after it.
 * Good enough to reject non-PNGs and truncated or tampered files before they are served to
 * clients (the mod uploads them to the GPU as-is).
 */
export class PNGInfo {
	static readonly SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

	static readonly MAX_DIMENSION = 16384;
	static readonly MAX_CHUNKS = 4096;

	/** Returns the image header, or an error message if the bytes are not a valid PNG. */
	static parse(bytes: Uint8Array): PNGInfo.Result {
		if (bytes.length < PNGInfo.SIGNATURE.length + 12 * 3) {
			return { ok: false, error: "File is too small to be a PNG image" };
		}

		for (let i = 0; i < PNGInfo.SIGNATURE.length; i++) {
			if (bytes[i] !== PNGInfo.SIGNATURE[i]) {
				return { ok: false, error: "File is not a PNG image" };
			}
		}

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

		let offset = PNGInfo.SIGNATURE.length;
		let header: PNGInfo.Header | null = null;
		let hasPalette = false;
		let hasImageData = false;
		let chunkCount = 0;

		while (offset < bytes.length) {
			if (++chunkCount > PNGInfo.MAX_CHUNKS) {
				return { ok: false, error: "PNG image has too many chunks" };
			}

			if (offset + 12 > bytes.length) {
				return { ok: false, error: "PNG image is truncated" };
			}

			const length = view.getUint32(offset);
			const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
			const dataStart = offset + 8;
			const dataEnd = dataStart + length;

			if (dataEnd + 4 > bytes.length) {
				return { ok: false, error: "PNG image is truncated" };
			}

			const expectedCRC = view.getUint32(dataEnd);
			if (Bun.hash.crc32(bytes.subarray(offset + 4, dataEnd)) !== expectedCRC) {
				return { ok: false, error: `PNG chunk ${type} has an invalid checksum` };
			}

			if (header === null && type !== "IHDR") {
				return { ok: false, error: "PNG image does not start with an IHDR chunk" };
			}

			switch (type) {
				case "IHDR": {
					if (header !== null || length !== 13) {
						return { ok: false, error: "PNG image has an invalid IHDR chunk" };
					}
					header = {
						width: view.getUint32(dataStart),
						height: view.getUint32(dataStart + 4),
						bitDepth: view.getUint8(dataStart + 8),
						colorType: view.getUint8(dataStart + 9),
						interlaced: view.getUint8(dataStart + 12) === 1,
					};
					const compression = view.getUint8(dataStart + 10);
					const filter = view.getUint8(dataStart + 11);
					const interlace = view.getUint8(dataStart + 12);
					if (!PNGInfo.isValidHeader(header) || compression !== 0 || filter !== 0 || interlace > 1) {
						return { ok: false, error: "PNG image has an invalid IHDR chunk" };
					}
					break;
				}
				case "PLTE":
					hasPalette = true;
					break;
				case "IDAT":
					hasImageData = true;
					break;
				case "IEND": {
					if (length !== 0 || dataEnd + 4 !== bytes.length) {
						return { ok: false, error: "PNG image has data after the IEND chunk" };
					}
					if (!hasImageData) {
						return { ok: false, error: "PNG image has no image data" };
					}
					if (header?.colorType === 3 && !hasPalette) {
						return { ok: false, error: "Indexed PNG image has no palette" };
					}
					return { ok: true, header: header as PNGInfo.Header };
				}
			}

			offset = dataEnd + 4;
		}

		return { ok: false, error: "PNG image is truncated (missing IEND chunk)" };
	}

	private static isValidHeader(header: PNGInfo.Header) {
		const validDepths: Record<number, number[]> = {
			0: [1, 2, 4, 8, 16],
			2: [8, 16],
			3: [1, 2, 4, 8],
			4: [8, 16],
			6: [8, 16],
		};

		return (
			header.width > 0 &&
			header.height > 0 &&
			header.width <= PNGInfo.MAX_DIMENSION &&
			header.height <= PNGInfo.MAX_DIMENSION &&
			(validDepths[header.colorType]?.includes(header.bitDepth) ?? false)
		);
	}
}

export namespace PNGInfo {
	export interface Header {
		width: number;
		height: number;
		bitDepth: number;
		colorType: number;
		interlaced: boolean;
	}

	export type Result = { ok: true; header: Header } | { ok: false; error: string };
}
