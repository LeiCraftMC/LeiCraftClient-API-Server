import { inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../db";
import { APIResponse } from "../../../../utils/api-res";
import { LoadoutHandler } from "../../../../utils/loadouts";
import { MinecraftAccountHandler } from "../../../../utils/minecraftAccounts";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../docs";
import { PlayersModel } from "./model";

export const router = new Hono().basePath("/players");

router.post(
	"/lookup",

	APIRouteSpec.unauthenticated({
		summary: "Look up players",
		description:
			"Render-ready profiles (cape, cosmetics with all variants, LeiCraft Client usage) for up to 100 players in one request — what the mod calls for the players around it. Asset URLs are content-addressed and can be cached forever. Players without a profile are omitted.",
		tags: [DOCS_TAGS.PLAYERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Player profiles retrieved successfully", PlayersModel.Lookup.Response),
		),
	}),

	zValidator("json", PlayersModel.Lookup.Body),

	async (c) => {
		const { uuids, names } = c.req.valid("json");

		const byUUID = uuids.length
			? await DB.instance()
					.select()
					.from(DB.Tables.minecraftAccounts)
					.where(inArray(DB.Tables.minecraftAccounts.uuid, [...new Set(uuids)]))
					.all()
			: [];

		const lowerNames = [...new Set(names.map((name) => name.toLowerCase()))];
		const byNameRows = lowerNames.length
			? await DB.instance()
					.select()
					.from(DB.Tables.minecraftAccounts)
					.where(inArray(sql`lower(${DB.Tables.minecraftAccounts.name})`, lowerNames))
					.all()
			: [];

		// A name can be stored on several accounts after renames — keep the most recently verified one.
		const byName = new Map<string, DB.Models.MinecraftAccount>();
		for (const account of byNameRows) {
			const key = account.name.toLowerCase();
			const current = byName.get(key);
			if (!current || current.updated_at < account.updated_at) {
				byName.set(key, account);
			}
		}

		const accounts = new Map<number, DB.Models.MinecraftAccount>();
		for (const account of [...byUUID, ...byName.values()]) {
			accounts.set(account.id, account);
		}

		const profiles = await LoadoutHandler.getProfiles([...accounts.values()]);

		return APIResponse.success(c, "Player profiles retrieved successfully", profiles);
	},
);

router.get(
	"/showcase",

	APIRouteSpec.unauthenticated({
		summary: "Showcase players",
		description:
			"A few random players who wear a cape or cosmetics, for the website's landing page. Players who used the LeiCraft Client within the last 30 days come first. Same filtering as every public profile (banned users and items that can't show are left out).",
		tags: [DOCS_TAGS.PLAYERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Showcase retrieved successfully", PlayersModel.Showcase.Response),
		),
	}),

	zValidator("query", PlayersModel.Showcase.Query),

	async (c) => {
		const { limit } = c.req.valid("query");

		c.header("Cache-Control", "public, max-age=60");

		return APIResponse.success(
			c,
			"Showcase retrieved successfully",
			await LoadoutHandler.showcase(limit),
		);
	},
);

router.get(
	"/by-name/:name",

	APIRouteSpec.unauthenticated({
		summary: "Get player by name",
		description:
			"Profile of the Minecraft account that most recently verified with this name through the mod.",
		tags: [DOCS_TAGS.PLAYERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Player profile retrieved successfully",
				PlayersModel.GetByName.Response,
			),
			APIResponseSpec.notFound("Player not found"),
		),
	}),

	zValidator("param", PlayersModel.GetByName.Params),

	async (c) => {
		const { name } = c.req.valid("param");

		const account = await MinecraftAccountHandler.getByName(name);
		if (!account) {
			return APIResponse.notFound(c, "Player not found");
		}

		const [profile] = await LoadoutHandler.getProfiles([account]);

		return APIResponse.success(
			c,
			"Player profile retrieved successfully",
			profile as PlayersModel.GetByName.Response,
		);
	},
);

router.get(
	"/:uuid",

	APIRouteSpec.unauthenticated({
		summary: "Get player",
		description: "Render-ready profile of one player by Minecraft UUID.",
		tags: [DOCS_TAGS.PLAYERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Player profile retrieved successfully",
				PlayersModel.GetByUUID.Response,
			),
			APIResponseSpec.notFound("Player not found"),
		),
	}),

	zValidator("param", PlayersModel.GetByUUID.Params),

	async (c) => {
		const { uuid } = c.req.valid("param");

		const account = await MinecraftAccountHandler.getByUUID(uuid);
		if (!account) {
			return APIResponse.notFound(c, "Player not found");
		}

		const [profile] = await LoadoutHandler.getProfiles([account]);

		return APIResponse.success(
			c,
			"Player profile retrieved successfully",
			profile as PlayersModel.GetByUUID.Response,
		);
	},
);
