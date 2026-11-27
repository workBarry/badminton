import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { isClubPresident } from "@/lib/club-roles";
import { getAdminFirestore } from "@/lib/firebase-admin";
import { findMembersByName, memberAccountName, memberNameId, memberNameKey, NAME_IN_USE_MESSAGE, readMemberName, reserveMemberName, validatedAccountName, validatedDisplayName } from "@/lib/member-names.mjs";

import { makePassword, passwordInput, verifyPassword } from "./password-auth";

export const DEVICE_COOKIE = "badminton_device";
export const DEVICE_SESSION_MAX_AGE = 60 * 60 * 24 * 365;
const REMEMBERED_LOGIN_MS = 30 * 24 * 60 * 60 * 1000;

export type Viewer = {
  id: string;
  name: string;
  accountName: string;
  department: string | null;
  role: "ADMIN" | "MEMBER";
  primaryAdmin: boolean;
  membershipStatus: string;
  membershipEndingAt?: string | null;
  creditBalance: number;
  accountType: "guest" | "recoverable" | "verified" | "unclaimed";
  hasRecoveryCode: boolean;
  hasPassword?: boolean;
  avatarVersion?: string | null;
  hasPasskey: boolean;
};

export type DeviceAccount = Pick<Viewer, "id" | "name" | "role" | "membershipStatus" | "primaryAdmin" | "accountName"> & { requiresPassword: boolean };

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
  const membershipStatus = isClubPresident(member) ? "MEMBER" : storedMembershipStatus === "EXITING" && endingAt && endingAt <= new Date() ? "GUEST" : storedMembershipStatus;
  return {
    id,
    name: String(member.displayName ?? ""),
    accountName: memberAccountName(member),
    department: member.department ? String(member.department) : null,
    role: member.role === "ADMIN" ? "ADMIN" : "MEMBER",
    primaryAdmin: isClubPresident(member),
    membershipStatus,
    membershipEndingAt: membershipStatus === "EXITING" && endingAt && Number.isFinite(endingAt.getTime()) ? endingAt.toISOString() : null,
    creditBalance: Number(member.creditBalance ?? 0),
    accountType: ["guest", "recoverable", "verified", "unclaimed"].includes(String(member.accountType))
      ? member.accountType as Viewer["accountType"]
      : "unclaimed",
    hasRecoveryCode: Boolean(member.recoveryCodeHash),
    hasPassword: Boolean(member.passwordVersion),
    ...(typeof member.avatarVersion === "string" ? { avatarVersion: member.avatarVersion } : {}),
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

type RememberedLogin = { userId: string; passwordVersion: string; expiresAtMs: number };

function rememberedLogins(data: FirebaseFirestore.DocumentData, now = Date.now()): RememberedLogin[] {
  if (!Array.isArray(data.rememberedLogins)) return [];
  const accounts = rememberedAccountIds(data);
  return data.rememberedLogins.filter((entry) => entry && accounts.includes(entry.userId) &&
    typeof entry.passwordVersion === "string" && Number.isFinite(entry.expiresAtMs) && entry.expiresAtMs > now).slice(0, 8);
}

function passwordGrant(data: FirebaseFirestore.DocumentData, userId: string, member: FirebaseFirestore.DocumentData) {
  if (!member.passwordVersion || member.role === "ADMIN") return undefined;
  return rememberedLogins(data).find((entry) => entry.userId === userId && entry.passwordVersion === member.passwordVersion);
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
  const expiresAt = storedDate(data.expiresAt);
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
      activePasswordVersion: null,
      quickSessionExpiresAtMs: null,
      privilegedAuth: false,
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
  const data = member.data()!;
  if (data.passwordVersion && credential.data.activePasswordVersion !== data.passwordVersion) return null;
  if (typeof credential.data.quickSessionExpiresAtMs === "number" && credential.data.quickSessionExpiresAtMs <= Date.now()) return null;
  // A regular password session cannot become a privileged session just by role promotion.
  if (data.passwordVersion && data.role === "ADMIN" && credential.data.privilegedAuth !== true) return null;
  return viewerFromMember(member.id, data);
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
      return { id: viewer.id, name: viewer.name, role: viewer.role, membershipStatus: viewer.membershipStatus, primaryAdmin: viewer.primaryAdmin, accountName: viewer.accountName, requiresPassword: viewer.hasPassword === true && !passwordGrant(credential.data, member.id, member.data()!) };
    });
}

