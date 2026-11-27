import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };
const DUMMY_SALT = "00000000000000000000000000000000";
const DUMMY_HASH = Buffer.alloc(32);
const HEX_SALT = /^[a-f0-9]{32}$/;
const HEX_HASH = /^[a-f0-9]{64}$/;

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, OPTIONS, (error, key) => error ? reject(error) : resolve(key));
  });
}

export function passwordInput(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
  return value;
}

export async function makePassword(value: unknown) {
  const password = passwordInput(value);
  if (!password || Array.from(password).length < 8 || !password.trim()) throw new Error("請輸入 8 至 128 個字元的密碼");
  const passwordSalt = randomBytes(16).toString("hex");
  return { passwordSalt, passwordHash: (await derive(password, passwordSalt)).toString("hex"), passwordVersion: randomBytes(16).toString("hex") };
}

export async function verifyPassword(password: string, member?: { passwordSalt?: unknown; passwordHash?: unknown }) {
  const salt = String(member?.passwordSalt ?? "");
  const hash = String(member?.passwordHash ?? "");
  const valid = HEX_SALT.test(salt) && HEX_HASH.test(hash);
  const actual = await derive(password, valid ? salt : DUMMY_SALT);
  return timingSafeEqual(actual, valid ? Buffer.from(hash, "hex") : DUMMY_HASH) && valid;
}
