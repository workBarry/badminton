import { NextRequest, NextResponse } from "next/server";
import {
  createGuestDeviceAccount,
  createRecoveryCode,
  DEVICE_COOKIE,
  DEVICE_SESSION_MAX_AGE,
  loginWithRecoveryOrClaimCode,
  revokeDeviceToken,
  viewerForDeviceToken,
} from "@/lib/device-auth";
import { mutate, readState } from "@/lib/firestore-database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sessionCookie(token: string) {
  return {
    name: DEVICE_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: DEVICE_SESSION_MAX_AGE,
  };
}

function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) throw new Error("不允許跨網站送出操作");
}

export async function GET(request: NextRequest) {
  const viewer = await viewerForDeviceToken(request.cookies.get(DEVICE_COOKIE)?.value);
  return NextResponse.json(await readState(viewer));
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = await request.json() as { action?: string } & Record<string, string>;
    if (!body.action) return NextResponse.json({ error: "缺少操作類型" }, { status: 400 });
    const currentToken = request.cookies.get(DEVICE_COOKIE)?.value;
    const viewer = await viewerForDeviceToken(currentToken);

    if (body.action === "createGuest") {
      const account = await createGuestDeviceAccount(body.name ?? "");
      const response = NextResponse.json(await readState(account.viewer));
      response.cookies.set(sessionCookie(account.token));
      return response;
    }

    if (body.action === "recover") {
      const account = await loginWithRecoveryOrClaimCode(body.name ?? "", body.code ?? "");
      const response = NextResponse.json({ ...(await readState(account.viewer)), actionResult: { recoveryCode: account.recoveryCode } });
      response.cookies.set(sessionCookie(account.token));
      return response;
    }

    if (body.action === "logout") {
      await revokeDeviceToken(currentToken);
      const response = NextResponse.json(await readState(null));
      response.cookies.set({ ...sessionCookie(""), maxAge: 0 });
      return response;
    }

    if (!viewer) return NextResponse.json({ error: "登入已失效，請重新登入" }, { status: 401 });

    if (body.action === "createRecoveryCode") {
      const recoveryCode = await createRecoveryCode(viewer.id);
      const refreshedViewer = await viewerForDeviceToken(currentToken);
      return NextResponse.json({ ...(await readState(refreshedViewer)), actionResult: { recoveryCode } });
    }

    const actionResult = await mutate(body.action, body, viewer);
    return NextResponse.json({ ...(await readState(viewer)), ...(actionResult ? { actionResult } : {}) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "資料庫操作失敗" }, { status: 400 });
  }
}
