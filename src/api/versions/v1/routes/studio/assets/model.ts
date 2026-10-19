import { z } from "zod";
import { AssetSettings } from "../../../../../utils/shared-models/catalogData";
import { SharedViews } from "../../../../../utils/shared-models/views";

export namespace StudioAssetsModel.Upload {
	export const Body = z.object({
		file: z.file().describe("PNG image, or the model .cfg (JSON) for `cosmetic_model`"),
		kind: AssetSettings.Kind.describe(
			"`cape_texture`: PNG 2:1, width a multiple of 64 (max 2048×1024) · `cosmetic_texture`: PNG up to 1024×1024 · `cosmetic_model`: OptiFine PlayerItem JSON (Blockbench export) up to 256 KB · `image`: PNG up to 2048×2048 (icons, banners, previews). Images up to 2 MB.",
		),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = z.object({
		asset: SharedViews.AssetRef.extend({
			mime_type: AssetSettings.MimeType,
			size: z.number().int(),
			width: z.number().int().nullable(),
			height: z.number().int().nullable(),
		}),
		warnings: z.array(z.string()).describe("Non-fatal findings, e.g. renderer differences"),
	});
	export type Response = z.infer<typeof Response>;
}
