import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../../../db";
import { type DrizzleDB } from "../../../../../../../../db/utils";
import { APIResponse } from "../../../../../../../utils/api-res";
import { AuditLog } from "../../../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../../../utils/authHandler";
import { CatalogViews } from "../../../../../../../utils/catalogViews";
import { InventoryHandler } from "../../../../../../../utils/inventory";
import { APIResponseSpec, APIRouteSpec } from "../../../../../../../utils/specHelpers";
import { UserHandler } from "../../../../../../../utils/users";
import { DOCS_TAGS } from "../../../../../docs";
import { StudioPageContext } from "../../context";
import type { StudioProductVariables } from "..";
import { StudioProductsModel } from "../model";

async function ownerViews(
	items: DB.Models.UserItem[],
): Promise<StudioProductsModel.Owners.Owner[]> {
	const userIDs = [
		...new Set(
			items.flatMap((item) => [
				item.user_id,
				...(item.granted_by_user_id !== null ? [item.granted_by_user_id] : []),
			]),
		),
	];
	const users = userIDs.length
		? await DB.instance()
				.select()
				.from(DB.Tables.users)
				.where(inArray(DB.Tables.users.id, userIDs))
				.all()
		: [];
	const byID = new Map(users.map((user) => [user.id, user]));

	return items.flatMap((item) => {
		const user = byID.get(item.user_id);
		if (!user) return [];
		const grantedBy = item.granted_by_user_id ? byID.get(item.granted_by_user_id) : undefined;
		return [
			{
				user: CatalogViews.publicUser(user),
				source: item.source,
				note: item.note,
				granted_by: grantedBy ? CatalogViews.publicUser(grantedBy) : null,
				redeem_code_id: item.redeem_code_id,
				created_at: item.created_at,
			},
		];
	});
}

export const router = new Hono<{ Variables: StudioProductVariables }>().basePath(
	"/:productId/owners",
);

// Ownership only matters for exclusive products of official and partner pages.
router.use("*", async (c, next) => {
	const denied = StudioPageContext.deny(c, "manage_exclusives");
	if (denied) return denied;
	await next();
});

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List owners",
		description: "Users who own the product, and whether they got it from a redeem code or a grant.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Owners retrieved successfully", StudioProductsModel.Owners.Response),
			APIResponseSpec.forbidden("You are not allowed to manage redeem codes and grants of this page"),
			APIResponseSpec.notFound("Product not found"),
		),
	}),

	zValidator("query", StudioProductsModel.Owners.Query),

	async (c) => {
		const { limit, offset } = c.req.valid("query") as StudioProductsModel.Owners.Query;

		const items = await DB.instance()
			.select()
			.from(DB.Tables.userItems)
			.where(eq(DB.Tables.userItems.product_id, c.get("product").id))
			.orderBy(desc(DB.Tables.userItems.created_at))
			.limit(limit)
			.offset(offset)
			.all();

		return APIResponse.success(c, "Owners retrieved successfully", await ownerViews(items));
	},
);

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Grant product",
		description:
			"Give an exclusive product to a user — by LeiCraft user id, Discord id, or one of their linked Minecraft accounts (UUID or name). The user must have logged in once; for everyone else use redeem codes.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.created("Product granted successfully", StudioProductsModel.Grant.Response),
			APIResponseSpec.badRequest(
				"Only exclusive products can be granted / Syntax or validation error in request",
			),
			APIResponseSpec.forbidden("You are not allowed to manage redeem codes and grants of this page"),
			APIResponseSpec.notFound("Product or user not found"),
			APIResponseSpec.conflict("The user already owns this product / The Minecraft name is ambiguous"),
		),
	}),

	zValidator("json", StudioProductsModel.Grant.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const product = c.get("product");
		const { note, ...target } = c.req.valid("json");

		if (product.availability !== "exclusive") {
			return APIResponse.badRequest(c, "Only exclusive products can be granted");
		}

		const user = await UserHandler.resolveTarget(target);
		if (user === "ambiguous") {
			return APIResponse.conflict(
				c,
				"Several users have a Minecraft account with this name — use minecraft_uuid",
			);
		}
		if (!user) {
			return APIResponse.notFound(c, "User not found");
		}

		const item = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const granted = await InventoryHandler.grant(
				user.id,
				product.id,
				{ source: "grant", granted_by_user_id: authContext.user_id, note: note ?? null },
				tx,
			);
			if (!granted) {
				return null;
			}

			await AuditLog.record(
				{
					actor_user_id: authContext.user_id,
					action: "product.grant",
					target_type: "product",
					target_id: product.id,
					details: { user_id: user.id, note: note ?? null },
				},
				tx,
			);

			return await tx
				.select()
				.from(DB.Tables.userItems)
				.where(
					and(eq(DB.Tables.userItems.user_id, user.id), eq(DB.Tables.userItems.product_id, product.id)),
				)
				.get();
		});

		if (!item) {
			return APIResponse.conflict(c, "The user already owns this product");
		}

		const [view] = await ownerViews([item]);

		return APIResponse.created(
			c,
			"Product granted successfully",
			view as StudioProductsModel.Grant.Response,
		);
	},
);

router.delete(
	"/:userId",

	APIRouteSpec.authenticated({
		summary: "Revoke product",
		description:
			"Take a product away from a user. It is unequipped from all their Minecraft accounts.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Product revoked successfully"),
			APIResponseSpec.forbidden("You are not allowed to manage redeem codes and grants of this page"),
			APIResponseSpec.notFound("The user does not own this product"),
		),
	}),

	zValidator("param", StudioProductsModel.OwnerId.Params),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const product = c.get("product");
		const { userId } = c.req.valid("param");

		const revoked = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const revoked = await InventoryHandler.revoke(userId, product.id, tx);
			if (revoked) {
				await AuditLog.record(
					{
						actor_user_id: authContext.user_id,
						action: "product.revoke",
						target_type: "product",
						target_id: product.id,
						details: { user_id: userId },
					},
					tx,
				);
			}
			return revoked;
		});

		if (!revoked) {
			return APIResponse.notFound(c, "The user does not own this product");
		}

		return APIResponse.successNoData(c, "Product revoked successfully");
	},
);
