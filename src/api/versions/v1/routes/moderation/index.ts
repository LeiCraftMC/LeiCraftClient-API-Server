import { Hono } from "hono";
import { APIResponse } from "../../../../utils/api-res";
import { AuthHandler } from "../../../../utils/authHandler";
import { UserAccountSettings } from "../../../../utils/shared-models/accountData";

export const router = new Hono().basePath("/moderation");

router.use("*", async (c, next) => {
	const authContext = AuthHandler.AuthContext.get(c);

	if (!AuthHandler.isUserContext(authContext)) {
		return APIResponse.unauthorized(c, "Authentication required");
	}

	if (!UserAccountSettings.isStaff(authContext.user_role)) {
		return APIResponse.forbidden(c, "This endpoint is restricted to moderators and administrators");
	}

	await next();
});

router.route("/", (await import("./products")).router);
router.route("/", (await import("./pages")).router);
router.route("/", (await import("./reports")).router);
router.route("/", (await import("./users")).router);
