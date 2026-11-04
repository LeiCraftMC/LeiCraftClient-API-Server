import { z } from "zod";
import { ReleaseDataPolicies, ReleaseViews } from "../../../../utils/shared-models/releaseData";

export namespace ReleasesModel.GetAll {
	export const Query = z.object({
		order: z.enum(["newest", "oldest"]).default("newest"),
		limit: z.coerce.number().int().min(1).max(100).default(10),
		offset: z.coerce.number().int().min(0).default(0),
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(ReleaseViews.PublicRelease);
	export type Response = z.infer<typeof Response>;
}

export namespace ReleasesModel.GetLatest {
	export const Response = ReleaseViews.PublicRelease;
	export type Response = z.infer<typeof Response>;
}

export namespace ReleasesModel.GetByVersion {
	export const Params = z.object({
		version: ReleaseDataPolicies.Version,
	});
	export type Params = z.infer<typeof Params>;

	export const Response = ReleaseViews.PublicRelease;
	export type Response = z.infer<typeof Response>;
}
