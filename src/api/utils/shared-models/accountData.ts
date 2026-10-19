import z from "zod";

export namespace UserAccountSettings {
	export const Roles = ["admin", "moderator", "user"] as const;
	export const Role = z.enum(Roles);
	export type Role = z.infer<typeof Role>;

	/** Roles that may use the moderation endpoints. */
	export const StaffRoles = ["admin", "moderator"] as const satisfies readonly Role[];

	export function isStaff(role: Role) {
		return (StaffRoles as readonly Role[]).includes(role);
	}
}

export namespace UserDataPolicies {
	/** Discord snowflake (17–20 digits). */
	export const DiscordID = z
		.string()
		.regex(/^\d{17,20}$/, "Must be a Discord user ID (17–20 digits)")
		.describe("Discord user ID");

	export type DiscordID = z.infer<typeof DiscordID>;
}

export namespace MinecraftDataPolicies {
	/** Minecraft account name as Mojang allows it (3–16 characters, letters, digits, underscore). */
	export const Name = z
		.string()
		.regex(/^\w{3,16}$/, "Must be a valid Minecraft username")
		.describe("Minecraft username");

	export type Name = z.infer<typeof Name>;

	/** Minecraft UUID, with or without dashes. Normalized to the dashed lowercase form. */
	export const UUID = z
		.string()
		.regex(
			/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/,
			"Must be a Minecraft UUID",
		)
		.transform((value) => MinecraftDataPolicies.normalizeUUID(value) as string)
		.describe("Minecraft UUID (dashed or undashed)");

	export type UUID = z.infer<typeof UUID>;

	export const SkinModels = ["wide", "slim"] as const;
	export const SkinModel = z.enum(SkinModels);
	export type SkinModel = z.infer<typeof SkinModel>;

	/** Returns the dashed lowercase form of a UUID, or null if the input is not a UUID. */
	export function normalizeUUID(value: string) {
		const hex = value.replaceAll("-", "").toLowerCase();
		if (!/^[0-9a-f]{32}$/.test(hex)) {
			return null;
		}
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}
}