export async function activateDeviceAccount(token: string | null | undefined, userId: string) {
  const credential = await credentialForToken(token);
  if (!credential || !rememberedAccountIds(credential.data).includes(userId)) throw new Error("這台裝置沒有記住此帳號");
  const db = getAdminFirestore();
  return db.runTransaction(async (transaction) => {
    const live = await liveCredential(transaction, credential);
    if (!live || !rememberedAccountIds(live.data).includes(userId)) throw new Error("此裝置的快速登入已失效，請輸入密碼");
    const member = await transaction.get(db.collection("members").doc(userId));
    const data = member.data();
    if (!data) throw new Error("找不到使用者");
    const grant = passwordGrant(live.data, userId, data);
    if (data.passwordVersion && !grant) throw new Error("請輸入密碼登入");
    const now = new Date();
    transaction.update(live.ref, {
      activeUserId: userId,
      activePasswordVersion: data.passwordVersion ?? null,
      quickSessionExpiresAtMs: grant?.expiresAtMs ?? null,
      privilegedAuth: false,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + DEVICE_SESSION_MAX_AGE * 1000),
    });
    return viewerFromMember(member.id, data);
  });
}

export async function deactivateDeviceToken(token?: string | null) {
  const credential = await credentialForToken(token);
  if (!credential) return;
  await credential.ref.update({
    accountIds: rememberedAccountIds(credential.data),
    activeUserId: null,
    activePasswordVersion: null,
    quickSessionExpiresAtMs: null,
    privilegedAuth: false,
    loggedOutAt: new Date(),
  });
}

export async function createGuestDeviceAccount(inputAccountName: string, existingToken?: string | null, inputDisplayName?: string, password?: string, clientIp?: string, rememberDevice = false) {
  const accountName = validatedAccountName(inputAccountName);
  const name = inputDisplayName === undefined ? accountName : validatedDisplayName(inputDisplayName);
  const db = getAdminFirestore();
  const userId = randomUUID();
  const memberRef = db.collection("members").doc(userId);
  if (password !== undefined) await limitPasswordAttempts(accountName, "register", clientIp);
  const passwordRecord = password === undefined ? undefined : await makePassword(password);
  const existing = passwordRecord ? await credentialForToken(existingToken) : null;
  const legacyCredential = passwordRecord ? null : await credentialForUser(userId, existingToken);
  const now = new Date();
  const member = {
    ...passwordRecord,
    id: userId,
    accountName,
    accountNameKey: memberNameKey(accountName),
    displayName: name,
    department: null,
    role: "MEMBER",
    membershipStatus: "GUEST",
    accountType: passwordRecord ? "recoverable" : "guest",
    joinedAt: null,
    endingAt: null,
    creditBalance: 0,
    createdAt: now,
    updatedAt: now,
  };
  const credential = await db.runTransaction(async (transaction) => {
    const claim = await readMemberName(transaction, db, accountName);
    const live = await liveCredential(transaction, existing);
    const credential = passwordRecord ? freshPasswordCredential(userId, passwordRecord.passwordVersion, false, live, rememberDevice) : legacyCredential!;
    if (claim.member) throw new Error(NAME_IN_USE_MESSAGE);
    reserveMemberName(transaction, claim, userId, now);
    transaction.create(memberRef, member);
    if (credential.create) transaction.create(credential.ref, credential.data);
    else transaction.update(credential.ref, credential.data);
    revokePrevious(transaction, live);
    return credential;
  });
  return { token: credential.token, viewer: viewerFromMember(userId, member) };
}

