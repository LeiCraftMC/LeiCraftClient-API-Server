import { mkdir as fs_mkdir, rm as fs_rm } from "node:fs/promises";
import { join as path_join, resolve as path_resolve } from "node:path";
import { and, eq, inArray, lt, ne, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import { Logger } from "../../utils/logger";
import { PNGInfo } from "../../utils/png";
import type { AssetSettings } from "./shared-models/catalogData";

/**
 * Content-addressed file storage for uploaded textures, models and images.
 *
 * The asset id is the SHA-256 of the stored bytes, so identical uploads share one file and the
 * public URL `/assets/<id>.<png|json>` never changes its content — clients may cache it forever.
 * Files live at `<ASSETS_DIR>/<id[0..2]>/<id>`.
 */
export class AssetStore {
	protected static dir: string | null = null;
	protected static publicBaseURL = "";

	static async init(dir: string, apiPublicURL: string) {
		this.dir = path_resolve(dir);
		this.publicBaseURL = apiPublicURL.replace(/\/+$/, "");
		await fs_mkdir(this.dir, { recursive: true });
	}

	protected static getDir() {
		if (!this.dir) {
			throw new Error("AssetStore not initialized. Call AssetStore.init() first.");
		}
		return this.dir;
	}

	static getFilePath(assetID: string) {
		return path_join(this.getDir(), assetID.slice(0, 2), assetID);
	}

	static getExtension(mimeType: AssetSettings.MimeType) {
		return mimeType === "application/json" ? "json" : "png";
	}

	static getURL(assetID: string, extension: "png" | "json") {
		return `${this.publicBaseURL}/assets/${assetID}.${extension}`;
	}

	/**
	 * Serializes `store` and `cleanupOrphans` per asset id, so a cleanup can't delete a file that
	 * is being uploaded again at the same moment (single process — the SQLite deployment).
	 */
	protected static readonly locks = new Map<string, Promise<unknown>>();

	protected static async withLock<T>(assetID: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(assetID) ?? Promise.resolve();
		const run = previous.then(fn, fn);
		const tail = run.catch(() => {});
		this.locks.set(assetID, tail);
		try {
			return await run;
		} finally {
			if (this.locks.get(assetID) === tail) {
				this.locks.delete(assetID);
			}
		}
	}

	/**
	 * Stores validated bytes (see {@link AssetValidator.validate}) and returns the asset row.
	 * Uploading existing bytes again restarts the asset's cleanup grace period.
	 */
	static async store(
		validated: AssetValidator.ValidAsset,
		uploadedByUserID: number | null,
		tx: DrizzleDB = DB.instance(),
	) {
		const id = new Bun.CryptoHasher("sha256").update(validated.bytes).digest("hex");

		return await this.withLock(id, async () => {
			const asset = await tx
				.insert(DB.Tables.assets)
				.values({
					id,
					mime_type: validated.mimeType,
					size: validated.bytes.byteLength,
					width: validated.width,
					height: validated.height,
					uploaded_by_user_id: uploadedByUserID,
				})
				.onConflictDoUpdate({ target: DB.Tables.assets.id, set: { created_at: Date.now() } })
				.returning()
				.get();

			const filePath = this.getFilePath(id);
			if (!(await Bun.file(filePath).exists())) {
				await Bun.write(filePath, validated.bytes, { createPath: true });
			}

			return asset;
		});
	}

	static async get(assetID: string, tx: DrizzleDB = DB.instance()) {
		return await tx.select().from(DB.Tables.assets).where(eq(DB.Tables.assets.id, assetID)).get();
	}

	/**
	 * Checks that every referenced asset exists and fits its intended kind.
	 * Returns an error message for the first invalid reference, or null.
	 */
	static async checkReferences(
		references: Array<{
			field: string;
			assetID: string | null | undefined;
			kind: AssetSettings.Kind;
		}>,
		tx: DrizzleDB = DB.instance(),
	) {
		const ids = references.map((ref) => ref.assetID).filter((id): id is string => !!id);
		if (ids.length === 0) {
			return null;
		}

		const rows = await tx
			.select()
			.from(DB.Tables.assets)
			.where(inArray(DB.Tables.assets.id, ids))
			.all();
		const byID = new Map(rows.map((row) => [row.id, row]));

		for (const ref of references) {
			if (!ref.assetID) continue;

			const asset = byID.get(ref.assetID);
			if (!asset) {
				return `${ref.field}: asset not found`;
			}

			const problem = AssetValidator.checkKind(asset, ref.kind);
			if (problem) {
				return `${ref.field}: ${problem}`;
			}
		}

		return null;
	}

	/**
	 * Files of exclusive products belong to their page: another page can't reuse them (also not by
	 * uploading the same bytes again, which yields the same asset id). Returns a message or null.
	 */
	static async checkExclusiveUse(
		references: Array<{ field: string; assetID: string | null | undefined }>,
		pageID: number,
		tx: DrizzleDB = DB.instance(),
	) {
		const ids = references.map((ref) => ref.assetID).filter((id): id is string => !!id);
		if (ids.length === 0) {
			return null;
		}

		const products = DB.Tables.products;
		const variants = DB.Tables.productVariants;
		const exclusiveElsewhere = and(
			eq(products.availability, "exclusive"),
			ne(products.page_id, pageID),
		);

		const capeUses = await tx
			.select({ asset_id: products.texture_asset_id })
			.from(products)
			.where(and(exclusiveElsewhere, inArray(products.texture_asset_id, ids)))
			.all();

		const variantUses = await tx
			.select({ model: variants.model_asset_id, texture: variants.texture_asset_id })
			.from(variants)
			.innerJoin(products, eq(products.id, variants.product_id))
			.where(
				and(
					exclusiveElsewhere,
					or(inArray(variants.model_asset_id, ids), inArray(variants.texture_asset_id, ids)),
				),
			)
			.all();

		const taken = new Set<string>([
			...capeUses.flatMap((use) => (use.asset_id ? [use.asset_id] : [])),
			...variantUses.flatMap((use) => [use.model, use.texture]),
		]);

		const conflict = references.find((ref) => ref.assetID && taken.has(ref.assetID));
		return conflict
			? `${conflict.field}: this file belongs to an exclusive product of another page`
			: null;
	}

	/** Whether nothing references the asset (also not a pending community profile change). */
	protected static unreferenced(tx: DrizzleDB) {
		const assetID = DB.Tables.assets.id;
		return and(
			notExists(
				tx
					.select({ id: DB.Tables.products.id })
					.from(DB.Tables.products)
					.where(
						or(
							eq(DB.Tables.products.texture_asset_id, assetID),
							eq(DB.Tables.products.preview_asset_id, assetID),
						),
					),
			),
			notExists(
				tx
					.select({ id: DB.Tables.productVariants.id })
					.from(DB.Tables.productVariants)
					.where(
						or(
							eq(DB.Tables.productVariants.model_asset_id, assetID),
							eq(DB.Tables.productVariants.texture_asset_id, assetID),
						),
					),
			),
			notExists(
				tx
					.select({ id: DB.Tables.pages.id })
					.from(DB.Tables.pages)
					.where(
						or(
							eq(DB.Tables.pages.icon_asset_id, assetID),
							eq(DB.Tables.pages.banner_asset_id, assetID),
							sql`json_extract(${DB.Tables.pages.pending_changes}, '$.icon_asset_id') = ${assetID}`,
							sql`json_extract(${DB.Tables.pages.pending_changes}, '$.banner_asset_id') = ${assetID}`,
						),
					),
			),
			notExists(
				tx
					.select({ id: DB.Tables.collections.id })
					.from(DB.Tables.collections)
					.where(
						or(
							eq(DB.Tables.collections.preview_asset_id, assetID),
							sql`json_extract(${DB.Tables.collections.pending_changes}, '$.preview_asset_id') = ${assetID}`,
						),
					),
			),
		);
	}

	/** Deletes assets older than `olderThanMs` that nothing references any more. */
	static async cleanupOrphans(olderThanMs: number, tx: DrizzleDB = DB.instance()) {
		const cutoff = Date.now() - olderThanMs;

		const candidates = await tx
			.select({ id: DB.Tables.assets.id })
			.from(DB.Tables.assets)
			.where(and(lt(DB.Tables.assets.created_at, cutoff), this.unreferenced(tx)))
			.all();

		let deleted = 0;
		for (const { id } of candidates) {
			await this.withLock(id, async () => {
				// Re-checked in the DELETE itself: the asset may have been uploaded again or referenced since.
				const removed = await tx
					.delete(DB.Tables.assets)
					.where(
						and(
							eq(DB.Tables.assets.id, id),
							lt(DB.Tables.assets.created_at, cutoff),
							this.unreferenced(tx),
						),
					)
					.returning()
					.all();
				if (removed.length === 0) {
					return;
				}

				deleted++;
				try {
					await fs_rm(this.getFilePath(id), { force: true });
				} catch (err) {
					Logger.warn(`Failed to delete asset file ${id}:`, err);
				}
			});
		}

		return deleted;
	}
}

/** Per-kind validation of uploaded files. */
export class AssetValidator {
	static readonly MAX_IMAGE_BYTES = 2 * 1024 * 1024;
	static readonly MAX_MODEL_BYTES = 256 * 1024;

	static readonly MAX_CAPE_WIDTH = 2048;
	static readonly MAX_COSMETIC_TEXTURE_SIZE = 1024;
	static readonly MAX_IMAGE_SIZE = 2048;

	static readonly MAX_MODEL_DEPTH = 16;
	static readonly MAX_MODEL_NODES = 512;
	static readonly MAX_MODEL_BOXES = 2048;

	static validate(kind: AssetSettings.Kind, bytes: Uint8Array): AssetValidator.Result {
		if (kind === "cosmetic_model") {
			return this.validateModel(bytes);
		}

		if (bytes.byteLength > this.MAX_IMAGE_BYTES) {
			return { ok: false, error: `Image must be at most ${this.MAX_IMAGE_BYTES / 1024 / 1024} MB` };
		}

		const png = PNGInfo.parse(bytes);
		if (!png.ok) {
			return { ok: false, error: png.error };
		}

		const asset = {
			mime_type: "image/png" as const,
			width: png.header.width,
			height: png.header.height,
		};

		const problem = this.checkKind(asset, kind);
		if (problem) {
			return { ok: false, error: problem };
		}

		return {
			ok: true,
			asset: {
				bytes,
				mimeType: asset.mime_type,
				width: asset.width,
				height: asset.height,
				warnings: [],
			},
		};
	}

	/** Checks stored metadata against a kind. Returns a problem description or null. */
	static checkKind(
		asset: Pick<DB.Models.Asset, "mime_type" | "width" | "height">,
		kind: AssetSettings.Kind,
	): string | null {
		if (kind === "cosmetic_model") {
			return asset.mime_type === "application/json" ? null : "expected a cosmetic model (.cfg JSON)";
		}

		if (asset.mime_type !== "image/png" || !asset.width || !asset.height) {
			return "expected a PNG image";
		}

		const { width, height } = asset;

		switch (kind) {
			case "cape_texture":
				if (width % 64 !== 0 || height * 2 !== width || width > this.MAX_CAPE_WIDTH) {
					return `cape textures must be 2:1 with a width that is a multiple of 64 (64×32 up to ${this.MAX_CAPE_WIDTH}×${this.MAX_CAPE_WIDTH / 2}), got ${width}×${height}`;
				}
				return null;
			case "cosmetic_texture":
				if (width > this.MAX_COSMETIC_TEXTURE_SIZE || height > this.MAX_COSMETIC_TEXTURE_SIZE) {
					return `cosmetic textures must be at most ${this.MAX_COSMETIC_TEXTURE_SIZE}×${this.MAX_COSMETIC_TEXTURE_SIZE}, got ${width}×${height}`;
				}
				return null;
			case "image":
				if (width > this.MAX_IMAGE_SIZE || height > this.MAX_IMAGE_SIZE) {
					return `images must be at most ${this.MAX_IMAGE_SIZE}×${this.MAX_IMAGE_SIZE}, got ${width}×${height}`;
				}
				return null;
		}
	}

	/**
	 * Validates an OptiFine "PlayerItem" model (the `.cfg` Blockbench exports) against the subset
	 * both renderers (Fabric mod + SkinViewerJS) understand and re-serializes only the known keys,
	 * minified. Anything else — a model-level `texture` path, `sprites`, custom keys — is dropped:
	 * textures are separate assets in V2, and no URL from an upload reaches the players.
	 */
	protected static validateModel(bytes: Uint8Array): AssetValidator.Result {
		if (bytes.byteLength > this.MAX_MODEL_BYTES) {
			return { ok: false, error: `Model must be at most ${this.MAX_MODEL_BYTES / 1024} KB` };
		}

		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			return { ok: false, error: "Model is not valid UTF-8" };
		}

		// Checked without recursion before anything recursive (JSON.parse, zod) touches the input.
		if (this.getJSONDepth(text) > this.MAX_JSON_DEPTH) {
			return { ok: false, error: `Model is nested too deeply (max ${this.MAX_MODEL_DEPTH} levels)` };
		}

		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return { ok: false, error: "Model is not valid JSON" };
		}

		const parsed = AssetValidator.PlayerItemModel.safeParse(json);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
			return { ok: false, error: `Invalid cosmetic model${path}: ${issue?.message}` };
		}

		const warnings: string[] = [];
		const counts = { nodes: 0, boxes: 0, maxDepth: 0 };

		const walk = (node: AssetValidator.ModelNode, depth: number, path: string) => {
			counts.nodes++;
			counts.maxDepth = Math.max(counts.maxDepth, depth);
			counts.boxes += node.boxes?.length ?? 0;

			if (node.invertAxis !== undefined && node.invertAxis !== "xy") {
				warnings.push(
					`${path} uses invertAxis "${node.invertAxis}" — the website preview may differ from the in-game look (Blockbench exports "xy")`,
				);
			}

			const children = [...(node.submodels ?? []), ...(node.submodel ? [node.submodel] : [])];
			children.forEach((child, index) => {
				walk(child, depth + 1, `${path}.${child.id ?? `submodel[${index}]`}`);
			});
		};

		parsed.data.models.forEach((root, index) => {
			walk(root, 1, root.id ?? `models[${index}]`);
		});

		if (counts.maxDepth > this.MAX_MODEL_DEPTH) {
			return { ok: false, error: `Model is nested too deeply (max ${this.MAX_MODEL_DEPTH} levels)` };
		}
		if (counts.nodes > this.MAX_MODEL_NODES) {
			return { ok: false, error: `Model has too many parts (max ${this.MAX_MODEL_NODES})` };
		}
		if (counts.boxes > this.MAX_MODEL_BOXES) {
			return { ok: false, error: `Model has too many boxes (max ${this.MAX_MODEL_BOXES})` };
		}

		if (json !== null && typeof json === "object" && "texture" in json) {
			warnings.push(
				'Removed the model-level "texture" path — upload the texture as a separate asset instead',
			);
		}
		if (text.includes('"sprites"')) {
			warnings.push('Removed "sprites", which neither renderer draws');
		}
		const removedKeys = this.findUnknownKeys(json, parsed.data);
		if (removedKeys.length > 0) {
			warnings.push(`Removed unsupported keys: ${removedKeys.join(", ")}`);
		}

		return {
			ok: true,
			asset: {
				bytes: new TextEncoder().encode(JSON.stringify(parsed.data)),
				mimeType: "application/json",
				width: null,
				height: null,
				warnings,
			},
		};
	}

	/** Max raw JSON nesting — far more than {@link MAX_MODEL_DEPTH} model levels need. */
	static readonly MAX_JSON_DEPTH = 64;

	/** Raw JSON nesting depth: one level per `{` / `[` outside strings. */
	static getJSONDepth(text: string) {
		let depth = 0;
		let maxDepth = 0;
		let inString = false;
		let escaped = false;

		for (const char of text) {
			if (inString) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') inString = false;
				continue;
			}
			if (char === '"') inString = true;
			else if (char === "{" || char === "[") maxDepth = Math.max(maxDepth, ++depth);
			else if (char === "}" || char === "]") depth--;
		}
		return maxDepth;
	}

	/** Keys of `input` the schema dropped (walks only what survived; depth is already bounded). */
	protected static findUnknownKeys(input: unknown, output: unknown, found = new Set<string>()) {
		if (Array.isArray(input) && Array.isArray(output)) {
			input.forEach((item, index) => {
				this.findUnknownKeys(item, output[index], found);
			});
		} else if (input && output && typeof input === "object" && typeof output === "object") {
			for (const key of Object.keys(input)) {
				if (key === "texture" || key === "sprites") continue;
				if (!(key in output)) {
					found.add(key);
				} else {
					this.findUnknownKeys((input as any)[key], (output as any)[key], found);
				}
			}
		}
		return [...found].sort();
	}
}

