import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase-admin";

export const DEVICE_COOKIE = "badminton_device";
export const DEVICE_SESSION_MAX_AGE = 60 * 60 * 24 * 365;

export type Viewer = {
  id: string;
  name: string;
  department: string | null;
  role: "ADMIN" | "MEMBER";
  membershipStatus: string;
  creditBalance: number;
  accountType: "guest" | "recoverable" | "verified" | "unclaimed";
  hasRecoveryCode: boolean;
  hasPasskey: boolean;
};

export type DeviceAccount = Pick<Viewer, "id" | "name" | "role" | "membershipStatus">;

function secretHash(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function normalizedCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function recoveryHash(code: string, salt: string) {
  return scryptSync(normalizedCode(code), salt, 32).toString("hex");
}

function secureHexEqual(left: string, right: string) {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right) || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function recoveryCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  const characters = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
  return [characters.slice(0, 4), characters.slice(4, 8), characters.slice(8, 12), characters.slice(12, 16)]
    .map((group) => group.join(""))
    .join("-");
}

export function createClaimCodeRecord() {
  const code = recoveryCode();
  const salt = randomBytes(16).toString("hex");
  return { code, salt, hash: recoveryHash(code, salt) };
}

function viewerFromMember(id: string, member: FirebaseFirestore.DocumentData): Viewer {
  const storedMembershipStatus = String(member.membershipStatus ?? "GUEST");
  const endingAt = typeof member.endingAt?.toDate === "function" ? member.endingAt.toDate() : member.endingAt ? new Date(member.endingAt) : null;
  const membershipStatus = storedMembershipStatus === "EXITING" && endingAt && endingAt <= new Date() ? "GUEST" : storedMembershipStatus;
  return {
    id,
    name: String(member.displayName ?? ""),
    department: member.department ? String(member.department) : null,
    role: member.role === "ADMIN" ? "ADMIN" : "MEMBER",
    membershipStatus,
    creditBalance: Number(member.creditBalance ?? 0),
    accountType: ["guest", "recoverable", "verified", "unclaimed"].includes(String(member.accountType))
      ? member.accountType as Viewer["accountType"]
      : "unclaimed",
    hasRecoveryCode: Boolean(member.recoveryCodeHash),
    hasPasskey: Number(member.passkeyCount ?? 0) > 0,
  };
}

function newDeviceCredential(userId: string) {
  const credentialId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEVICE_SESSION_MAX_AGE * 1000);
  return {
    token: `${credentialId}.${secret}`,
    ref: getAdminFirestore().collection("deviceCredentials").doc(credentialId),
    data: {
      userId,
      accountIds: [userId],
      activeUserId: userId,
      secretHash: secretHash(secret),
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
      revokedAt: null,
    },
  };
}

function rememberedAccountIds(data: FirebaseFirestore.DocumentData) {
  const ids = Array.isArray(data.accountIds) ? data.accountIds.map(String) : [];
  if (data.userId) ids.push(String(data.userId));
  return [...new Set(ids)].slice(0, 8);
}

function activeAccountId(data: FirebaseFirestore.DocumentData) {
  if (Object.prototype.hasOwnProperty.call(data, "activeUserId")) {
    return data.activeUserId ? String(data.activeUserId) : null;
  }
  return data.userId ? String(data.userId) : null;
}

async function credentialForToken(token?: string | null) {
  if (!token) return null;
  const [credentialId, secret, extra] = token.split(".");
  if (!credentialId || !secret || extra) return null;
  const db = getAdminFirestore();
  const credential = await db.collection("deviceCredentials").doc(credentialId).get();
  if (!credential.exists) return null;
  const data = credential.data()!;
  const expiresAt = data.expiresAt?.toDate?.() as Date | undefined;
  if (data.revokedAt || !expiresAt || expiresAt <= new Date()) return null;
  const expectedHash = String(data.secretHash ?? "");
  if (!secureHexEqual(secretHash(secret), expectedHash)) return null;
  return { token, ref: credential.ref, data };
}

async function credentialForUser(userId: string, existingToken?: string | null) {
  const existing = await credentialForToken(existingToken);
  const now = new Date();
  if (!existing) return { ...newDeviceCredential(userId), create: true };
  const accountIds = rememberedAccountIds(existing.data);
  if (!accountIds.includes(userId) && accountIds.length >= 8) throw new Error("這台裝置記住的帳號已達 8 個，請先使用其他瀏覽器設定檔");
  return {
    token: existing.token,
    ref: existing.ref,
    create: false,
    data: {
      accountIds: FieldValue.arrayUnion(...accountIds, userId),
      activeUserId: userId,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + DEVICE_SESSION_MAX_AGE * 1000),
    },
  };
}

export async function viewerForDeviceToken(token?: string | null) {
  const credential = await credentialForToken(token);
  if (!credential) return null;
  const userId = activeAccountId(credential.data);
  if (!userId) return null;
  const member = await getAdminFirestore().collection("members").doc(userId).get();
  if (!member.exists) return null;
  return viewerFromMember(member.id, member.data()!);
}

export async function deviceAccountsForToken(token?: string | null): Promise<DeviceAccount[]> {
  const credential = await credentialForToken(token);
  if (!credential) return [];
  const db = getAdminFirestore();
  const references = rememberedAccountIds(credential.data).map((id) => db.collection("members").doc(id));
  if (references.length === 0) return [];
  const members = await db.getAll(...references);
  return members
    .filter((member) => member.exists)
    .map((member) => {
      const viewer = viewerFromMember(member.id, member.data()!);
      return { id: viewer.id, name: viewer.name, role: viewer.role, membershipStatus: viewer.membershipStatus };
    });
}

