import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`尚未設定 ${name}`);
  return value;
}

export function getAdminFirestore() {
  const projectId = requiredEnvironment("FIREBASE_PROJECT_ID");
  const clientEmail = requiredEnvironment("FIREBASE_CLIENT_EMAIL");
  const privateKey = requiredEnvironment("FIREBASE_PRIVATE_KEY")
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\n/g, "\n");
  const databaseId = process.env.FIREBASE_DATABASE_ID?.trim() || "(default)";

  const app = getApps()[0] ?? initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    projectId,
  });

  return databaseId === "(default)" ? getFirestore(app) : getFirestore(app, databaseId);
}
