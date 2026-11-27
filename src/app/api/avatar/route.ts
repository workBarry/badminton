import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import sharp from "sharp";
import { DEVICE_COOKIE, viewerForDeviceToken } from "@/lib/device-auth";
import { getAdminFirestore } from "@/lib/firebase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const MAX_UPLOAD = 1024 * 1024;
const imageTypes = new Map([["image/jpeg", "jpeg"], ["image/png", "png"], ["image/webp", "webp"]]);
const error = (message: string, status: number) => Response.json({ error: message }, { status, headers });

async function readUpload(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > MAX_UPLOAD) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function saveAvatar(request: NextRequest, remove: boolean) {
  if (request.headers.get("origin") !== request.nextUrl.origin) return error("不允許跨網站送出操作", 403);
  try {
    const viewer = await viewerForDeviceToken(request.cookies.get(DEVICE_COOKIE)?.value);
    if (!viewer) return error("登入已失效，請重新登入", 401);
    if (request.headers.get("x-avatar-owner") !== viewer.id) return error("登入的帳號已切換，請重新整理後再試", 409);

    let photo: Buffer | null = null;
    if (!remove) {
      const format = imageTypes.get(request.headers.get("content-type") ?? "");
      if (!format) return error("請選擇 JPG、PNG 或 WebP 圖片", 415);
      if (Number(request.headers.get("content-length")) > MAX_UPLOAD) return error("圖片太大，請換一張", 413);
      const upload = await readUpload(request);
      if (!upload) return error("圖片太大，請換一張", 413);
      try {
        const image = sharp(upload, { limitInputPixels: 512 * 512, failOn: "warning" });
        if ((await image.metadata()).format !== format) return error("圖片格式不符，請換一張", 415);
        photo = await image.rotate().resize(256, 256, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
      } catch {
        return error("無法讀取圖片，請換一張", 422);
      }
    }

    const db = getAdminFirestore();
    const member = db.collection("members").doc(viewer.id);
    const avatar = db.collection("profileAvatars").doc(viewer.id);
    const avatarVersion = photo ? randomUUID() : null;
    await db.runTransaction(async (transaction) => {
      if (!(await transaction.get(member)).exists) throw new Error("Account no longer exists");
      if (photo) transaction.set(avatar, { version: avatarVersion, photo: photo.toString("base64") });
      else transaction.delete(avatar);
      transaction.update(member, { avatarVersion });
    });
    return Response.json({ avatarVersion }, { headers });
  } catch {
    return error("暫時無法儲存頭貼，請稍後再試", 500);
  }
}

export function POST(request: NextRequest) {
  return saveAvatar(request, false);
}

export function DELETE(request: NextRequest) {
  return saveAvatar(request, true);
}

export async function GET(request: NextRequest) {
  const viewer = await viewerForDeviceToken(request.cookies.get(DEVICE_COOKIE)?.value);
  if (!viewer) return error("請先登入", 401);
  const id = request.nextUrl.searchParams.get("memberId");
  const version = request.nextUrl.searchParams.get("v");
  if (!id || !/^[^/\u0000-\u001f]{1,128}$/.test(id) || id === "." || id === ".." || !version ||
    !/^[a-f0-9-]{36}$/.test(version)) return error("找不到頭貼", 404);

  const avatar = (await getAdminFirestore().collection("profileAvatars").doc(id).get()).data();
  if (!avatar || avatar.version !== version || typeof avatar.photo !== "string") return error("找不到頭貼", 404);
  return new Response(new Uint8Array(Buffer.from(avatar.photo, "base64")), {
    headers: { ...headers, "Content-Type": "image/webp", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" },
  });
}
