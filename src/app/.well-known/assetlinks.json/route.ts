import { PASSKEY_ANDROID_PACKAGE, passkeyRelyingParty } from "@/lib/passkey-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  let fingerprints: string[];
  try {
    fingerprints = passkeyRelyingParty(new URL(request.url).origin).androidFingerprints;
  } catch {
    fingerprints = [];
  }
  if (!fingerprints.length) {
    return Response.json([], { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json([{
    relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
    target: {
      namespace: "android_app",
      package_name: PASSKEY_ANDROID_PACKAGE,
      sha256_cert_fingerprints: fingerprints,
    },
  }], { headers: { "Cache-Control": "public, max-age=300" } });
}
