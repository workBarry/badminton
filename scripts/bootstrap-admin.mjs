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
  })),
  matchingAccounts: matchingSnapshot.docs.map((document) => ({
    id: document.id,
    role: String(document.data().role ?? "MEMBER"),
    membershipStatus: String(document.data().membershipStatus ?? "GUEST"),
    accountType: String(document.data().accountType ?? "unclaimed"),
  })),
};

if (!process.argv.includes("--write")) {
  console.log(JSON.stringify({ mode: "check", ...summary }, null, 2));
  process.exit(0);
}

if (matchingSnapshot.size > 1) {
  console.log(JSON.stringify({ mode: "refused", reason: "同名帳號超過一筆，拒絕自動提升權限", ...summary }, null, 2));
  process.exitCode = 1;
} else if (matchingSnapshot.size === 1) {
  const account = matchingSnapshot.docs[0];
  await account.ref.update({
    role: "ADMIN",
    membershipStatus: "MEMBER",
    primaryAdmin: displayName.toLocaleLowerCase("en-US") === "barryadmin",
    updatedAt: new Date(),
  });
  console.log(JSON.stringify({
    mode: "updated",
    id: account.id,
    displayName,
    role: "ADMIN",
    membershipStatus: "MEMBER",
    note: "既有登入與復原方式維持不變",
  }, null, 2));
} else {
  const id = randomUUID();
  const claim = createClaimCode();
  const now = new Date();
  await firestore.collection("members").doc(id).create({
    id,
    displayName,
    department: null,
    role: "ADMIN",
    membershipStatus: "MEMBER",
    primaryAdmin: displayName.toLocaleLowerCase("en-US") === "barryadmin",
    accountType: "unclaimed",
    joinedAt: now,
    endingAt: null,
    creditBalance: 0,
    claimCodeSalt: claim.salt,
    claimCodeHash: claim.hash,
    claimCodeCreatedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  console.log(JSON.stringify({
    mode: "created",
    id,
    displayName,
    role: "ADMIN",
    membershipStatus: "MEMBER",
    claimCode: claim.code,
    note: "請在登入頁選擇「取回既有帳號」，輸入名稱與一次性認領碼",
  }, null, 2));
}
