import { isIP } from "node:net";
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
  loginWithPassword,
  revokeDeviceToken,
  setPasswordWithCode,
  type Viewer,
  viewerForDeviceToken,
} from "@/lib/device-auth";
import { mutate, readState } from "@/lib/firestore-database";
import { BalanceHistoryError, readMemberBalanceHistory } from "@/lib/member-balance-history";

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
  const historyMemberId = request.nextUrl.searchParams.get("balanceHistoryMemberId");
  if (historyMemberId !== null) {
    const headers = { "Cache-Control": "private, no-store" };
    try {
      const viewer = await viewerForDeviceToken(token);
      return NextResponse.json(await readMemberBalanceHistory(historyMemberId, viewer), { headers });
    } catch (error) {
      const status = error instanceof BalanceHistoryError ? error.status : 500;
      const message = error instanceof BalanceHistoryError ? error.message : "讀取餘額紀錄失敗，請稍後再試";
      return NextResponse.json({ error: message }, { status, headers });
    }
  }
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

    if (body.action === "registerPassword" || body.action === "loginPassword" || body.action === "setPasswordWithCode") {
      if (typeof body.accountName !== "string" || body.accountName.length > 120 ||
        typeof body.password !== "string" || body.password.length > 128 ||
        (body.code !== undefined && (typeof body.code !== "string" || body.code.length > 32))) {
        return NextResponse.json({ error: "請確認帳號、密碼或設定碼格式" }, { status: 400 });
      }
      const forwarded = process.env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for")?.trim() : undefined;
      const clientIp = forwarded && isIP(forwarded) ? forwarded : undefined;
      const rememberDevice = body.rememberDevice === "true";
      const account = body.action === "registerPassword"
        ? await createGuestDeviceAccount(body.accountName, currentToken, undefined, body.password, clientIp, rememberDevice)
        : body.action === "loginPassword"
          ? await loginWithPassword(body.accountName, body.password, body.code ?? "", currentToken, clientIp, rememberDevice)
          : await setPasswordWithCode(body.accountName, body.password, body.code ?? "", currentToken, clientIp, rememberDevice);
      const recoveryCode = "recoveryCode" in account ? account.recoveryCode : undefined;
      const response = NextResponse.json({
        ...(await stateForDevice(account.token, account.viewer)),
        ...(recoveryCode ? { actionResult: { recoveryCode } } : {}),
      }, { headers: { "Cache-Control": "private, no-store" } });
      response.cookies.set(sessionCookie(account.token));
      return response;
    }

    if (body.action === "createGuest") {
      const account = await createGuestDeviceAccount(body.accountName ?? body.name ?? "", currentToken, body.displayName);
      const response = NextResponse.json(await stateForDevice(account.token, account.viewer));
      response.cookies.set(sessionCookie(account.token));
      return response;
    }

    if (body.action === "recover") {
      const account = await loginWithRecoveryOrClaimCode(body.accountName ?? body.name ?? "", body.code ?? "", currentToken);
      const response = NextResponse.json({ ...(await stateForDevice(account.token, account.viewer)), actionResult: { recoveryCode: account.recoveryCode } });
      response.cookies.set(sessionCookie(account.token));
      return response;
    }

    if (body.action === "logout") {
      if (body.forgetDevice === "true") {
        await revokeDeviceToken(currentToken);
        const response = NextResponse.json(await stateForDevice(null, null), { headers: { "Cache-Control": "private, no-store" } });
        response.cookies.set({ ...sessionCookie(""), maxAge: 0 });
        return response;
      }
      await deactivateDeviceToken(currentToken);
      return NextResponse.json(await stateForDevice(currentToken, null));
    }

    if (body.action === "quickLogin") {
      const quickViewer = await activateDeviceAccount(currentToken, body.userId ?? "");
      const response = NextResponse.json(await stateForDevice(currentToken, quickViewer), { headers: { "Cache-Control": "private, no-store" } });
      if (currentToken) response.cookies.set(sessionCookie(currentToken));
      return response;
    }

    if (!viewer) return NextResponse.json({ error: "登入已失效，請重新登入" }, { status: 401 });

    if (body.action === "createRecoveryCode") {
      const recoveryCode = await createRecoveryCode(viewer.id, currentToken);
      const refreshedViewer = await viewerForDeviceToken(currentToken);
      return NextResponse.json({ ...(await stateForDevice(currentToken, refreshedViewer)), actionResult: { recoveryCode } });
    }

    const actionResult = await mutate(body.action, body, viewer);
    if (body.action === "previewCancelEvent" || body.action === "previewQuarterlyInvoices" || body.action === "previewMemberExtraBills" || body.action === "previewGuestEventBills" || body.action === "previewCalendarQuarter") {
      return NextResponse.json({ actionResult }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const refreshedViewer = await viewerForDeviceToken(currentToken);
    return NextResponse.json({ ...(await stateForDevice(currentToken, refreshedViewer)), ...(actionResult ? { actionResult } : {}) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "資料庫操作失敗" }, { status: 400 });
  }
}