export async function loginWithRecoveryOrClaimCode(accountName: string, code: string, existingToken?: string | null) {
  const name = memberNameKey(accountName);
  const cleanCode = normalizedCode(code);
  if (!name || cleanCode.length !== 16) throw new Error("帳號名稱或認領／復原碼不正確");
  const db = getAdminFirestore();
  const candidates = findMembersByName(await db.collection("members").get(), name);
  let matched: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (const candidate of candidates) {
    const member = candidate.data();
    if (member.passwordVersion) continue;
    const pairs = [
      [member.claimCodeSalt, member.claimCodeHash],
      [member.recoveryCodeSalt, member.recoveryCodeHash],
    ];
    if (pairs.some(([salt, hash]) => salt && hash && secureHexEqual(recoveryHash(cleanCode, String(salt)), String(hash)))) {
      matched = candidate;
      break;
    }
  }
  if (!matched) throw new Error("帳號名稱或認領／復原碼不正確");

  const nextRecoveryCode = recoveryCode();
  const recoverySalt = randomBytes(16).toString("hex");
  const credential = await credentialForUser(matched.id, existingToken);
  const matchedRef = matched.ref;
  const updated = await db.runTransaction(async (transaction) => {
    const fresh = await transaction.get(matchedRef);
    if (!fresh.exists) throw new Error("帳號名稱或認領／復原碼不正確");
    const member = fresh.data()!;
    const pairs = [
      [member.claimCodeSalt, member.claimCodeHash],
      [member.recoveryCodeSalt, member.recoveryCodeHash],
    ];
    // Recheck inside the commit boundary: a conflicting recovery rotates the
    // hashes, so a transaction retry cannot reuse the already-consumed code.
    if (member.passwordVersion || memberNameKey(memberAccountName(member)) !== name || !pairs.some(([salt, hash]) =>
      salt && hash && secureHexEqual(recoveryHash(cleanCode, String(salt)), String(hash))
    )) throw new Error("帳號名稱或認領／復原碼不正確");
    if (credential.create) transaction.create(credential.ref, credential.data);
    else transaction.update(credential.ref, credential.data);
    transaction.update(matchedRef, {
      accountType: "recoverable",
      recoveryCodeSalt: recoverySalt,
      recoveryCodeHash: recoveryHash(nextRecoveryCode, recoverySalt),
      recoveryCodeCreatedAt: new Date(),
      claimCodeSalt: FieldValue.delete(),
      claimCodeHash: FieldValue.delete(),
      claimedAt: new Date(),
      updatedAt: new Date(),
    });
    return { ...member, accountType: "recoverable", recoveryCodeHash: true };
  });
  return { token: credential.token, viewer: viewerFromMember(matched.id, updated), recoveryCode: nextRecoveryCode };
}

export async function createRecoveryCode(userId: string, token?: string | null) {
  const db = getAdminFirestore();
  const memberRef = db.collection("members").doc(userId);
  const credential = await credentialForToken(token);
  const code = recoveryCode();
  const salt = randomBytes(16).toString("hex");
  const hash = recoveryHash(code, salt);
  await db.runTransaction(async (transaction) => {
    const member = (await transaction.get(memberRef)).data();
    if (!member) throw new Error("找不到使用者");
    if (member.passwordVersion) {
      const session = credential ? (await transaction.get(credential.ref)).data() : undefined;
      if (!session || session.revokedAt || activeAccountId(session) !== userId ||
        session.activePasswordVersion !== member.passwordVersion ||
        (member.role === "ADMIN" && session.privilegedAuth !== true)) throw new Error("登入已失效，請重新登入");
      if (typeof session.quickSessionExpiresAtMs === "number") throw new Error("請先用密碼登入，再建立復原碼");
    }
    transaction.update(memberRef, {
      accountType: "recoverable", recoveryCodeSalt: salt, recoveryCodeHash: hash,
      recoveryCodeCreatedAt: new Date(), updatedAt: new Date(),
    });
  });
  return code;
}

export async function createDeviceSessionForUser(userId: string, existingToken?: string | null) {
  const db = getAdminFirestore();
  const member = await db.collection("members").doc(userId).get();
  if (!member.exists) throw new Error("找不到使用者");
  const data = member.data()!;
  if (data.passwordVersion) {
    const existing = await credentialForToken(existingToken);
    const credential = await db.runTransaction(async (transaction) => {
      const live = (await transaction.get(member.ref)).data();
      if (live?.passwordVersion !== data.passwordVersion || live?.role !== data.role) throw new Error("帳號已變更，請重新登入");
      const previous = await liveCredential(transaction, existing);
      const credential = freshPasswordCredential(userId, data.passwordVersion, data.role === "ADMIN", previous);
      transaction.create(credential.ref, credential.data);
      revokePrevious(transaction, previous);
      return credential;
    });
    return { token: credential.token, viewer: viewerFromMember(userId, data) };
  }
  const credential = await credentialForUser(userId, existingToken);
  if (credential.create) await credential.ref.create(credential.data);
  else await credential.ref.update(credential.data);
  return { token: credential.token, viewer: viewerFromMember(member.id, member.data()!) };
}

export async function revokeDeviceToken(token?: string | null) {
  const credential = await credentialForToken(token);
  if (!credential) return;
  await credential.ref.update({ revokedAt: new Date(), activeUserId: null, rememberedLogins: [] });
}

