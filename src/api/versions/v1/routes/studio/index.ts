import { Hono } from "hono";
import { APIResponse } from "../../../../utils/api-res";
import { AuthHandler } from "../../../../utils/authHandler";

/**
 * The studio: where page members (and admins) manage pages, collections, products, codes and
 * grants, and where users create their community page. Works with website sessions and API
 * keys (e.g. a partner's bot handing out items).
 */
export const router = new Hono().basePath("/studio");

router.use("*", async (c, next) => {
	const authContext = AuthHandler.AuthContext.get(c);

	if (authContext.type === "unauthenticated") {
		return APIResponse.unauthorized(c, "Authentication required");
	}

	if (!AuthHandler.isUserContext(authContext)) {
		return APIResponse.unauthorized(c, "This endpoint requires a user session or API key");
	}

	await next();
});

router.route("/", (await import("./assets")).router);
router.route("/", (await import("./pages")).router);
