import { createHash } from "node:crypto";

export const NAME_IN_USE_MESSAGE = "這個帳號名稱已被使用。若是你的帳號，請使用快速登入或「取回既有帳號」；新帳號請改用其他帳號名稱。";

/** @param {unknown} value */
export function memberNameKey(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").trim().replace(/\s+/gu, " ").toLowerCase();
}

/** @param {unknown} input @param {string} label */
function validatedName(input, label) {
  if (typeof input !== "string") throw new Error(`請輸入${label}`);
  if (/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(input)) throw new Error(`${label}不能包含控制字元或不可見字元`);
  const name = input.trim().replace(/\s+/gu, " ");
  if (!name || !memberNameKey(name)) throw new Error(`請輸入${label}`);
  if (name.length > 40) throw new Error(`${label}不能超過 40 個字元`);
  return name;
}

/** @param {unknown} input */
export function validatedAccountName(input) { return validatedName(input, "帳號名稱"); }

/** Format validation only: display names are not account identities. @param {unknown} input */
export function validatedDisplayName(input) { return validatedName(input, "顯示名稱"); }

/**
 * Only an absent accountName may use the original legacy display name.
 * An explicitly invalid accountName must not fall back to a mutable label.
 * @param {import("firebase-admin/firestore").DocumentData} member
 */
export function memberAccountName(member) {
  const value = Object.hasOwn(member, "accountName") ? member.accountName : member.displayName;
  return typeof value === "string" ? value : "";
}

/** @param {string} name */
export function memberNameId(name) { return createHash("sha256").update(memberNameKey(name)).digest("hex"); }

/**
 * Account lookup includes legacy accounts but never treats a changed display
 * name as a second account name or authentication alias.
 * @param {import("firebase-admin/firestore").QuerySnapshot} snapshot
 * @param {string} name
 */
export function findMembersByName(snapshot, name) {
  const key = memberNameKey(name);
  return key ? snapshot.docs.filter(member => memberNameKey(memberAccountName(member.data())) === key) : [];
}

/**
 * Read before all transaction writes. Existing memberNames reservations stay
 * attached to the immutable account name, including after display-name edits.
 * @param {import("firebase-admin/firestore").Transaction} transaction
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} input
 */
export async function readMemberName(transaction, db, input) {
  const accountName = validatedAccountName(input);
  const nameKey = memberNameKey(accountName);
  const ref = db.collection("memberNames").doc(memberNameId(accountName));
  const [reservation, members] = await Promise.all([transaction.get(ref), transaction.get(db.collection("members"))]);
  const matches = findMembersByName(members, accountName);
  if (matches.length > 1) throw new Error("目前有多個相同帳號名稱，請聯絡幹部確認後再操作");
  const member = matches[0] ?? null;
  if (reservation.exists) {
    const data = reservation.data();
    if (!member) throw new Error(NAME_IN_USE_MESSAGE);
    if (data?.memberId !== member.id || data?.nameKey !== nameKey) throw new Error("帳號名稱的保留資料不一致，請聯絡幹部確認");
  }
  // displayName is a transitional alias for older maintenance callers only.
  return { accountName, displayName: accountName, nameKey, ref, reserved: reservation.exists, member };
}

/**
 * @param {import("firebase-admin/firestore").Transaction} transaction
 * @param {Awaited<ReturnType<typeof readMemberName>>} claim
 * @param {string} memberId
 * @param {Date} now
 */
export function reserveMemberName(transaction, claim, memberId, now) {
  if (claim.member && claim.member.id !== memberId) throw new Error(NAME_IN_USE_MESSAGE);
  if (!claim.reserved) transaction.create(claim.ref, { memberId, nameKey: claim.nameKey, accountName: claim.member ? memberAccountName(claim.member.data()) : claim.accountName, createdAt: now });
}
