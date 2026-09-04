import { NextRequest, NextResponse } from "next/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  DEVICE_COOKIE,
  DEVICE_SESSION_MAX_AGE,
  deviceAccountsForToken,
  type Viewer,
  viewerForDeviceToken,
} from "@/lib/device-auth";
import { readState } from "@/lib/firestore-database";
import {
  authenticationOptions,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from "@/lib/passkey-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHALLENGE_COOKIE = "badminton_passkey_challenge";

function cookieBase() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
}

function relyingParty(request: NextRequest) {
  const requestOrigin = request.nextUrl.origin;
  const configuredOrigin = process.env.PASSKEY_ORIGIN?.trim().replace(/\/$/, "");
  const origin = configuredOrigin || requestOrigin;
  if (configuredOrigin && configuredOrigin !== requestOrigin) {
    throw new Error(`Passkey 只能在 ${configuredOrigin} 使用`);
  }
  const rpID = process.env.PASSKEY_RP_ID?.trim() || new URL(origin).hostname;
  const hostname = new URL(origin).hostname;
  if (hostname !== rpID && !hostname.endsWith(`.${rpID}`)) throw new Error("PASSKEY_RP_ID 與網站網域不相符");
  return { rpID, origin };
}

function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) throw new Error("不允許跨網站送出操作");
}

async function stateForDevice(token: string | null | undefined, viewer: Viewer | null) {
  const [state, quickAccounts] = await Promise.all([readState(viewer), deviceAccountsForToken(token)]);
  return { ...state, quickAccounts };
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = await request.json() as {
      action?: string;
      response?: RegistrationResponseJSON | AuthenticationResponseJSON;
    };
    const currentToken = request.cookies.get(DEVICE_COOKIE)?.value;
    const viewer = await viewerForDeviceToken(currentToken);
    const challengeId = request.cookies.get(CHALLENGE_COOKIE)?.value;
    const rp = relyingParty(request);

    if (body.action === "registrationOptions") {
      if (!viewer) return NextResponse.json({ error: "請先登入再建立 Passkey" }, { status: 401 });
      const result = await registrationOptions(viewer, rp);
      const response = NextResponse.json({ options: result.options });
      response.cookies.set({ name: CHALLENGE_COOKIE, value: result.challengeId, maxAge: 5 * 60, ...cookieBase() });
      return response;
    }

    if (body.action === "verifyRegistration") {
      if (!viewer) return NextResponse.json({ error: "登入已失效，請重新登入" }, { status: 401 });
      if (!challengeId || !body.response) throw new Error("Passkey 操作已逾時，請重新嘗試");
      await verifyRegistration(viewer, challengeId, body.response as RegistrationResponseJSON, rp);
      const refreshedViewer = await viewerForDeviceToken(currentToken);
      const response = NextResponse.json(await stateForDevice(currentToken, refreshedViewer));
      response.cookies.set({ name: CHALLENGE_COOKIE, value: "", maxAge: 0, ...cookieBase() });
      return response;
    }

    if (body.action === "authenticationOptions") {
      const result = await authenticationOptions(rp);
      const response = NextResponse.json({ options: result.options });
      response.cookies.set({ name: CHALLENGE_COOKIE, value: result.challengeId, maxAge: 5 * 60, ...cookieBase() });
      return response;
    }

    if (body.action === "verifyAuthentication") {
      if (!challengeId || !body.response) throw new Error("Passkey 操作已逾時，請重新嘗試");
      const account = await verifyAuthentication(challengeId, body.response as AuthenticationResponseJSON, rp, currentToken);
      const response = NextResponse.json(await stateForDevice(account.token, account.viewer));
      response.cookies.set({ name: DEVICE_COOKIE, value: account.token, maxAge: DEVICE_SESSION_MAX_AGE, ...cookieBase() });
      response.cookies.set({ name: CHALLENGE_COOKIE, value: "", maxAge: 0, ...cookieBase() });
      return response;
    }

    return NextResponse.json({ error: "不支援的 Passkey 操作" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Passkey 操作失敗" }, { status: 400 });
  }
}