export async function activateDeviceAccount(token: string | null | undefined, userId: string) {
  const credential = await credentialForToken(token);
  if (!credential || !rememberedAccountIds(credential.data).includes(userId)) throw new Error("這台裝置沒有記住此帳號");
  const db = getAdminFirestore();
  const member = await db.collection("members").doc(userId).get();
  if (!member.exists) throw new Error("找不到使用者");
  const now = new Date();
  await credential.ref.update({
    accountIds: rememberedAccountIds(credential.data),
    activeUserId: userId,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + DEVICE_SESSION_MAX_AGE * 1000),
  });
  return viewerFromMember(member.id, member.data()!);
}

export async function deactivateDeviceToken(token?: string | null) {
  const credential = await credentialForToken(token);
  if (!credential) return;
  await credential.ref.update({
    accountIds: rememberedAccountIds(credential.data),
    activeUserId: null,
    loggedOutAt: new Date(),
  });
}

export async function createGuestDeviceAccount(displayName: string, existingToken?: string | null) {
  const name = displayName.trim();
  if (!name) throw new Error("請輸入使用者名稱");
  if (name.length > 40) throw new Error("使用者名稱不能超過 40 個字元");
  const db = getAdminFirestore();
  const userId = randomUUID();
  const memberRef = db.collection("members").doc(userId);
  const credential = await credentialForUser(userId, existingToken);
  const now = new Date();
  const batch = db.batch();
  batch.create(memberRef, {
    id: userId,
    displayName: name,
    department: null,
    role: "MEMBER",
    membershipStatus: "GUEST",
    accountType: "guest",
    joinedAt: null,
    endingAt: null,
    creditBalance: 0,
    createdAt: now,
    updatedAt: now,
  });
  if (credential.create) batch.create(credential.ref, credential.data);
  else batch.update(credential.ref, credential.data);
  await batch.commit();
  return { token: credential.token, viewer: viewerFromMember(userId, { displayName: name, role: "MEMBER", membershipStatus: "GUEST", accountType: "guest", creditBalance: 0 }) };
}

export async function loginWithRecoveryOrClaimCode(displayName: string, code: string, existingToken?: string | null) {
  const name = displayName.trim();
  const cleanCode = normalizedCode(code);
  if (!name || cleanCode.length !== 16) throw new Error("姓名或認領／復原碼不正確");
  const db = getAdminFirestore();
  const candidates = await db.collection("members").where("displayName", "==", name).get();
  let matched: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (const candidate of candidates.docs) {
    const member = candidate.data();
    const pairs = [
      [member.claimCodeSalt, member.claimCodeHash],
      [member.recoveryCodeSalt, member.recoveryCodeHash],
    ];
    if (pairs.some(([salt, hash]) => salt && hash && secureHexEqual(recoveryHash(cleanCode, String(salt)), String(hash)))) {
      matched = candidate;
      break;
    }
  }
  if (!matched) throw new Error("姓名或認領／復原碼不正確");

  const nextRecoveryCode = recoveryCode();
  const recoverySalt = randomBytes(16).toString("hex");
  const credential = await credentialForUser(matched.id, existingToken);
  const batch = db.batch();
  if (credential.create) batch.create(credential.ref, credential.data);
  else batch.update(credential.ref, credential.data);
  batch.update(matched.ref, {
    accountType: "recoverable",
    recoveryCodeSalt: recoverySalt,
    recoveryCodeHash: recoveryHash(nextRecoveryCode, recoverySalt),
    recoveryCodeCreatedAt: new Date(),
    claimCodeSalt: FieldValue.delete(),
    claimCodeHash: FieldValue.delete(),
    claimedAt: new Date(),
    updatedAt: new Date(),
  });
  await batch.commit();
  const updated = { ...matched.data(), accountType: "recoverable", recoveryCodeHash: true };
  return { token: credential.token, viewer: viewerFromMember(matched.id, updated), recoveryCode: nextRecoveryCode };
}

export async function createRecoveryCode(userId: string) {
  const db = getAdminFirestore();
  const memberRef = db.collection("members").doc(userId);
  const member = await memberRef.get();
  if (!member.exists) throw new Error("找不到使用者");
  const code = recoveryCode();
  const salt = randomBytes(16).toString("hex");
  await memberRef.update({
    accountType: "recoverable",
    recoveryCodeSalt: salt,
    recoveryCodeHash: recoveryHash(code, salt),
    recoveryCodeCreatedAt: new Date(),
    updatedAt: new Date(),
  });
  return code;
}

export async function createDeviceSessionForUser(userId: string, existingToken?: string | null) {
  const db = getAdminFirestore();
  const member = await db.collection("members").doc(userId).get();
  if (!member.exists) throw new Error("找不到使用者");
  const credential = await credentialForUser(userId, existingToken);
  if (credential.create) await credential.ref.create(credential.data);
  else await credential.ref.update(credential.data);
  return { token: credential.token, viewer: viewerFromMember(member.id, member.data()!) };
}

export async function revokeDeviceToken(token?: string | null) {
  const credential = await credentialForToken(token);
  if (!credential) return;
  await credential.ref.update({ revokedAt: new Date(), activeUserId: null });
}
