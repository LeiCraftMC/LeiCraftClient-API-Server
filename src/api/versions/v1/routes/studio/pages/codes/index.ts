import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../../db";
import { type DrizzleDB } from "../../../../../../../db/utils";
import { APIResponse } from "../../../../../../utils/api-res";
import { AuditLog } from "../../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../../utils/authHandler";
import { CatalogViews } from "../../../../../../utils/catalogViews";
import { RedeemCodeHandler } from "../../../../../../utils/redeemCodes";
import { APIResponseSpec, APIRouteSpec } from "../../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../../docs";
import { StudioPageContext, type StudioPageVariables } from "../context";
import { StudioCodesModel } from "./model";

async function codeViews(codes: DB.Models.RedeemCode[]): Promise<StudioCodesModel.Code[]> {
	const productIDsByCode = await RedeemCodeHandler.loadProductIDs(codes.map((code) => code.id));

	const productIDs = [...new Set([...productIDsByCode.values()].flat())];
	const products = productIDs.length
		? await DB.instance()
				.select({
					id: DB.Tables.products.id,
					name: DB.Tables.products.name,
					type: DB.Tables.products.type,
				})
				.from(DB.Tables.products)
				.where(inArray(DB.Tables.products.id, productIDs))
				.all()
		: [];
	const productsByID = new Map(products.map((product) => [product.id, product]));

	const creatorIDs = [
		...new Set(
			codes.map((code) => code.created_by_user_id).filter((id): id is number => id !== null),
		),
	];
	const creators = creatorIDs.length
		? await DB.instance()
				.select()
				.from(DB.Tables.users)
				.where(inArray(DB.Tables.users.id, creatorIDs))
				.all()
		: [];
	const creatorsByID = new Map(creators.map((user) => [user.id, user]));

	return codes.map((code) => {
		const creator = code.created_by_user_id ? creatorsByID.get(code.created_by_user_id) : undefined;
		return {
			id: code.id,
			code: code.code,
			page_id: code.page_id,
			note: code.note,
			max_uses: code.max_uses,
			use_count: code.use_count,
			expires_at: code.expires_at,
			disabled: code.disabled,
			usable: RedeemCodeHandler.isUsable(code),
			created_at: code.created_at,
			created_by: creator ? CatalogViews.publicUser(creator) : null,
			products: (productIDsByCode.get(code.id) ?? []).flatMap((id) => {
				const product = productsByID.get(id);
				return product ? [product] : [];
			}),
		};
	});
}

type Variables = StudioPageVariables & { code: DB.Models.RedeemCode };

export const router = new Hono<{ Variables: Variables }>().basePath("/:pageId/codes");

router.use("*", async (c, next) => {
	const denied = StudioPageContext.deny(c, "manage_exclusives");
	if (denied) return denied;
	await next();
});

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List redeem codes",
		description: "Redeem codes of the page, newest first.",
		tags: [DOCS_TAGS.STUDIO.CODES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Redeem codes retrieved successfully", StudioCodesModel.GetAll.Response),
			APIResponseSpec.forbidden("You are not allowed to manage redeem codes and grants of this page"),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	zValidator("query", StudioCodesModel.GetAll.Query),

	async (c) => {
		const query = c.req.valid("query") as StudioCodesModel.GetAll.Query;

		const codes = await DB.instance()
			.select()
			.from(DB.Tables.redeemCodes)
			.where(
				and(
					eq(DB.Tables.redeemCodes.page_id, c.get("page").id),
					query.search
						? or(
								like(DB.Tables.redeemCodes.code, `%${query.search.toUpperCase()}%`),
								like(DB.Tables.redeemCodes.note, `%${query.search}%`),
							)
						: undefined,
				),
			)
			.orderBy(desc(DB.Tables.redeemCodes.created_at), desc(DB.Tables.redeemCodes.id))
			.limit(query.limit)
			.offset(query.offset)
			.all();

		return APIResponse.success(c, "Redeem codes retrieved successfully", await codeViews(codes));
	},
);

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Create redeem codes",
		description:
			"Create one custom code (e.g. `SUMMER2026`) or up to 500 random codes (`K7QF-2MXP-9TBA`) that grant exclusive products of this page. Codes are single-use per user; `max_uses` limits the total uses per code.",
		tags: [DOCS_TAGS.STUDIO.CODES],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.created("Redeem codes created successfully", StudioCodesModel.Create.Response),
			APIResponseSpec.badRequest(
				"Products must be exclusive products of this page / Syntax or validation error in request",
			),
			APIResponseSpec.forbidden("You are not allowed to manage redeem codes and grants of this page"),
			APIResponseSpec.notFound("Page not found"),
			APIResponseSpec.conflict("Code already exists"),
		),
	}),

	zValidator("json", StudioCodesModel.Create.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const page = c.get("page");
		const body = c.req.valid("json");

		const productIDs = [...new Set(body.product_ids)];
		const products = await DB.instance()
			.select()
			.from(DB.Tables.products)
			.where(and(inArray(DB.Tables.products.id, productIDs), eq(DB.Tables.products.page_id, page.id)))
			.all();

		if (
			products.length !== productIDs.length ||
			products.some((product) => product.availability !== "exclusive")
		) {
			return APIResponse.badRequest(c, "Products must be exclusive products of this page");
		}

		if (body.expires_at && body.expires_at <= Date.now()) {
			return APIResponse.badRequest(c, "expires_at must be in the future");
		}

		const values = {
			page_id: page.id,
			note: body.note ?? "",
			max_uses: body.max_uses === undefined ? 1 : body.max_uses,
			expires_at: body.expires_at ?? null,
			created_by_user_id: authContext.user_id,
		};

		const created = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const codes: DB.Models.RedeemCode[] = [];

			if (body.code !== undefined) {
				const code = await tx
					.insert(DB.Tables.redeemCodes)
					.values({ ...values, code: RedeemCodeHandler.normalize(body.code) })
					.onConflictDoNothing()
					.returning()
					.get();
				if (!code) {
					return null;
				}
				codes.push(code);
			} else {
				const wanted = body.count ?? 1;
				while (codes.length < wanted) {
					// a collision of 60-bit random codes just takes another attempt
					const code = await tx
						.insert(DB.Tables.redeemCodes)
						.values({ ...values, code: RedeemCodeHandler.generate() })
						.onConflictDoNothing()
						.returning()
						.get();
					if (code) codes.push(code);
				}
			}

			await tx
				.insert(DB.Tables.redeemCodeProducts)
				.values(
					codes.flatMap((code) =>
						productIDs.map((productID) => ({ code_id: code.id, product_id: productID })),
					),
				);

			await AuditLog.record(
				{
					actor_user_id: authContext.user_id,
					action: "code.create",
					target_type: "page",
					target_id: page.id,
					details: {
						code_ids: codes.map((code) => code.id),
						product_ids: productIDs,
						max_uses: values.max_uses,
					},
				},
				tx,
			);

			return codes;
		});

		if (!created) {
			return APIResponse.conflict(c, "Code already exists");
		}

		return APIResponse.created(c, "Redeem codes created successfully", await codeViews(created));
	},
);

