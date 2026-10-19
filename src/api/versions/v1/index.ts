import { Hono } from "hono";
import { type GenerateSpecOptions } from "hono-openapi";
import { AppConstants } from "../../../utils/constants";
import { APIVersionRouter } from "../../utils/apiVersionRouter";
import { DOCS_TAGS } from "./docs";
import { authMiddlewareV1 } from "./middleware/auth";
import { router as accountRouter } from "./routes/account";
import { router as adminRouter } from "./routes/admin";
import { router as authRouter } from "./routes/auth";
import { router as catalogRouter } from "./routes/catalog";
import { router as clientRouter } from "./routes/client";
import { router as moderationRouter } from "./routes/moderation";
import { router as playersRouter } from "./routes/players";
import { router as reportsRouter } from "./routes/reports";
import { router as studioRouter } from "./routes/studio";

/** Scalar groups tags by `parent`; the field is not in the OpenAPI types. */
function subTag(name: string, displayName: string, parent: string, description: string) {
	return {
		name,
		// @ts-ignore - Scalar extension field
		"x-displayName": displayName,
		summary: displayName,
		parent,
		description,
	};
}

const openAPIConfig: Partial<GenerateSpecOptions> = {
	documentation: {
		info: {
			title: `${AppConstants.APP_NAME} API`,
			version: "1.0.0",
			description: [
				`API for the ${AppConstants.APP_NAME} website, the ${AppConstants.APP_NAME} Fabric mod and partner integrations.`,
				"",
				"**Tokens** (`Authorization: Bearer <token>`):",
				"- `lcc_sess_…` — website session from the Discord login (`/auth/discord/*`)",
				"- `lcc_apikey_…` — API key of a user, e.g. for partner bots (`/account/apikeys`)",
				"- `lcc_client_…` — session of the mod for one verified Minecraft account (`/client/auth/*`)",
				"",
				"Uploaded files are served outside this version at `/assets/<sha256>.<png|json>` — immutable, cache them forever.",
			].join("\n"),
		},
		components: {
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					description: "Enter your bearer token in the format **Bearer &lt;token&gt;**",
				},
			},
			responses: {
				401: {
					description: "Authentication information is missing or invalid",
				},
			},
		},

		// Disable global security because Scalar could not handle multiple security schemes properly
		security: [
			{
				bearerAuth: [],
			},
		],

		servers: [
			{
				url: `http://localhost:${AppConstants.APP_API_DEFAULT_PORT}/v1`,
				description: "Local development server",
			},
			{
				url: `${AppConstants.APP_API_DEFAULT_PROD_URL}/v1`,
				description: "Production server",
			},
		],

		// @ts-ignore - Scalar extension field; hono-openapi >=1.5 types drop the `x-` keys
		"x-tagGroups": [
			{
				name: "Account & Authentication",
				tags: [
					DOCS_TAGS.AUTHENTICATION,
					DOCS_TAGS.ACCOUNT,
					DOCS_TAGS.ACCOUNT_MINECRAFT,
					DOCS_TAGS.ACCOUNT_INVENTORY,
					DOCS_TAGS.ACCOUNT_API_KEYS,
					DOCS_TAGS.ACCOUNT_PREFERENCES,
				],
			},
			{
				name: "Game & Shop",
				tags: [DOCS_TAGS.CLIENT, DOCS_TAGS.PLAYERS, DOCS_TAGS.CATALOG, DOCS_TAGS.REPORTS],
			},
			{
				name: DOCS_TAGS.STUDIO.BASE,
				tags: [
					DOCS_TAGS.STUDIO.PAGES,
					DOCS_TAGS.STUDIO.MEMBERS,
					DOCS_TAGS.STUDIO.COLLECTIONS,
					DOCS_TAGS.STUDIO.PRODUCTS,
					DOCS_TAGS.STUDIO.CODES,
					DOCS_TAGS.STUDIO.ASSETS,
				],
			},
			{
				name: DOCS_TAGS.MODERATION.BASE,
				tags: [
					DOCS_TAGS.MODERATION.PRODUCTS,
					DOCS_TAGS.MODERATION.PAGES,
					DOCS_TAGS.MODERATION.REPORTS,
					DOCS_TAGS.MODERATION.USERS,
				],
			},
			{
				name: DOCS_TAGS.ADMIN_API.BASE,
				tags: [DOCS_TAGS.ADMIN_API.USERS, DOCS_TAGS.ADMIN_API.AUDIT_LOG],
			},
		],

		tags: [
			{
				name: DOCS_TAGS.AUTHENTICATION,
				description: "Discord login (OAuth2) and website sessions",
			},
			{
				name: DOCS_TAGS.ACCOUNT,
				description: "Endpoints for user account management",
			},
			subTag(
				DOCS_TAGS.ACCOUNT_MINECRAFT,
				"Minecraft",
				DOCS_TAGS.ACCOUNT,
				"Linked Minecraft accounts and their loadouts (equipped cape and cosmetics)",
			),
			subTag(
				DOCS_TAGS.ACCOUNT_INVENTORY,
				"Inventory",
				DOCS_TAGS.ACCOUNT,
				"Owned exclusive items and redeem codes",
			),
			subTag(
				DOCS_TAGS.ACCOUNT_API_KEYS,
				"API Keys",
				DOCS_TAGS.ACCOUNT,
				"Endpoints for managing account API keys",
			),
			subTag(
				DOCS_TAGS.ACCOUNT_PREFERENCES,
				"Preferences",
				DOCS_TAGS.ACCOUNT,
				"Endpoints for managing account preferences",
			),
			{
				name: DOCS_TAGS.CLIENT,
				description:
					"Endpoints for the Fabric mod: Minecraft account handshake (Mojang session server), account linking via a clickable link, own loadout",
			},
			{
				name: DOCS_TAGS.PLAYERS,
				description: "Public, render-ready player profiles (cape + cosmetics) by UUID or name",
			},
			{
				name: DOCS_TAGS.CATALOG,
				description:
					"The public shop: categories (official / partner / community) → pages → collections → products",
			},
			{
				name: DOCS_TAGS.REPORTS,
				description: "Report content or users to the moderators",
			},
			subTag(
				DOCS_TAGS.STUDIO.PAGES,
				"Pages",
				DOCS_TAGS.STUDIO.BASE,
				"Create and manage shop pages (own community page; admins: official and partner pages)",
			),
			subTag(
				DOCS_TAGS.STUDIO.MEMBERS,
				"Members",
				DOCS_TAGS.STUDIO.BASE,
				"Who may manage an official or partner page",
			),
			subTag(
				DOCS_TAGS.STUDIO.COLLECTIONS,
				"Collections",
				DOCS_TAGS.STUDIO.BASE,
				"Group a page's products into collections",
			),
			subTag(
				DOCS_TAGS.STUDIO.PRODUCTS,
				"Products",
				DOCS_TAGS.STUDIO.BASE,
				"Capes and cosmetics (with skin variants), publishing and grants of exclusive products",
			),
			subTag(
				DOCS_TAGS.STUDIO.CODES,
				"Redeem Codes",
				DOCS_TAGS.STUDIO.BASE,
				"Redeem codes for exclusive products of official and partner pages",
			),
			subTag(
				DOCS_TAGS.STUDIO.ASSETS,
				"Assets",
				DOCS_TAGS.STUDIO.BASE,
				"Upload textures, models and images",
			),
			subTag(
				DOCS_TAGS.MODERATION.PRODUCTS,
				"Products",
				DOCS_TAGS.MODERATION.BASE,
				"Review queue for community products and takedowns",
			),
			subTag(DOCS_TAGS.MODERATION.PAGES, "Pages", DOCS_TAGS.MODERATION.BASE, "Hide and restore pages"),
			subTag(
				DOCS_TAGS.MODERATION.REPORTS,
				"Reports",
				DOCS_TAGS.MODERATION.BASE,
				"Handle reports from users",
			),
			subTag(DOCS_TAGS.MODERATION.USERS, "Users", DOCS_TAGS.MODERATION.BASE, "Ban and unban users"),
			subTag(
				DOCS_TAGS.ADMIN_API.USERS,
				"Users",
				DOCS_TAGS.ADMIN_API.BASE,
				"User management and roles",
			),
			subTag(
				DOCS_TAGS.ADMIN_API.AUDIT_LOG,
				"Audit Log",
				DOCS_TAGS.ADMIN_API.BASE,
				"Who did what in moderation, administration and the studio",
			),
		],
	},
};

const router = new Hono();

router.use(authMiddlewareV1);

router.route("/", authRouter);
router.route("/", accountRouter);
router.route("/", clientRouter);
router.route("/", playersRouter);
router.route("/", catalogRouter);
router.route("/", reportsRouter);
router.route("/", studioRouter);
router.route("/", moderationRouter);
router.route("/", adminRouter);

export class APIv1Router extends APIVersionRouter {
	constructor() {
		super({
			version: 1,
			openAPIConfig,
			routes: router,
		});
	}
}