const PASSWORD_FAILURE = "帳號或密碼不正確";
const CODE_FAILURE = "帳號或設定碼不正確、已過期或已使用";
const CHALLENGE_LIFETIME = 30 * 60 * 1000;
const ATTEMPT_WINDOW = 15 * 60 * 1000;

function storedDate(value: unknown) {
  if (value instanceof Date) return value;
  return (value as { toDate?: () => Date } | null)?.toDate?.();
}

async function limitPasswordAttempts(accountName: string, purpose: "login" | "code" | "register", clientIp?: string) {
  const db = getAdminFirestore();
  const keys = [{ key: `account:${memberNameKey(accountName)}`, limit: purpose === "register" ? 5 : 8 }];
  if (clientIp) keys.push({ key: `ip:${clientIp}`, limit: purpose === "register" ? 12 : 45 });
  const refs = keys.map(({ key }) => db.collection("authAttemptLimits").doc(secretHash(`${purpose}:${key}`)));
  const now = Date.now();
  await db.runTransaction(async (transaction) => {
    const records = await transaction.getAll(...refs);
    const counters = records.map((record, index) => {
      const data = record.data();
      const expires = storedDate(data?.expiresAt)?.getTime() ?? 0;
      const count = expires > now ? Number(data?.count ?? 0) : 0;
      if (count >= keys[index].limit) throw new Error("嘗試次數過多，請稍後再試");
      return { count: count + 1, expiresAt: new Date(expires > now ? expires : now + ATTEMPT_WINDOW) };
    });
    counters.forEach((counter, index) => transaction.set(refs[index], counter));
  });
}

type ExistingCredential = Awaited<ReturnType<typeof credentialForToken>>;

async function liveCredential(transaction: FirebaseFirestore.Transaction, existing: ExistingCredential): Promise<ExistingCredential> {
  if (!existing) return null;
  const data = (await transaction.get(existing.ref)).data();
  const expires = storedDate(data?.expiresAt);
  if (!data || data.revokedAt || !expires || expires <= new Date() || data.secretHash !== existing.data.secretHash) return null;
  return { ...existing, data };
}

function freshPasswordCredential(userId: string, passwordVersion: string, privilegedAuth: boolean, existing: ExistingCredential, rememberDevice = false) {
  const fresh = newDeviceCredential(userId);
  const accountIds = [...new Set([userId, ...(existing ? rememberedAccountIds(existing.data) : [])])].slice(0, 8);
  const grants = existing ? rememberedLogins(existing.data).filter((entry) => entry.userId !== userId && accountIds.includes(entry.userId)) : [];
  if (rememberDevice && !privilegedAuth) grants.unshift({ userId, passwordVersion, expiresAtMs: Date.now() + REMEMBERED_LOGIN_MS });
  return { ...fresh, create: true, data: {
    ...fresh.data, accountIds, rememberedLogins: grants, activePasswordVersion: passwordVersion, privilegedAuth,
  } };
}

function revokePrevious(transaction: FirebaseFirestore.Transaction, existing: ExistingCredential) {
  if (existing) transaction.update(existing.ref, { revokedAt: new Date(), activeUserId: null, activePasswordVersion: null, privilegedAuth: false });
}

function matchesSavedRecovery(member: FirebaseFirestore.DocumentData, cleanCode: string) {
  return cleanCode.length === 16 && Boolean(member.recoveryCodeSalt && member.recoveryCodeHash &&
    secureHexEqual(recoveryHash(cleanCode, member.recoveryCodeSalt), member.recoveryCodeHash));
}

function matchesClaim(member: FirebaseFirestore.DocumentData, cleanCode: string, enforceExpiry: boolean) {
  const created = storedDate(member.claimCodeCreatedAt)?.getTime() ?? 0;
  return cleanCode.length === 16 && (!enforceExpiry || (created > Date.now() - CHALLENGE_LIFETIME && created <= Date.now())) &&
    Boolean(member.claimCodeSalt && member.claimCodeHash && secureHexEqual(recoveryHash(cleanCode, member.claimCodeSalt), member.claimCodeHash));
}

