/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const site = "https://badminton.example";
const assetPath = "/.well-known/assetlinks.json";
const appCertificate = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const fingerprint = appCertificate.toString("hex").match(/../g).join(":").toUpperCase();
const androidOrigin = "android:apk-key-hash:" + appCertificate.toString("base64url");

function loadWithEnv(relativePath, env, imports = {}) {
  const filename = path.resolve(__dirname, "..", relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = { exports: {} };
  new Function("require", "module", "exports", "process", outputText)(
    (id) => (Object.hasOwn(imports, id) ? imports[id] : require(id)),
    loaded,
    loaded.exports,
    { env },
  );
  return loaded.exports;
}

function setup(env) {
  const config = loadWithEnv("src/lib/passkey-config.ts", env);
  const { GET } = loadWithEnv("src/app/.well-known/assetlinks.json/route.ts", env, {
    "@/lib/passkey-config": config,
  });
  return {
    relyingParty: config.passkeyRelyingParty,
    getAssetLinks: (origin = site) => GET(new Request(origin + assetPath)),
  };
}

test("Android origin and Digital Asset Links share the trusted APK certificate", async () => {
  const { relyingParty, getAssetLinks } = setup({
    PASSKEY_ORIGIN: site,
    PASSKEY_RP_ID: "badminton.example",
    PASSKEY_ANDROID_SHA256_FINGERPRINTS: fingerprint,
  });
  const config = relyingParty(site);
  assert.equal(config.rpID, "badminton.example");
  assert.equal(config.origin, site);
  assert.deepEqual(config.expectedOrigins, [site, androidOrigin]);

  const response = await getAssetLinks();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json\b/);
  assert.equal(response.headers.has("location"), false);
  assert.deepEqual(await response.json(), [{
    relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
    target: {
      namespace: "android_app",
      package_name: "com.badminton.app",
      sha256_cert_fingerprints: [fingerprint],
    },
  }]);
});

test("browser Passkeys work with no eligible Android association", async () => {
  for (const [origin, env] of [
    [site, {}],
    [site, { PASSKEY_ANDROID_SHA256_FINGERPRINTS: fingerprint }],
    [site, { PASSKEY_ORIGIN: site }],
    [site, { PASSKEY_ORIGIN: site, PASSKEY_ANDROID_SHA256_FINGERPRINTS: fingerprint + ",*" }],
    ["https://signin.badminton.example", {
      PASSKEY_ORIGIN: "https://signin.badminton.example",
      PASSKEY_RP_ID: "badminton.example",
      PASSKEY_ANDROID_SHA256_FINGERPRINTS: fingerprint,
    }],
    ["https://badminton.example:8443", {
      PASSKEY_ORIGIN: "https://badminton.example:8443",
      PASSKEY_ANDROID_SHA256_FINGERPRINTS: fingerprint,
    }],
    ["http://localhost:3000", {
      PASSKEY_ORIGIN: "http://localhost:3000",
      PASSKEY_ANDROID_SHA256_FINGERPRINTS: fingerprint,
    }],
  ]) {
    const { relyingParty, getAssetLinks } = setup(env);
    assert.deepEqual(relyingParty(origin).expectedOrigins, [origin]);
    assert.equal((await getAssetLinks(origin)).status, 404);
  }
});

test("deployment aliases never publish an association for a different configured host", async () => {
  const { relyingParty, getAssetLinks } = setup({
    PASSKEY_ORIGIN: site,
    PASSKEY_ANDROID_SHA256_FINGERPRINTS: fingerprint,
  });
  const alias = "https://other-preview.vercel.app";
  assert.throws(() => relyingParty(alias));
  assert.equal((await getAssetLinks(alias)).status, 404);
});
