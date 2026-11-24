export type PasskeyRelyingParty = {
  rpID: string;
  origin: string;
  expectedOrigins: string[];
  androidFingerprints: string[];
};

export const PASSKEY_ANDROID_PACKAGE = "com.badminton.app";
const SHA256_FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function passkeyRelyingParty(requestOrigin: string): PasskeyRelyingParty {
  const configuredOrigin = process.env.PASSKEY_ORIGIN?.trim().replace(/\/$/, "");
  if (configuredOrigin && configuredOrigin !== requestOrigin) {
    throw new Error(`Passkey 只能在 ${configuredOrigin} 使用`);
  }
  const origin = configuredOrigin || requestOrigin;
  const url = new URL(origin);
  const rpID = process.env.PASSKEY_RP_ID?.trim() || url.hostname;
  if (url.hostname !== rpID && !url.hostname.endsWith(`.${rpID}`)) {
    throw new Error("PASSKEY_RP_ID 與網站網域不相符");
  }

  const expectedOrigins = [origin];
  const androidFingerprints: string[] = [];
  if (configuredOrigin && url.protocol === "https:" && !url.port && url.hostname === rpID) {
    const configuredFingerprints = process.env.PASSKEY_ANDROID_SHA256_FINGERPRINTS?.trim();
    const fingerprints = configuredFingerprints?.split(",").map((value) => value.trim().toUpperCase());
    if (fingerprints?.every((value) => SHA256_FINGERPRINT.test(value))) {
      androidFingerprints.push(...new Set(fingerprints));
      for (const fingerprint of androidFingerprints) {
        const hash = Buffer.from(fingerprint.replaceAll(":", ""), "hex").toString("base64url");
        expectedOrigins.push(`android:apk-key-hash:${hash}`);
      }
    }
  }
  return { rpID, origin, expectedOrigins, androidFingerprints };
}
