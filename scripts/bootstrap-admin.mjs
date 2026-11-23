import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim();
}

// Keep this legacy compatibility rule aligned with src/lib/club-roles.ts.
// An explicit false records a completed handover and must never fall back to a name.
function isClubPresident(member) {
  return member.role === "ADMIN" && (member.primaryAdmin === true || (
    member.primaryAdmin === undefined && String(member.displayName ?? "").toLocaleLowerCase("en-US") === "barryadmin"
  ));
}

function createClaimCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  const characters = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
  const code = [characters.slice(0, 4), characters.slice(4, 8), characters.slice(8, 12), characters.slice(12, 16)]
    .map((group) => group.join(""))
    .join("-");
  const salt = randomBytes(16).toString("hex");
  return {
    code,
    salt,
    hash: scryptSync(code.replaceAll("-", ""), salt, 32).toString("hex"),
  };
}

const displayName = argument("name");
if (!displayName) throw new Error("請提供 --name=使用者名稱");
if (displayName.length > 40) throw new Error("使用者名稱不能超過 40 個字元");

const projectId = required("FIREBASE_PROJECT_ID");
const clientEmail = required("FIREBASE_CLIENT_EMAIL");
const privateKey = required("FIREBASE_PRIVATE_KEY").replace(/^['"]|['"]$/g, "").replace(/\\n/g, "\n");
const databaseId = process.env.FIREBASE_DATABASE_ID?.trim() || "(default)";
const app = getApps()[0] ?? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
const firestore = databaseId === "(default)" ? getFirestore(app) : getFirestore(app, databaseId);

const [adminSnapshot, matchingSnapshot] = await Promise.all([
  firestore.collection("members").where("role", "==", "ADMIN").get(),
  firestore.collection("members").where("displayName", "==", displayName).get(),
]);

const summary = {
  databaseId,
  administrators: adminSnapshot.docs.map((document) => ({
    id: document.id,
    displayName: String(document.data().displayName ?? ""),
    membershipStatus: String(document.data().membershipStatus ?? "GUEST"),
    primaryAdmin: isClubPresident(document.data()),
  })),
  matchingAccounts: matchingSnapshot.docs.map((document) => ({
    id: document.id,
    role: String(document.data().role ?? "MEMBER"),
    membershipStatus: String(document.data().membershipStatus ?? "GUEST"),
    accountType: String(document.data().accountType ?? "unclaimed"),
    primaryAdmin: isClubPresident(document.data()),
  })),
};

if (!process.argv.includes("--write")) {
  console.log(JSON.stringify({ mode: "check", ...summary }, null, 2));
  process.exit(0);
}

const newId = randomUUID();
const claim = createClaimCode();
const result = await firestore.runTransaction(async (transaction) => {
  // Recheck both queries in the write transaction: a handover may have happened
  // after the read-only summary, or another bootstrap may run concurrently.
  const [administrators, matchingAccounts] = await Promise.all([
    transaction.get(firestore.collection("members").where("role", "==", "ADMIN")),
    transaction.get(firestore.collection("members").where("displayName", "==", displayName)),
  ]);
  if (matchingAccounts.size > 1) return { mode: "refused", reason: "同名帳號超過一筆，拒絕自動提升權限" };
  const presidents = administrators.docs.filter((document) => isClubPresident(document.data()));
  if (presidents.length > 1) return { mode: "refused", reason: "偵測到多位社長，請先人工確認資料，不自動覆寫權限" };
  const account = matchingAccounts.docs[0];
  const member = account?.data();
  // Preserve a stored decision, including false after handover. BarryAdmin is
  // only the initial-president default when there is no existing president.
  const primaryAdmin = member?.primaryAdmin === false ? false
    : member?.primaryAdmin === true || (member ? isClubPresident(member) : false)
      || (presidents.length === 0 && displayName.toLocaleLowerCase("en-US") === "barryadmin");
  if (primaryAdmin && presidents.some((document) => document.id !== account?.id)) {
    return { mode: "refused", reason: "已有其他社長，請由現任社長在網站轉交權限" };
  }
  const now = new Date();
  const id = account?.id ?? newId;
  const values = { role: "ADMIN", membershipStatus: "MEMBER", primaryAdmin, endingAt: null, updatedAt: now };
  if (account) {
    transaction.update(account.ref, values);
    return { mode: "updated", id, displayName, ...values, note: "既有登入與復原方式維持不變；初始化指令不取代社長轉交流程" };
  }
  transaction.create(firestore.collection("members").doc(id), {
    id,
    displayName,
    department: null,
    ...values,
    accountType: "unclaimed",
    joinedAt: now,
    creditBalance: 0,
    claimCodeSalt: claim.salt,
    claimCodeHash: claim.hash,
    claimCodeCreatedAt: now,
    createdAt: now,
  });
  return { mode: "created", id, displayName, ...values, claimCode: claim.code, note: "請在登入頁選擇「取回既有帳號」，輸入名稱與一次性認領碼" };
});
console.log(JSON.stringify(result, null, 2));
if (result.mode === "refused") process.exitCode = 1;
