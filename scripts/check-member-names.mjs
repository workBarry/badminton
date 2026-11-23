import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import nextEnv from "@next/env";
import { memberAccountName, memberNameKey, validatedAccountName, validatedDisplayName } from "../src/lib/member-names.mjs";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

if (process.argv.includes("--write")) {
  throw new Error("This audit is read-only; --write is not supported.");
}

const projectId = required("FIREBASE_PROJECT_ID");
const clientEmail = required("FIREBASE_CLIENT_EMAIL");
const privateKey = required("FIREBASE_PRIVATE_KEY").replace(/^['"]|['"]$/g, "").replace(/\\n/g, "\n");
const databaseId = process.env.FIREBASE_DATABASE_ID?.trim() || "(default)";
const app = getApps()[0] ?? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
const firestore = databaseId === "(default)" ? getFirestore(app) : getFirestore(app, databaseId);

const snapshot = await firestore.collection("members").get();
const groups = new Map();
const displayGroups = new Map();
const invalidNames = [];
const invalidDisplayNames = [];
const pendingBackfills = [];
const accountNameKeyMismatches = [];
let normalizedMembers = 0;
for (const document of snapshot.docs) {
  const member = document.data();
  const accountName = memberAccountName(member);
  const displayName = String(member.displayName ?? "");
  const missingAccountName = !Object.prototype.hasOwnProperty.call(member, "accountName");
  const missingAccountNameKey = !Object.prototype.hasOwnProperty.call(member, "accountNameKey");
  let invalidReason;
  try {
    validatedAccountName(accountName);
  } catch (error) {
    invalidReason = error.message;
  }
  let nameKey = "";
  try {
    // Normalize fixed account names separately from validation so duplicate
    // legacy accounts are visible even when their spelling is now invalid.
    nameKey = memberNameKey(accountName);
    if (nameKey) {
      const members = groups.get(nameKey) ?? [];
      members.push({ id: document.id, accountName, displayName });
      groups.set(nameKey, members);
      normalizedMembers += 1;
    }
  } catch (error) {
    invalidReason ??= error.message;
  }
  if (invalidReason) invalidNames.push({ id: document.id, accountName, displayName, reason: invalidReason });
  if (missingAccountName || missingAccountNameKey) {
    // A reviewable proposal only: this audit never writes account fields or
    // changes primaryAdmin, roles, credentials, or name reservations.
    pendingBackfills.push({
      id: document.id,
      accountName,
      accountNameKey: nameKey,
      missingFields: [
        ...(missingAccountName ? ["accountName"] : []),
        ...(missingAccountNameKey ? ["accountNameKey"] : []),
      ],
      invalidReason: invalidReason ?? null,
    });
  }
  if (!missingAccountNameKey && member.accountNameKey !== nameKey) {
    accountNameKeyMismatches.push({ id: document.id, accountName, storedKey: member.accountNameKey, expectedKey: nameKey });
  }
  try {
    validatedDisplayName(member.displayName);
  } catch (error) {
    invalidDisplayNames.push({ id: document.id, displayName, reason: error.message });
  }
  const displayKey = memberNameKey(member.displayName);
  if (displayKey) {
    const members = displayGroups.get(displayKey) ?? [];
    members.push({ id: document.id, accountName, displayName });
    displayGroups.set(displayKey, members);
  }
}

const duplicateGroups = [...groups.entries()]
  .filter(([, members]) => members.length > 1)
  .map(([nameKey, members]) => ({ nameKey, count: members.length, members }))
  .sort((left, right) => left.nameKey.localeCompare(right.nameKey));

// Duplicate display names are allowed and are informational only.
const duplicateDisplayGroups = [...displayGroups.entries()]
  .filter(([, members]) => members.length > 1)
  .map(([displayNameKey, members]) => ({ displayNameKey, count: members.length, members }))
  .sort((left, right) => left.displayNameKey.localeCompare(right.displayNameKey));
const duplicateKeys = new Set(duplicateGroups.map((group) => group.nameKey));
const mismatchedKeyIds = new Set(accountNameKeyMismatches.map((member) => member.id));
for (const candidate of pendingBackfills) {
  candidate.blocked = Boolean(candidate.invalidReason) || duplicateKeys.has(candidate.accountNameKey)
    || mismatchedKeyIds.has(candidate.id);
}
const readyForStrictAccountFields = pendingBackfills.length === 0
  && duplicateGroups.length === 0 && invalidNames.length === 0 && accountNameKeyMismatches.length === 0;

console.log(JSON.stringify({
  mode: "check",
  writes: 0,
  databaseId,
  readyForStrictAccountFields,
  counts: {
    members: snapshot.size,
    normalizedMembers,
    uniqueNameKeys: groups.size,
    duplicateGroups: duplicateGroups.length,
    membersInDuplicateGroups: duplicateGroups.reduce((total, group) => total + group.count, 0),
    invalidNames: invalidNames.length,
    missingAccountNames: pendingBackfills.filter((member) => member.missingFields.includes("accountName")).length,
    missingAccountNameKeys: pendingBackfills.filter((member) => member.missingFields.includes("accountNameKey")).length,
    accountNameKeyMismatches: accountNameKeyMismatches.length,
    duplicateDisplayGroups: duplicateDisplayGroups.length,
    invalidDisplayNames: invalidDisplayNames.length,
  },
  duplicateGroups,
  invalidNames,
  pendingBackfills,
  accountNameKeyMismatches,
  duplicateDisplayGroups,
  invalidDisplayNames,
}, null, 2));
if (!readyForStrictAccountFields || invalidDisplayNames.length > 0) process.exitCode = 1;
