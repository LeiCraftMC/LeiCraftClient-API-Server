import { and, eq, inArray, sql } from "drizzle-orm";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import { LCrypt } from "../../utils/crypto/lcrypt";
import { InventoryHandler } from "./inventory";

/**
 * Redeem codes hand out exclusive products of an official or partner page. A code may grant
 * several products, can be limited in uses and time, and every user can redeem it once.
 */
export class RedeemCodeHandler {
	/** No 0/O, 1/I — easy to type from a screenshot. 32 symbols, so `byte % 32` is unbiased. */
	static readonly ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	static readonly GROUPS = 3;
	static readonly GROUP_LENGTH = 4;

	/** Uppercase, without whitespace — how codes are stored and compared. */
	static normalize(code: string) {
		return code.replace(/\s+/g, "").toUpperCase();
	}

	/** A random code like `K7QF-2MXP-9TBA` (60 bits). */
	static generate() {
		const bytes = LCrypt.randomBytes(this.GROUPS * this.GROUP_LENGTH);
		const chars = Array.from(bytes, (byte) => this.ALPHABET[byte % this.ALPHABET.length]);

		const groups: string[] = [];
		for (let i = 0; i < this.GROUPS; i++) {
			groups.push(chars.slice(i * this.GROUP_LENGTH, (i + 1) * this.GROUP_LENGTH).join(""));
		}
		return groups.join("-");
	}

	static isUsable(code: DB.Models.RedeemCode) {
		return (
			!code.disabled &&
			(code.expires_at === null || code.expires_at > Date.now()) &&
			(code.max_uses === null || code.use_count < code.max_uses)
		);
	}

	/** Product ids per code id. */
	static async loadProductIDs(codeIDs: number[], tx: DrizzleDB = DB.instance()) {
		const byCode = new Map<number, number[]>();
		if (codeIDs.length === 0) {
			return byCode;
		}

		const rows = await tx
			.select()
			.from(DB.Tables.redeemCodeProducts)
			.where(inArray(DB.Tables.redeemCodeProducts.code_id, codeIDs))
			.all();

		for (const row of rows) {
			const list = byCode.get(row.code_id) ?? [];
			list.push(row.product_id);
			byCode.set(row.code_id, list);
		}
		return byCode;
	}

	static async redeem(
		userID: number,
		rawCode: string,
		tx: DrizzleDB = DB.instance(),
	): Promise<RedeemCodeHandler.RedeemResult> {
		const code = await tx
			.select()
			.from(DB.Tables.redeemCodes)
			.where(eq(DB.Tables.redeemCodes.code, this.normalize(rawCode)))
			.get();

		if (!code || !this.isUsable(code)) {
			return { ok: false, code: 400, message: "Invalid or expired code" };
		}

		const alreadyUsed = await tx
			.select()
			.from(DB.Tables.redeemCodeUses)
			.where(
				and(
					eq(DB.Tables.redeemCodeUses.code_id, code.id),
					eq(DB.Tables.redeemCodeUses.user_id, userID),
				),
			)
			.get();

		if (alreadyUsed) {
			return { ok: false, code: 409, message: "You have already redeemed this code" };
		}

		// Conditional increment: a concurrent redeem of the last use cannot overshoot max_uses.
		const claimed = await tx
			.update(DB.Tables.redeemCodes)
			.set({ use_count: sql`${DB.Tables.redeemCodes.use_count} + 1` })
			.where(
				and(
					eq(DB.Tables.redeemCodes.id, code.id),
					sql`(${DB.Tables.redeemCodes.max_uses} IS NULL OR ${DB.Tables.redeemCodes.use_count} < ${DB.Tables.redeemCodes.max_uses})`,
				),
			)
			.returning()
			.all();

		if (claimed.length === 0) {
			return { ok: false, code: 400, message: "Invalid or expired code" };
		}

		await tx.insert(DB.Tables.redeemCodeUses).values({ code_id: code.id, user_id: userID });

		const productIDs = (await this.loadProductIDs([code.id], tx)).get(code.id) ?? [];

		const granted: number[] = [];
		for (const productID of productIDs) {
			const isNew = await InventoryHandler.grant(
				userID,
				productID,
				{ source: "code", redeem_code_id: code.id },
				tx,
			);
			if (isNew) granted.push(productID);
		}

		const products = productIDs.length
			? await tx
					.select()
					.from(DB.Tables.products)
					.where(inArray(DB.Tables.products.id, productIDs))
					.all()
			: [];

		return { ok: true, products, granted_product_ids: granted };
	}
}

export namespace RedeemCodeHandler {
	export type RedeemResult =
		| { ok: true; products: DB.Models.Product[]; granted_product_ids: number[] }
		| { ok: false; code: 400 | 409; message: string };
}
