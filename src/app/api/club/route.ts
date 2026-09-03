import { NextRequest, NextResponse } from "next/server";
import {
  activateDeviceAccount,
  createGuestDeviceAccount,
  createRecoveryCode,
  deactivateDeviceToken,
  DEVICE_COOKIE,
  DEVICE_SESSION_MAX_AGE,
  deviceAccountsForToken,
  loginWithRecoveryOrClaimCode,
  type Viewer,
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

async function stateForDevice(token: string | null | undefined, viewer: Viewer | null) {
  const [state, quickAccounts] = await Promise.all([readState(viewer), deviceAccountsForToken(token)]);
  return { ...state, quickAccounts };
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get(DEVICE_COOKIE)?.value;
  const viewer = await viewerForDeviceToken(token);
  return NextResponse.json(await stateForDevice(token, viewer));
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = await request.json() as { action?: string } & Record<string, string>;
    if (!body.action) return NextResponse.json({ error: "缺少操作類型" }, { status: 400 });
    const currentToken = request.cookies.get(DEVICE_COOKIE)?.value;
    const viewer = await viewerForDeviceToken(currentToken);

    if (body.action === "createGuest") {
      const account = await createGuestDeviceAccount(body.name ?? "", currentToken);
      const response = NextResponse.json(await stateForDevice(account.token, account.viewer));
      response.cookies.set(sessionCookie(account.token));
      return response;
    }

    if (body.action === "recover") {
      const account = await loginWithRecoveryOrClaimCode(body.name ?? "", body.code ?? "", currentToken);
      const response = NextResponse.json({ ...(await stateForDevice(account.token, account.viewer)), actionResult: { recoveryCode: account.recoveryCode } });
      response.cookies.set(sessionCookie(account.token));
      return response;
    }

    if (body.action === "logout") {
      await deactivateDeviceToken(currentToken);
      return NextResponse.json(await stateForDevice(currentToken, null));
    }

    if (body.action === "quickLogin") {
      const quickViewer = await activateDeviceAccount(currentToken, body.userId ?? "");
      const response = NextResponse.json(await stateForDevice(currentToken, quickViewer));
      if (currentToken) response.cookies.set(sessionCookie(currentToken));
      return response;
    }

    if (!viewer) return NextResponse.json({ error: "登入已失效，請重新登入" }, { status: 401 });

    if (body.action === "createRecoveryCode") {
      const recoveryCode = await createRecoveryCode(viewer.id);
      const refreshedViewer = await viewerForDeviceToken(currentToken);
      return NextResponse.json({ ...(await stateForDevice(currentToken, refreshedViewer)), actionResult: { recoveryCode } });
    }

    const actionResult = await mutate(body.action, body, viewer);
    return NextResponse.json({ ...(await stateForDevice(currentToken, viewer)), ...(actionResult ? { actionResult } : {}) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "資料庫操作失敗" }, { status: 400 });
  }
}
