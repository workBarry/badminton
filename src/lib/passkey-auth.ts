import { randomUUID } from "crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { FieldValue } from "firebase-admin/firestore";
import { createDeviceSessionForUser, type Viewer } from "@/lib/device-auth";
import { getAdminFirestore } from "@/lib/firebase-admin";

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const RP_NAME = "公司羽球社";

type RelyingParty = { rpID: string; origin: string };
type ChallengeKind = "REGISTER" | "AUTHENTICATE";

function challengeExpiry(value: FirebaseFirestore.DocumentData) {
  return value.expiresAt?.toDate?.() as Date | undefined;
}

function assertChallenge(
  document: FirebaseFirestore.DocumentSnapshot,
  kind: ChallengeKind,
  relyingParty: RelyingParty,
  userId?: string,
) {
  if (!document.exists) throw new Error("Passkey 操作已逾時，請重新嘗試");
  const challenge = document.data()!;
  if (challenge.kind !== kind || challenge.usedAt) throw new Error("Passkey 操作已失效，請重新嘗試");
  if (challenge.rpID !== relyingParty.rpID || challenge.origin !== relyingParty.origin) throw new Error("Passkey 網站來源不一致");
  if (userId && challenge.userId !== userId) throw new Error("Passkey 操作不屬於目前帳號");
  const expiresAt = challengeExpiry(challenge);
  if (!expiresAt || expiresAt <= new Date()) throw new Error("Passkey 操作已逾時，請重新嘗試");
  return challenge;
}

async function saveChallenge(kind: ChallengeKind, challenge: string, relyingParty: RelyingParty, userId?: string) {
  const id = randomUUID();
  const now = new Date();
  await getAdminFirestore().collection("passkeyChallenges").doc(id).create({
    id,
    kind,
    challenge,
    userId: userId ?? null,
    rpID: relyingParty.rpID,
    origin: relyingParty.origin,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CHALLENGE_LIFETIME_MS),
    usedAt: null,
  });
  return id;
}

export async function registrationOptions(viewer: Viewer, relyingParty: RelyingParty) {
  const db = getAdminFirestore();
  const credentials = await db.collection("passkeys").where("userId", "==", viewer.id).get();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: relyingParty.rpID,
    userID: new TextEncoder().encode(viewer.id),
    userName: viewer.name,
    userDisplayName: viewer.name,
    attestationType: "none",
    excludeCredentials: credentials.docs.map((document) => ({
      id: document.id,
      transports: document.data().transports ?? [],
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const challengeId = await saveChallenge("REGISTER", options.challenge, relyingParty, viewer.id);
  return { options, challengeId };
}

export async function verifyRegistration(
  viewer: Viewer,
  challengeId: string,
  response: RegistrationResponseJSON,
  relyingParty: RelyingParty,
) {
  const db = getAdminFirestore();
  const challengeRef = db.collection("passkeyChallenges").doc(challengeId);
  const challengeSnapshot = await challengeRef.get();
  const challenge = assertChallenge(challengeSnapshot, "REGISTER", relyingParty, viewer.id);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: String(challenge.challenge),
    expectedOrigin: relyingParty.origin,
    expectedRPID: relyingParty.rpID,
    requireUserVerification: true,
  });
  if (!verification.verified) throw new Error("Passkey 驗證失敗");

  const { credential, credentialBackedUp, credentialDeviceType } = verification.registrationInfo;
  const passkeyRef = db.collection("passkeys").doc(credential.id);
  const memberRef = db.collection("members").doc(viewer.id);
  const now = new Date();
  await db.runTransaction(async (transaction) => {
    const [freshChallenge, existingPasskey, member] = await transaction.getAll(challengeRef, passkeyRef, memberRef);
    assertChallenge(freshChallenge, "REGISTER", relyingParty, viewer.id);
    if (existingPasskey.exists) throw new Error("這組 Passkey 已經註冊");
    if (!member.exists) throw new Error("找不到使用者");
    transaction.create(passkeyRef, {
      id: credential.id,
      userId: viewer.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64"),
      counter: credential.counter,
      transports: response.response.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      createdAt: now,
      lastUsedAt: null,
    });
    transaction.update(memberRef, {
      accountType: "verified",
      passkeyCount: FieldValue.increment(1),
      updatedAt: now,
    });
    transaction.delete(challengeRef);
  });
}

export async function authenticationOptions(relyingParty: RelyingParty) {
  const options = await generateAuthenticationOptions({
    rpID: relyingParty.rpID,
    allowCredentials: [],
    userVerification: "required",
  });
  const challengeId = await saveChallenge("AUTHENTICATE", options.challenge, relyingParty);
  return { options, challengeId };
}

export async function verifyAuthentication(
  challengeId: string,
  response: AuthenticationResponseJSON,
  relyingParty: RelyingParty,
  existingDeviceToken?: string | null,
) {
  const db = getAdminFirestore();
  const challengeRef = db.collection("passkeyChallenges").doc(challengeId);
  const passkeyRef = db.collection("passkeys").doc(response.id);
  const [challengeSnapshot, passkeySnapshot] = await Promise.all([challengeRef.get(), passkeyRef.get()]);
  const challenge = assertChallenge(challengeSnapshot, "AUTHENTICATE", relyingParty);
  if (!passkeySnapshot.exists) throw new Error("找不到這組 Passkey");
  const passkey = passkeySnapshot.data()!;
  const storedCounter = Number(passkey.counter ?? 0);
  const credential: WebAuthnCredential = {
    id: passkeySnapshot.id,
    publicKey: new Uint8Array(Buffer.from(String(passkey.publicKey), "base64")),
    counter: storedCounter,
    transports: passkey.transports ?? [],
  };
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: String(challenge.challenge),
    expectedOrigin: relyingParty.origin,
    expectedRPID: relyingParty.rpID,
    credential,
    requireUserVerification: true,
  });
  if (!verification.verified) throw new Error("Passkey 驗證失敗");

  const now = new Date();
  await db.runTransaction(async (transaction) => {
    const [freshChallenge, freshPasskey] = await transaction.getAll(challengeRef, passkeyRef);
    assertChallenge(freshChallenge, "AUTHENTICATE", relyingParty);
    if (!freshPasskey.exists || Number(freshPasskey.data()?.counter ?? 0) !== storedCounter) {
      throw new Error("Passkey 狀態已變更，請重新嘗試");
    }
    transaction.update(passkeyRef, {
      counter: verification.authenticationInfo.newCounter,
      backedUp: verification.authenticationInfo.credentialBackedUp,
      deviceType: verification.authenticationInfo.credentialDeviceType,
      lastUsedAt: now,
    });
    transaction.delete(challengeRef);
  });
  return createDeviceSessionForUser(String(passkey.userId), existingDeviceToken);
}