export namespace AssetValidator {
	export interface ValidAsset {
		bytes: Uint8Array;
		mimeType: AssetSettings.MimeType;
		width: number | null;
		height: number | null;
		warnings: string[];
	}

	export type Result = { ok: true; asset: ValidAsset } | { ok: false; error: string };

	export const AttachPoints = [
		"head",
		"body",
		"leftArm",
		"rightArm",
		"leftLeg",
		"rightLeg",
	] as const;

	const Vec2 = z.tuple([z.number(), z.number()]);
	const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
	const FaceUV = z.tuple([z.number(), z.number(), z.number(), z.number()]);

	const FaceKeys = ["uvNorth", "uvEast", "uvSouth", "uvWest", "uvUp", "uvDown"] as const;

	const Box = z
		.object({
			coordinates: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
			textureOffset: Vec2.optional(),
			uvNorth: FaceUV.optional(),
			uvEast: FaceUV.optional(),
			uvSouth: FaceUV.optional(),
			uvWest: FaceUV.optional(),
			uvUp: FaceUV.optional(),
			uvDown: FaceUV.optional(),
			sizeAdd: z.number().optional(),
			sizesAdd: Vec3.optional(),
		})
		.refine((box) => box.textureOffset || FaceKeys.every((key) => box[key]), {
			message:
				"every box needs either textureOffset or all six face UVs (uvNorth, uvEast, uvSouth, uvWest, uvUp, uvDown)",
		});