router.use(
	"/:codeId/*",

	zValidator("param", StudioCodesModel.CodeId.Params),

	async (c, next) => {
		// @ts-ignore - hono-openapi does not type "param" yet
		const { codeId } = c.req.valid("param") as StudioCodesModel.CodeId.Params;

		const code = await DB.instance()
			.select()
			.from(DB.Tables.redeemCodes)
			.where(
				and(eq(DB.Tables.redeemCodes.id, codeId), eq(DB.Tables.redeemCodes.page_id, c.get("page").id)),
			)
			.get();

		if (!code) {
			return APIResponse.notFound(c, "Redeem code not found");
		}

		c.set("code", code);

		await next();
	},
);

router.get(
	"/:codeId",

	APIRouteSpec.authenticated({
		summary: "Get redeem code",
		description: "One redeem code with its products and use count.",
		tags: [DOCS_TAGS.STUDIO.CODES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Redeem code retrieved successfully", StudioCodesModel.Code),
			APIResponseSpec.notFound("Redeem code not found"),
		),
	}),

	async (c) => {
		const [view] = await codeViews([c.get("code")]);
		return APIResponse.success(
			c,
			"Redeem code retrieved successfully",
			view as StudioCodesModel.Code,
		);
	},
);

router.put(
	"/:codeId",

	APIRouteSpec.authenticated({
		summary: "Update redeem code",
		description: "Disable or re-enable a code, or change its use limit, expiry or note.",
		tags: [DOCS_TAGS.STUDIO.CODES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Redeem code updated successfully", StudioCodesModel.Update.Response),
			APIResponseSpec.notFound("Redeem code not found"),
		),
	}),

	zValidator("json", StudioCodesModel.Update.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const code = c.get("code");
		const body = c.req.valid("json");

		const updated = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const updated = await tx
				.update(DB.Tables.redeemCodes)
				.set(body)
				.where(eq(DB.Tables.redeemCodes.id, code.id))
				.returning()
				.get();

			await AuditLog.record(
				{
					actor_user_id: authContext.user_id,
					action: "code.update",
					target_type: "code",
					target_id: code.id,
					details: { changes: body },
				},
				tx,
			);

			return updated;
		});

		const [view] = await codeViews([updated]);
		return APIResponse.success(c, "Redeem code updated successfully", view as StudioCodesModel.Code);
	},
);

router.delete(
	"/:codeId",

	APIRouteSpec.authenticated({
		summary: "Delete redeem code",
		description: "Delete a code. Products already redeemed stay with their owners.",
		tags: [DOCS_TAGS.STUDIO.CODES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Redeem code deleted successfully"),
			APIResponseSpec.notFound("Redeem code not found"),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const code = c.get("code");

		await DB.instance().transaction(async (tx: DrizzleDB) => {
			await tx.delete(DB.Tables.redeemCodes).where(eq(DB.Tables.redeemCodes.id, code.id));
			await AuditLog.record(
				{
					actor_user_id: authContext.user_id,
					action: "code.delete",
					target_type: "code",
					target_id: code.id,
					details: { code: code.code, page_id: code.page_id },
				},
				tx,
			);
		});

		return APIResponse.successNoData(c, "Redeem code deleted successfully");
	},
);

router.get(
	"/:codeId/redemptions",

	APIRouteSpec.authenticated({
		summary: "List redemptions",
		description: "Who redeemed the code and when.",
		tags: [DOCS_TAGS.STUDIO.CODES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Redemptions retrieved successfully",
				StudioCodesModel.Redemptions.Response,
			),
			APIResponseSpec.notFound("Redeem code not found"),
		),
	}),

	async (c) => {
		const rows = await DB.instance()
			.select({ use: DB.Tables.redeemCodeUses, user: DB.Tables.users })
			.from(DB.Tables.redeemCodeUses)
			.innerJoin(DB.Tables.users, eq(DB.Tables.users.id, DB.Tables.redeemCodeUses.user_id))
			.where(eq(DB.Tables.redeemCodeUses.code_id, c.get("code").id))
			.orderBy(desc(DB.Tables.redeemCodeUses.created_at))
			.all();

		return APIResponse.success(
			c,
			"Redemptions retrieved successfully",
			rows.map((row) => ({
				user: CatalogViews.publicUser(row.user),
				created_at: row.use.created_at,
			})) satisfies StudioCodesModel.Redemptions.Response,
		);
	},
);