export async function loginWithPassword(inputAccountName: string, value: unknown, code: string, existingToken?: string | null, clientIp?: string, rememberDevice = false) {
  const accountName = validatedAccountName(inputAccountName);
  const password = passwordInput(value);
  if (!password) throw new Error(PASSWORD_FAILURE);
  await limitPasswordAttempts(accountName, "login", clientIp);
  const db = getAdminFirestore();
  const reservation = (await db.collection("memberNames").doc(memberNameId(accountName)).get()).data();
  const memberId = reservation?.nameKey === memberNameKey(accountName) ? reservation.memberId : null;
  const ref = typeof memberId === "string" ? db.collection("members").doc(memberId) : null;
  const member = (await ref?.get())?.data();
  const passwordCorrect = await verifyPassword(password, member);
  if (!ref || !member || !passwordCorrect || !member.passwordVersion || memberNameKey(memberAccountName(member)) !== memberNameKey(accountName)) throw new Error(PASSWORD_FAILURE);

  // Privileged accounts retain the stronger legacy credential as an extra check.
  const admin = member.role === "ADMIN";
  if (admin && !matchesSavedRecovery(member, normalizedCode(code))) throw new Error("幹部登入還需要有效的復原碼");
  const existing = await credentialForToken(existingToken);
  const credential = await db.runTransaction(async (transaction) => {
    const fresh = (await transaction.get(ref)).data();
    if (!fresh || fresh.passwordVersion !== member.passwordVersion || fresh.role !== member.role ||
      (admin && fresh.recoveryCodeHash !== member.recoveryCodeHash)) throw new Error("帳號已變更，請重新登入");
    const previous = await liveCredential(transaction, existing);
    const credential = freshPasswordCredential(ref.id, member.passwordVersion, admin, previous, rememberDevice);
    transaction.create(credential.ref, credential.data);
    revokePrevious(transaction, previous);
    return credential;
  });
  return { token: credential.token, viewer: viewerFromMember(ref.id, member) };
}

export async function setPasswordWithCode(inputAccountName: string, value: unknown, code: string, existingToken?: string | null, clientIp?: string, rememberDevice = false) {
  const accountName = validatedAccountName(inputAccountName);
  const cleanCode = normalizedCode(code);
  if (cleanCode.length !== 16) throw new Error(CODE_FAILURE);
  await limitPasswordAttempts(accountName, "code", clientIp);
  const db = getAdminFirestore();
  // Establish the account first, then recheck the same proof in the atomic write.
  const candidate = await db.runTransaction((transaction) => readMemberName(transaction, db, accountName));
  const member = candidate.member?.data();
  const validCode = (data: FirebaseFirestore.DocumentData) =>
    matchesClaim(data, cleanCode, Boolean(data.passwordVersion)) || matchesSavedRecovery(data, cleanCode);
  if (!candidate.member || !member || !validCode(member)) throw new Error(CODE_FAILURE);

  const passwordRecord = await makePassword(value);
  const existing = await credentialForToken(existingToken);
  const nextRecovery = member.role === "ADMIN" ? createClaimCodeRecord() : null;
  const now = new Date();
  const updated = await db.runTransaction(async (transaction) => {
    const claim = await readMemberName(transaction, db, accountName);
    const current = claim.member?.data();
    if (!claim.member || claim.member.id !== candidate.member!.id || !current || current.role !== member.role || !validCode(current)) throw new Error(CODE_FAILURE);
    const previous = await liveCredential(transaction, existing);
    reserveMemberName(transaction, claim, claim.member.id, now);
    const updatedMember = {
      ...passwordRecord, accountName: memberAccountName(current), accountNameKey: claim.nameKey,
      accountType: current.accountType === "verified" ? "verified" : "recoverable", updatedAt: now,
    };
    transaction.update(claim.member.ref, {
      ...updatedMember,
      claimCodeSalt: FieldValue.delete(), claimCodeHash: FieldValue.delete(), claimCodeCreatedAt: FieldValue.delete(),
      recoveryCodeSalt: nextRecovery?.salt ?? FieldValue.delete(),
      recoveryCodeHash: nextRecovery?.hash ?? FieldValue.delete(),
      recoveryCodeCreatedAt: nextRecovery ? now : FieldValue.delete(),
    });
    const credential = freshPasswordCredential(claim.member.id, passwordRecord.passwordVersion, current.role === "ADMIN", previous, rememberDevice);
    transaction.create(credential.ref, credential.data);
    revokePrevious(transaction, previous);
    return { token: credential.token, viewer: viewerFromMember(claim.member.id, { ...current, ...updatedMember, recoveryCodeHash: nextRecovery?.hash }) };
  });
  return { ...updated, recoveryCode: nextRecovery?.code };
}
