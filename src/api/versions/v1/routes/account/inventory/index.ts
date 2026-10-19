import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../db";
import { type DrizzleDB } from "../../../../../../db/utils";
import { APIResponse } from "../../../../../utils/api-res";
import { AuthHandler } from "../../../../../utils/authHandler";
import { CatalogQueries, CatalogViews } from "../../../../../utils/catalogViews";
import { RateLimiter } from "../../../../../utils/rateLimiter";
import { RedeemCodeHandler } from "../../../../../utils/redeemCodes";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";
import { AccountInventoryModel } from "./model";

// Failed (and successful) redeem attempts per user — slows down guessing codes.
const redeemLimiter = new RateLimiter(10, 10 * 60 * 1000);

/**
 * Product views for their owners. Items that can't be used right now (draft, taken down, hidden
 * or unreviewed page) keep their name but carry no files — unpublished content stays private.
 */
async function ownedProductViews(products: DB.Models.Product[]) {
	const ids = products.map((product) => product.id);
	const available = new Set(
		(ids.length
			? await DB.instance()
					.select({ id: DB.Tables.products.id })
					.from(DB.Tables.products)
					.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, DB.Tables.products.page_id))
					.where(and(inArray(DB.Tables.products.id, ids), CatalogQueries.publicProduct()))
					.all()
			: []
		).map((row) => row.id),
	);

	return (await CatalogViews.products(products)).map((view) =>
		available.has(view.id)
			? { product: view, available: true }
			: { product: { ...view, texture: null, preview: null, variants: [] }, available: false },
	);
}

export const router = new Hono().basePath("/inventory");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List owned items",
		description:
			"Retrieve the exclusive products the authenticated user owns (from redeem codes or grants). Free products need no ownership and are not listed.",
		tags: [DOCS_TAGS.ACCOUNT_INVENTORY],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success(
				"Inventory retrieved successfully",
				AccountInventoryModel.GetAll.Response,
			),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		const rows = await DB.instance()
			.select({ item: DB.Tables.userItems, product: DB.Tables.products })
			.from(DB.Tables.userItems)
			.innerJoin(DB.Tables.products, eq(DB.Tables.products.id, DB.Tables.userItems.product_id))
			.where(eq(DB.Tables.userItems.user_id, authContext.user_id))
			.orderBy(desc(DB.Tables.userItems.created_at))
			.all();

		const views = await ownedProductViews(rows.map((row) => row.product));

		return APIResponse.success(
			c,
			"Inventory retrieved successfully",
			rows.map((row, index) => {
				const view = views[index] as (typeof views)[number];
				return {
					product: view.product,
					source: row.item.source,
					available: view.available,
					created_at: row.item.created_at,
				};
			}) satisfies AccountInventoryModel.GetAll.Response,
		);
	},
);

router.post(
	"/redeem",

	APIRouteSpec.authenticated({
		summary: "Redeem a code",
		description:
			"Redeem a code from an official or partner page and add its products to the inventory. Each code can be redeemed once per user. Limited to 10 attempts per 10 minutes.",
		tags: [DOCS_TAGS.ACCOUNT_INVENTORY],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Code redeemed successfully", AccountInventoryModel.Redeem.Response),
			APIResponseSpec.badRequest("Invalid or expired code / Syntax or validation error in request"),
			APIResponseSpec.conflict("You have already redeemed this code"),
			APIResponseSpec.tooManyRequests("Too many redeem attempts. Try again later."),
		),
	}),

	zValidator("json", AccountInventoryModel.Redeem.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		const limit = redeemLimiter.hit(String(authContext.user_id));
		if (!limit.allowed) {
			c.header("Retry-After", limit.retryAfterSeconds.toString());
			return APIResponse.tooManyRequests(c, "Too many redeem attempts. Try again later.");
		}

		const { code } = c.req.valid("json");

		const result = await DB.instance().transaction(async (tx: DrizzleDB) => {
			return await RedeemCodeHandler.redeem(authContext.user_id, code, tx);
		});

		if (!result.ok) {
			return result.code === 409
				? APIResponse.conflict(c, result.message)
				: APIResponse.badRequest(c, result.message);
		}

		return APIResponse.success(c, "Code redeemed successfully", {
			products: (await ownedProductViews(result.products)).map((view) => view.product),
			granted_product_ids: result.granted_product_ids,
		} satisfies AccountInventoryModel.Redeem.Response);
	},
);