	const NodeFields = {
		id: z.string().max(64).optional(),
		type: z.string().max(32).optional(),
		invertAxis: z.string().max(3).optional(),
		translate: Vec3.optional(),
		rotate: Vec3.optional(),
		scale: z.union([z.number(), Vec3]).optional(),
		mirrorTexture: z.string().max(3).optional(),
		boxes: z.array(Box).optional(),
	};

	export type ModelNode = z.infer<z.ZodObject<typeof NodeFields>> & {
		submodels?: ModelNode[];
		submodel?: ModelNode;
	};

	const Node: z.ZodType<ModelNode> = z.object({
		...NodeFields,
		get submodels() {
			return z.array(Node).optional();
		},
		get submodel() {
			return Node.optional();
		},
	});

	/** Known keys only — `z.object` drops everything else from the stored model. */
	export const PlayerItemModel = z.object({
		type: z.literal("PlayerItem").optional(),
		credit: z.string().max(200).optional(),
		textureSize: z.tuple([z.number().int().positive(), z.number().int().positive()]),
		usePlayerTexture: z.boolean().optional(),
		models: z
			.array(
				z.object({
					...NodeFields,
					attachTo: z.enum(AttachPoints),
					submodels: z.array(Node).optional(),
					submodel: Node.optional(),
				}),
			)
			.min(1)
			.max(64),
	});
}
