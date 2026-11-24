/* eslint-disable @typescript-eslint/no-require-imports */
// Install as tests/account-names.test.cjs. This suite never initializes Firebase.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// A root override permits running this review draft from outside tests/.
// No dotenv file is read; deployed copies normally use the default location.
const projectRoot = process.env.BADMINTON_TEST_ROOT ? path.resolve(process.env.BADMINTON_TEST_ROOT) : path.resolve(__dirname, "..");
const ts = require(require.resolve("typescript", { paths: [projectRoot] }));

class FakeTimestamp {
  constructor(milliseconds) { this.milliseconds = milliseconds; }
  toDate() { return new Date(this.milliseconds); }
  static fromDate(date) { return new FakeTimestamp(date.getTime()); }
  static now() { return FakeTimestamp.fromDate(new Date()); }
}

function copy(value, timestamps = false) {
  if (value instanceof Date) return timestamps ? FakeTimestamp.fromDate(value) : new Date(value);
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value.milliseconds);
  if (Array.isArray(value)) return value.map((item) => copy(item, timestamps));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item, timestamps)]));
  return value;
}

const FieldValue = {
  arrayUnion: (...values) => ({ __operation: "arrayUnion", values }),
  arrayRemove: (...values) => ({ __operation: "arrayRemove", values }),
  increment: (amount) => ({ __operation: "increment", amount }),
  delete: () => ({ __operation: "delete" }),
  serverTimestamp: () => ({ __operation: "serverTimestamp" }),
};

function equivalent(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function applyValues(current, values) {
  const result = copy(current || {});
  for (const [key, value] of Object.entries(values)) {
    if (value?.__operation === "delete") delete result[key];
    else if (value?.__operation === "increment") result[key] = Number(result[key] || 0) + value.amount;
    else if (value?.__operation === "serverTimestamp") result[key] = new Date();
    else if (value?.__operation === "arrayUnion") {
      result[key] = copy(result[key] || []);
      for (const item of value.values) if (!result[key].some((old) => equivalent(old, item))) result[key].push(copy(item));
    } else if (value?.__operation === "arrayRemove") {
      result[key] = (result[key] || []).filter((item) => !value.values.some((removed) => equivalent(item, removed)));
    } else result[key] = copy(value);
  }
  return result;
}

class DocRef {
  constructor(db, documentPath) {
    this.firestore = db;
    this.path = documentPath;
    this.id = documentPath.split("/").at(-1);
  }
  collection(name) { return new Query(this.firestore, `${this.path}/${name}`); }
  get() { return Promise.resolve(this.firestore.snapshot(this, this.firestore.store)); }
  create(data) { return this.firestore.commit([{ type: "create", ref: this, data }]); }
  set(data, options) { return this.firestore.commit([{ type: "set", ref: this, data, options }]); }
  update(data) { return this.firestore.commit([{ type: "update", ref: this, data }]); }
  delete() { return this.firestore.commit([{ type: "delete", ref: this }]); }
  isEqual(other) { return this.firestore === other.firestore && this.path === other.path; }
}

class Query {
  constructor(db, collectionPath, filters = [], maximum = Infinity, ordering = []) {
    this.firestore = db;
    this.path = collectionPath;
    this.id = collectionPath.split("/").at(-1);
    this.filters = filters;
    this.maximum = maximum;
    this.ordering = ordering;
  }
  doc(id = require("node:crypto").randomUUID()) { return new DocRef(this.firestore, `${this.path}/${id}`); }
  where(field, operator, value) { return new Query(this.firestore, this.path, [...this.filters, { field, operator, value }], this.maximum, this.ordering); }
  limit(maximum) { return new Query(this.firestore, this.path, this.filters, maximum, this.ordering); }
  orderBy(field, direction = "asc") { return new Query(this.firestore, this.path, this.filters, this.maximum, [...this.ordering, { field, direction }]); }
  get() { return Promise.resolve(this.firestore.query(this, this.firestore.store)); }
}

class RetryConflict extends Error {}
class MemoryFirestore {
  constructor() {
    this.store = new Map();
    this.versions = new Map();
    this.collectionVersions = new Map();
    this.transactionRetries = 0;
    this.failNextCommit = null;
  }
  collection(name) { return new Query(this, name); }
  doc(documentPath) { return new DocRef(this, documentPath); }
  seed(documentPath, data) {
    this.store.set(documentPath, copy(data));
    this.bump(documentPath);
  }
  bump(documentPath) {
    this.versions.set(documentPath, (this.versions.get(documentPath) || 0) + 1);
    const collectionPath = documentPath.slice(0, documentPath.lastIndexOf("/"));
    this.collectionVersions.set(collectionPath, (this.collectionVersions.get(collectionPath) || 0) + 1);
  }
  snapshot(ref, store) {
    const data = store.get(ref.path);
    return { id: ref.id, ref, exists: store.has(ref.path), data: () => data === undefined ? undefined : copy(data, true), get: (field) => copy(data?.[field], true) };
  }
  query(query, store) {
    const prefix = `${query.path}/`;
    let docs = [...store.keys()].filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
      .map((key) => this.snapshot(new DocRef(this, key), store))
      .filter((document) => query.filters.every(({ field, operator, value }) => {
        const actual = field === "__name__" ? document.id : document.data()?.[field];
        if (operator === "==") return equivalent(actual, value);
        if (operator === "array-contains") return Array.isArray(actual) && actual.some((item) => equivalent(item, value));
        if (operator === "in") return value.some((item) => equivalent(actual, item));
        throw new Error(`Unsupported fake query operator: ${operator}`);
      }));
    for (const { field, direction } of query.ordering.toReversed()) docs.sort((left, right) => {
      const a = left.get(field), b = right.get(field);
      return (a < b ? -1 : a > b ? 1 : 0) * (direction === "desc" ? -1 : 1);
    });
    docs = docs.slice(0, query.maximum);
    return { docs, size: docs.length, empty: docs.length === 0, forEach: (callback) => docs.forEach(callback) };
  }
  getAll(...refs) { return Promise.resolve(refs.map((ref) => this.snapshot(ref, this.store))); }
  batch() {
    const writes = [];
    const batch = {};
    for (const type of ["create", "set", "update", "delete"]) batch[type] = (ref, data, options) => { writes.push({ type, ref, data, options }); return batch; };
    batch.commit = () => this.commit(writes);
    return batch;
  }
  async commit(writes, documentReads = new Map(), collectionReads = new Map()) {
    // The check and replacement are synchronous, so the commit itself is atomic.
    for (const [key, version] of documentReads) if ((this.versions.get(key) || 0) !== version) throw new RetryConflict();
    for (const [key, version] of collectionReads) if ((this.collectionVersions.get(key) || 0) !== version) throw new RetryConflict();
    if (this.failNextCommit) { const error = this.failNextCommit; this.failNextCommit = null; throw error; }
    const next = new Map([...this.store].map(([key, value]) => [key, copy(value)]));
    for (const { type, ref, data, options } of writes) {
      if (type === "create" && next.has(ref.path)) throw new Error(`Document already exists: ${ref.path}`);
      if (type === "update" && !next.has(ref.path)) throw new Error(`Document missing: ${ref.path}`);
      if (type === "delete") next.delete(ref.path);
      else next.set(ref.path, applyValues(type === "update" || options?.merge ? next.get(ref.path) : {}, data));
    }
    this.store = next;
    for (const { ref } of writes) this.bump(ref.path);
    return [];
  }
  async runTransaction(callback) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const snapshot = new Map([...this.store].map(([key, value]) => [key, copy(value)]));
      const versions = new Map(this.versions);
      const collectionVersions = new Map(this.collectionVersions);
      const documentReads = new Map(), collectionReads = new Map(), writes = [];
      const transaction = {
        get: async (target) => {
          if (writes.length) throw new Error("All reads must precede writes in a transaction");
          if (target instanceof DocRef) {
            documentReads.set(target.path, versions.get(target.path) || 0);
            return this.snapshot(target, snapshot);
          }
          if (target instanceof Query) {
            collectionReads.set(target.path, collectionVersions.get(target.path) || 0);
            return this.query(target, snapshot);
          }
          throw new Error("Unsupported fake read target");
        },
      };
      transaction.getAll = (...refs) => Promise.all(refs.map((ref) => transaction.get(ref)));
      for (const type of ["create", "set", "update", "delete"]) transaction[type] = (ref, data, options) => { writes.push({ type, ref, data, options }); return transaction; };
      try {
        const result = await callback(transaction);
        await this.commit(writes, documentReads, collectionReads);
        return result;
      } catch (error) {
        if (!(error instanceof RetryConflict)) throw error;
        this.transactionRetries++;
      }
    }
    throw new Error("Fake transaction exceeded its retry limit");
  }
  data(documentPath) { return copy(this.store.get(documentPath)); }
  documents(collectionPath) {
    return this.query(this.collection(collectionPath), this.store).docs.map((document) => ({ id: document.id, ...this.data(document.ref.path) }));
  }
  state() { return JSON.stringify([...this.store.entries()].sort(([a], [b]) => a.localeCompare(b))); }
}

function setup() {
  const db = new MemoryFirestore();
  const cache = new Map();
  const webauthnCalls = [];
  const injected = {
    "firebase-admin/firestore": { FieldValue, Timestamp: FakeTimestamp },
    "@/lib/firebase-admin": { getAdminFirestore: () => db },
    "@/lib/official-closures": {},
    // Crypto itself belongs to the WebAuthn library. These doubles exercise only
    // application identity binding, challenge persistence and account lookup.
    "@simplewebauthn/server": {
      generateRegistrationOptions: async (options) => {
        webauthnCalls.push({ operation: "register", options });
        return { challenge: "test-registration-challenge" };
      },
      generateAuthenticationOptions: async (options) => {
        webauthnCalls.push({ operation: "authenticate", options });
        return { challenge: "test-authentication-challenge" };
      },
      verifyRegistrationResponse: async () => ({
        verified: true,
        registrationInfo: { credential: { id: "test-passkey", publicKey: new Uint8Array([1, 2, 3]), counter: 0 }, credentialBackedUp: false, credentialDeviceType: "singleDevice" },
      }),
      verifyAuthenticationResponse: async ({ credential }) => ({
        verified: true,
        authenticationInfo: { newCounter: credential.counter + 1, credentialBackedUp: false, credentialDeviceType: "singleDevice" },
      }),
    },
  };
  function loadSource(relative) {
    let filename = path.resolve(projectRoot, relative);
    if (!fs.existsSync(filename)) {
      filename = [".ts", ".tsx", ".mjs", ".js"].map((extension) => filename + extension).find((candidate) => fs.existsSync(candidate));
      if (!filename) throw new Error(`Cannot resolve test source ${relative}`);
    }
    if (cache.has(filename)) return cache.get(filename).exports;
    const loaded = { exports: {} };
    cache.set(filename, loaded);
    // A .js filename makes TypeScript convert .mjs source into injected CommonJS.
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      fileName: filename.replace(/\.mjs$/, ".js"),
      compilerOptions: { allowJs: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    function localRequire(id) {
      if (Object.hasOwn(injected, id)) return injected[id];
      if (id.startsWith("@/")) return loadSource(`src/${id.slice(2)}`);
      if (id.startsWith(".")) return loadSource(path.relative(projectRoot, path.resolve(path.dirname(filename), id)));
      return require(id);
    }
    new Function("require", "module", "exports", "__filename", "__dirname", output)(localRequire, loaded, loaded.exports, filename, path.dirname(filename));
    return loaded.exports;
  }
  const names = loadSource("src/lib/member-names.mjs");
  const auth = loadSource("src/lib/device-auth.ts");
  const database = loadSource("src/lib/firestore-database.ts");
  const roles = loadSource("src/lib/club-roles.ts");
  const passkeys = loadSource("src/lib/passkey-auth.ts");
  return { db, names, auth, database, roles, passkeys, webauthnCalls };
}

function targetMembers(s, name) {
  return s.db.documents("members").filter((member) => s.names.memberNameKey(Object.hasOwn(member, "accountName") ? member.accountName : member.displayName) === s.names.memberNameKey(name));
}
function reservation(s, name) { return s.db.data(`memberNames/${s.names.memberNameId(name)}`); }
function counts(s) { return ["members", "deviceCredentials", "memberNames"].map((collection) => s.db.documents(collection).length); }
function rename(s, viewer, displayName, extra = {}) {
  return s.database.mutate("updateDisplayName", { displayName, ...extra }, viewer);
}

test("account identity falls back only for members missing the accountName field", () => {
  const { names } = setup();
  assert.equal(names.memberAccountName({ displayName: "Legacy Name" }), "Legacy Name");
  assert.equal(names.memberAccountName({ accountName: "Fixed Account", displayName: "New Label" }), "Fixed Account");
  for (const accountName of ["", null, undefined]) {
    assert.notEqual(names.memberAccountName({ accountName, displayName: "Legacy Name" }), "Legacy Name");
  }
});

test("registration validates both names, reserves only the account and allows shared display names", async () => {
  const s = setup();
  for (const invalid of ["", "   ", "x".repeat(41), "Al\u200bice"]) {
    assert.throws(() => s.names.validatedAccountName(invalid));
    await assert.rejects(s.auth.createGuestDeviceAccount(invalid, undefined, "Valid Label"));
    await assert.rejects(s.auth.createGuestDeviceAccount("Valid Account", undefined, invalid));
    assert.deepEqual(counts(s), [0, 0, 0]);
  }
  const alice = await s.auth.createGuestDeviceAccount("  Alice   Account  ", undefined, "  Shared   Name  ");
  const bob = await s.auth.createGuestDeviceAccount("Bob Account", undefined, "Shared Name");
  assert.equal(alice.viewer.accountName, "Alice Account");
  assert.equal(alice.viewer.name, "Shared Name");
  assert.equal(bob.viewer.name, alice.viewer.name);
  assert.notEqual(bob.viewer.id, alice.viewer.id);
  assert.equal(reservation(s, "Alice Account").memberId, alice.viewer.id);
  assert.equal(reservation(s, "Shared Name"), undefined);
  const before = s.db.state();
  await assert.rejects(s.auth.createGuestDeviceAccount("ＡＬＩＣＥ　ＡＣＣＯＵＮＴ", undefined, "Different Label"));
  assert.equal(s.db.state(), before);
  const distinct = await s.auth.createGuestDeviceAccount("Shared Name", undefined, "A Third Label");
  assert.notEqual(distinct.viewer.id, alice.viewer.id, "another person's display name does not reserve an account name");
  const stored = s.db.data(`members/${alice.viewer.id}`);
  assert.equal(stored.accountName, "Alice Account");
  assert.equal(stored.accountNameKey, s.names.memberNameKey("Alice Account"));
});

test("self rename preserves account, reservations, credentials and recovery while all device views use the new label", async () => {
  const s = setup();
  const first = await s.auth.createGuestDeviceAccount("Alice Account", undefined, "Old Public Name");
  await s.auth.createRecoveryCode(first.viewer.id);
  const original = s.db.data(`members/${first.viewer.id}`);
  const originalReservation = reservation(s, "Alice Account");
  const originalCredentials = s.db.documents("deviceCredentials");
  const originalCounts = counts(s);
  await rename(s, first.viewer, "  New   Public Name  ");
  const stored = s.db.data(`members/${first.viewer.id}`);
  assert.equal(stored.displayName, "New Public Name");
  assert.equal(stored.accountName, "Alice Account");
  assert.equal(stored.accountNameKey, original.accountNameKey);
  for (const key of ["role", "membershipStatus", "creditBalance", "accountType", "recoveryCodeSalt", "recoveryCodeHash", "passkeyCount"]) {
    assert.deepEqual(stored[key], original[key], key);
  }
  assert.deepEqual(reservation(s, "Alice Account"), originalReservation);
  assert.equal(reservation(s, "New Public Name"), undefined);
  assert.deepEqual(s.db.documents("deviceCredentials"), originalCredentials);
  assert.deepEqual(counts(s), originalCounts);
  let viewer = await s.auth.viewerForDeviceToken(first.token);
  assert.equal(viewer.id, first.viewer.id);
  assert.equal(viewer.accountName, "Alice Account");
  assert.equal(viewer.name, "New Public Name");
  await s.auth.deactivateDeviceToken(first.token);
  const remembered = await s.auth.deviceAccountsForToken(first.token);
  assert.equal(remembered[0].accountName, "Alice Account");
  assert.equal(remembered[0].name, "New Public Name");
  viewer = await s.auth.activateDeviceAccount(first.token, first.viewer.id);
  assert.equal(viewer.id, first.viewer.id);
  assert.equal(viewer.name, "New Public Name");
  assert.equal(viewer.accountName, "Alice Account");
});

test("rename accepts duplicate display names and cannot release or redirect an account name", async () => {
  const s = setup();
  const alice = await s.auth.createGuestDeviceAccount("Alice Account", undefined, "Alice Label");
  const bob = await s.auth.createGuestDeviceAccount("Bob Account", undefined, "Bob Label");
  await rename(s, alice.viewer, "Bob Account");
  await rename(s, bob.viewer, "Bob Account");
  assert.equal(s.db.data(`members/${alice.viewer.id}`).displayName, s.db.data(`members/${bob.viewer.id}`).displayName);
  const before = s.db.state();
  for (const accountName of ["Alice Account", "ＡＬＩＣＥ　ＡＣＣＯＵＮＴ", "Bob Account"]) {
    await assert.rejects(s.auth.createGuestDeviceAccount(accountName, undefined, "Different Label"));
    assert.equal(s.db.state(), before);
  }
  const claim = await s.db.runTransaction((transaction) => s.names.readMemberName(transaction, s.db, "Bob Account"));
  assert.equal(claim.member.id, bob.viewer.id);
  assert.equal(claim.accountName, "Bob Account");
});

test("rename rejects invalid labels, foreign members and all protected account or permission fields without writes", async () => {
  const s = setup();
  const alice = await s.auth.createGuestDeviceAccount("Alice Account");
  const bob = await s.auth.createGuestDeviceAccount("Bob Account");
  const before = s.db.state();
  for (const displayName of ["", " ", "x".repeat(41), "Al\u0000ice", "Al\u200bice", "Al\ufe0fice"]) {
    await assert.rejects(rename(s, alice.viewer, displayName));
    assert.equal(s.db.state(), before);
  }
  for (const extra of [
    { memberId: bob.viewer.id }, { accountName: "New Account" }, { accountNameKey: "new account" },
    { role: "ADMIN" }, { primaryAdmin: "true" }, { membershipStatus: "MEMBER" }, { creditBalance: "99999" },
  ]) {
    await assert.rejects(rename(s, alice.viewer, "Valid Label", extra));
    assert.equal(s.db.state(), before, JSON.stringify(extra));
  }
});

test("failed rename rolls back member identity and reservation together", async () => {
  const s = setup();
  const first = await s.auth.createGuestDeviceAccount("Alice Account");
  const before = s.db.state();
  s.db.failNextCommit = new Error("simulated rename failure");
  await assert.rejects(rename(s, first.viewer, "New Public Name"), /simulated rename failure/);
  assert.equal(s.db.state(), before);
});

test("recovery keeps using immutable account names when display names collide with another account", async () => {
  const s = setup();
  const alice = await s.auth.createGuestDeviceAccount("Alice Account", undefined, "Old Label");
  const bob = await s.auth.createGuestDeviceAccount("Bob Account");
  const code = await s.auth.createRecoveryCode(alice.viewer.id);
  await rename(s, alice.viewer, "Bob Account");
  const before = s.db.state();
  await assert.rejects(s.auth.loginWithRecoveryOrClaimCode("Bob Account", code));
  assert.equal(s.db.state(), before);
  const recovered = await s.auth.loginWithRecoveryOrClaimCode("ＡＬＩＣＥ　ＡＣＣＯＵＮＴ", code);
  assert.equal(recovered.viewer.id, alice.viewer.id);
  assert.notEqual(recovered.viewer.id, bob.viewer.id);
  assert.equal(recovered.viewer.accountName, "Alice Account");
  assert.equal(recovered.viewer.name, "Bob Account");
  await assert.rejects(s.auth.loginWithRecoveryOrClaimCode("Alice Account", code));
});

test("concurrent recovery consumes a code once and leaves no losing-request credential", async () => {
  for (const attachExistingDevice of [false, true]) {
    const s = setup();
    const first = await s.auth.createGuestDeviceAccount("Alice Account", undefined, "Old Label");
    const currentDevice = attachExistingDevice ? await s.auth.createGuestDeviceAccount("Bob Account") : null;
    const code = await s.auth.createRecoveryCode(first.viewer.id);
    await rename(s, first.viewer, "New Public Label");
    const credentialCount = s.db.documents("deviceCredentials").length;
    const results = await Promise.allSettled([
      s.auth.loginWithRecoveryOrClaimCode("Alice Account", code, currentDevice?.token),
      s.auth.loginWithRecoveryOrClaimCode("ＡＬＩＣＥ　ＡＣＣＯＵＮＴ", code, currentDevice?.token),
    ]);
    const successful = results.filter((result) => result.status === "fulfilled");
    assert.equal(successful.length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.ok(s.db.transactionRetries > 0, "the conflicting recovery must retry against the rotated code");
    const winner = successful[0].value;
    assert.equal(winner.viewer.id, first.viewer.id);
    assert.equal(winner.viewer.accountName, "Alice Account");
    assert.equal(winner.viewer.name, "New Public Label");
    const credentials = s.db.documents("deviceCredentials");
    assert.equal(credentials.length, credentialCount + (attachExistingDevice ? 0 : 1));
    assert.equal(credentials.filter((credential) => !credential.revokedAt).length, credentials.length);
    if (currentDevice) {
      assert.equal(winner.token, currentDevice.token);
      const credential = s.db.data(`deviceCredentials/${currentDevice.token.split(".")[0]}`);
      assert.equal(credential.userId, currentDevice.viewer.id, "attaching an account preserves the credential's original userId");
      assert.equal(credential.activeUserId, first.viewer.id);
      assert.ok(credential.accountIds.includes(currentDevice.viewer.id));
      assert.ok(credential.accountIds.includes(first.viewer.id));
    }
    const beforeReplay = s.db.state();
    await assert.rejects(s.auth.loginWithRecoveryOrClaimCode("Alice Account", code));
    assert.equal(s.db.state(), beforeReplay);
    const recoveredAgain = await s.auth.loginWithRecoveryOrClaimCode("Alice Account", winner.recoveryCode, winner.token);
    assert.equal(recoveredAgain.viewer.id, first.viewer.id);
    assert.equal(recoveredAgain.token, winner.token);
    assert.equal(s.db.documents("deviceCredentials").length, credentials.length);
  }
});

test("legacy rename pins the original account and preserves an existing reservation timestamp", async () => {
  for (const reserved of [false, true]) {
    const s = setup();
    s.db.seed("members/legacy", { id: "legacy", displayName: "Legacy Account", displayNameKey: "legacy account", role: "MEMBER", membershipStatus: "GUEST", accountType: "guest", creditBalance: 0 });
    const originalReservation = { nameKey: s.names.memberNameKey("Legacy Account"), memberId: "legacy", createdAt: new Date(0) };
    if (reserved) s.db.seed(`memberNames/${s.names.memberNameId("Legacy Account")}`, originalReservation);
    const session = await s.auth.createDeviceSessionForUser("legacy");
    assert.equal(session.viewer.accountName, "Legacy Account");
    await rename(s, session.viewer, "New Legacy Label");
    const stored = s.db.data("members/legacy");
    assert.equal(stored.accountName, "Legacy Account");
    assert.equal(stored.accountNameKey, s.names.memberNameKey("Legacy Account"));
    assert.equal(stored.displayName, "New Legacy Label");
    assert.equal(reservation(s, "Legacy Account").memberId, "legacy");
    if (reserved) assert.deepEqual(reservation(s, "Legacy Account"), originalReservation);
    assert.equal(reservation(s, "New Legacy Label"), undefined);
    const before = s.db.state();
    await assert.rejects(s.auth.createGuestDeviceAccount("ＬＥＧＡＣＹ　ＡＣＣＯＵＮＴ", undefined, "New Label"));
    assert.equal(s.db.state(), before);
  }
});

test("failed or ambiguous legacy rename cannot leave a pinned account or name reservation", async () => {
  for (const ambiguous of [false, true]) {
    const s = setup();
    const legacy = { displayName: "Legacy Account", role: "MEMBER", membershipStatus: "GUEST", accountType: "guest" };
    s.db.seed("members/legacy", { id: "legacy", ...legacy });
    if (ambiguous) s.db.seed("members/other-legacy", { id: "other-legacy", ...legacy, displayName: "ＬＥＧＡＣＹ　ＡＣＣＯＵＮＴ" });
    const session = await s.auth.createDeviceSessionForUser("legacy");
    const before = s.db.state();
    if (!ambiguous) s.db.failNextCommit = new Error("simulated legacy rename failure");
    await assert.rejects(rename(s, session.viewer, "New Label"));
    assert.equal(s.db.state(), before);
    assert.equal(Object.hasOwn(s.db.data("members/legacy"), "accountName"), false);
    assert.equal(reservation(s, "Legacy Account"), undefined);
  }
});

test("legacy president retains authority after renaming and an officer cannot gain it through a label", async () => {
  const s = setup();
  s.db.seed("members/president", { id: "president", displayName: "BarryAdmin", role: "ADMIN", membershipStatus: "MEMBER", accountType: "guest" });
  s.db.seed("members/officer", { id: "officer", displayName: "Officer Account", role: "ADMIN", membershipStatus: "MEMBER", accountType: "guest" });
  const president = await s.auth.createDeviceSessionForUser("president");
  const officer = await s.auth.createDeviceSessionForUser("officer");
  assert.equal(president.viewer.primaryAdmin, true);
  assert.equal(officer.viewer.primaryAdmin, false);
  await rename(s, president.viewer, "President Public Name");
  await rename(s, officer.viewer, "BarryAdmin");
  const freshPresident = await s.auth.viewerForDeviceToken(president.token);
  const freshOfficer = await s.auth.viewerForDeviceToken(officer.token);
  assert.equal(freshPresident.primaryAdmin, true);
  assert.equal(freshPresident.accountName, "BarryAdmin");
  assert.equal(freshOfficer.primaryAdmin, false);
  assert.equal(freshOfficer.accountName, "Officer Account");
  assert.equal(freshOfficer.name, "BarryAdmin");
  assert.equal(s.roles.isClubPresident(s.db.data("members/president")), true);
  assert.equal(s.roles.isClubPresident(s.db.data("members/officer")), false);
  assert.equal((await s.auth.deviceAccountsForToken(president.token))[0].primaryAdmin, true);
  assert.equal((await s.auth.deviceAccountsForToken(officer.token))[0].primaryAdmin, false);
});

test("explicit former-president flags remain false after rename even for the BarryAdmin account", async () => {
  const s = setup();
  s.db.seed("members/former", { id: "former", accountName: "BarryAdmin", accountNameKey: "barryadmin", displayName: "Former President", role: "ADMIN", primaryAdmin: false, membershipStatus: "MEMBER", accountType: "guest" });
  const session = await s.auth.createDeviceSessionForUser("former");
  assert.equal(session.viewer.primaryAdmin, false);
  await rename(s, session.viewer, "BarryAdmin");
  assert.equal(s.db.data("members/former").primaryAdmin, false);
  assert.equal((await s.auth.viewerForDeviceToken(session.token)).primaryAdmin, false);
});

test("admin updateMember cannot alter immutable account identity", async () => {
  const s = setup();
  const manager = await s.auth.createGuestDeviceAccount("Officer Account");
  const target = await s.auth.createGuestDeviceAccount("Alice Account");
  s.db.seed(`members/${manager.viewer.id}`, { ...s.db.data(`members/${manager.viewer.id}`), role: "ADMIN", membershipStatus: "MEMBER" });
  const actor = await s.auth.viewerForDeviceToken(manager.token);
  const valid = { memberId: target.viewer.id, role: "MEMBER", membershipStatus: "GUEST", department: "Engineering", balanceAdjustment: "0", adjustmentNote: "" };
  await s.database.mutate("updateMember", valid, actor);
  assert.equal(s.db.data(`members/${target.viewer.id}`).department, "Engineering", "the authorized admin fixture can perform an ordinary update");
  const before = s.db.state();
  for (const protectedFields of [{ accountName: "New Account" }, { accountNameKey: "new account" }]) {
    await assert.rejects(s.database.mutate("updateMember", { ...valid, ...protectedFields }, actor));
    assert.equal(s.db.state(), before);
  }
});

test("passkey registration and authentication keep a stable account identity across display rename", async () => {
  const s = setup();
  const alice = await s.auth.createGuestDeviceAccount("Alice Account", undefined, "Alice Label");
  const bob = await s.auth.createGuestDeviceAccount("Bob Account");
  const relyingParty = { rpID: "badminton.example", origin: "https://badminton.example" };
  const pending = await s.passkeys.registrationOptions(alice.viewer, relyingParty);
  const initial = s.webauthnCalls.at(-1).options;
  assert.equal(initial.userName, "Alice Account");
  assert.equal(initial.userDisplayName, "Alice Label");
  assert.equal(new TextDecoder().decode(initial.userID), alice.viewer.id);
  await rename(s, alice.viewer, "Bob Account");
  await s.passkeys.verifyRegistration(alice.viewer, pending.challengeId, { id: "test-passkey", response: { transports: ["internal"] } }, relyingParty);
  assert.equal(s.db.data("passkeys/test-passkey").userId, alice.viewer.id);
  const renamed = await s.auth.viewerForDeviceToken(alice.token);
  await s.passkeys.registrationOptions(renamed, relyingParty);
  const current = s.webauthnCalls.at(-1).options;
  assert.equal(current.userName, "Alice Account");
  assert.equal(current.userDisplayName, "Bob Account");
  assert.equal(new TextDecoder().decode(current.userID), alice.viewer.id);
  const authChallenge = await s.passkeys.authenticationOptions(relyingParty);
  const authenticated = await s.passkeys.verifyAuthentication(authChallenge.challengeId, { id: "test-passkey", response: {} }, relyingParty);
  assert.equal(authenticated.viewer.id, alice.viewer.id);
  assert.notEqual(authenticated.viewer.id, bob.viewer.id);
  assert.equal(authenticated.viewer.accountName, "Alice Account");
  assert.equal(authenticated.viewer.name, "Bob Account");
  assert.equal(s.db.data("passkeys/test-passkey").counter, 1);
  assert.equal(s.db.data(`passkeyChallenges/${authChallenge.challengeId}`), undefined);
  const beforeReplay = s.db.state();
  await assert.rejects(s.passkeys.verifyAuthentication(authChallenge.challengeId, { id: "test-passkey", response: {} }, relyingParty));
  assert.equal(s.db.state(), beforeReplay);
});

test("name validation rejects empty, overlong, control and invisible format characters", () => {
  const { names } = setup();
  for (const input of ["", "   ", "x".repeat(41), "Al\u0000ice", "Al\u0009ice", "Al\u200bice", "Al\u202eice", "Al\ufeffice", "Al\u034fice", "Al\ufe0fice"]) {
    assert.throws(() => names.validatedDisplayName(input), undefined, JSON.stringify(input));
  }
  assert.equal(names.validatedDisplayName("  Alice   Wang  "), "Alice Wang");
  assert.equal(names.validatedDisplayName("王".repeat(40)), "王".repeat(40));
});

test("name identity unifies case, Unicode width, legacy format characters and whitespace", () => {
  const { names } = setup();
  const variants = ["Alice Wang", "  alice   WANG  ", "Ａｌｉｃｅ　Ｗａｎｇ", "Al\u200bice Wang", "Al\u034fice Wang", "Al\ufe0fice Wang"];
  for (const variant of variants) {
    assert.equal(names.memberNameKey(variant), "alice wang");
    assert.equal(names.memberNameId(variant), names.memberNameId(variants[0]));
  }
  assert.notEqual(names.memberNameId("Alice Wong"), names.memberNameId("Alice Wang"));
});

test("invalid registration leaves no member, credential or name reservation", async () => {
  const s = setup();
  for (const input of ["  ", "x".repeat(41), "Al\u200bice", "Al\u034fice", "Al\ufe0fice"]) {
    await assert.rejects(s.auth.createGuestDeviceAccount(input));
    assert.deepEqual(counts(s), [0, 0, 0]);
  }
});

test("registration rejects all equivalent names and permits an unrelated account", async () => {
  const s = setup();
  const first = await s.auth.createGuestDeviceAccount("  Alice   Wang  ");
  assert.equal(first.viewer.name, "Alice Wang");
  assert.equal(reservation(s, "Alice Wang").memberId, first.viewer.id);
  const before = s.db.state();
  for (const variant of ["Alice Wang", "alice wang", "ＡＬＩＣＥ　ＷＡＮＧ", " Alice  Wang "]) {
    await assert.rejects(s.auth.createGuestDeviceAccount(variant));
    assert.equal(s.db.state(), before);
  }
  const other = await s.auth.createGuestDeviceAccount("Bob Wang");
  assert.notEqual(other.viewer.id, first.viewer.id);
  assert.deepEqual(counts(s), [2, 2, 2]);
});

test("a failed atomic registration cannot leave partial member, reservation or credential writes", async () => {
  const s = setup();
  s.db.failNextCommit = new Error("simulated commit failure");
  await assert.rejects(s.auth.createGuestDeviceAccount("Alice Wang"), /simulated commit failure/);
  assert.deepEqual(counts(s), [0, 0, 0]);
  const retry = await s.auth.createGuestDeviceAccount("Alice Wang");
  assert.equal(reservation(s, "Alice Wang").memberId, retry.viewer.id);
});

test("concurrent registrations contend, retry and commit exactly one normalized name", async () => {
  const s = setup();
  const results = await Promise.allSettled([
    s.auth.createGuestDeviceAccount("Alice Wang"),
    s.auth.createGuestDeviceAccount("ＡＬＩＣＥ　ＷＡＮＧ"),
    s.auth.createGuestDeviceAccount(" alice  wang "),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 2);
  assert.ok(s.db.transactionRetries > 0, "the fake must actually exercise a conflicting commit and retry");
  assert.deepEqual(counts(s), [1, 1, 1]);
  assert.equal(reservation(s, "alice wang").memberId, targetMembers(s, "alice wang")[0].id);
});

test("unreserved legacy names block normalized duplicates without rewriting old accounts", async () => {
  for (const displayName of ["Ａｌ\u200bｉｃｅ　Ｗａｎｇ", "Al\u034fice Wang", "Al\ufe0fice Wang"]) {
    const s = setup();
    s.db.seed("members/legacy", { id: "legacy", displayName, role: "MEMBER", membershipStatus: "GUEST", accountType: "unclaimed" });
    const before = s.db.state();
    await assert.rejects(s.auth.createGuestDeviceAccount("Alice Wang"));
    assert.equal(s.db.state(), before);
    assert.deepEqual(counts(s), [1, 0, 0]);
  }
});

test("ambiguous legacy accounts fail closed rather than selecting or merging an owner", async () => {
  const s = setup();
  s.db.seed("members/legacy-one", { displayName: "Alice Wang", role: "MEMBER" });
  s.db.seed("members/legacy-two", { displayName: "ＡＬＩＣＥ　ＷＡＮＧ", role: "MEMBER" });
  const before = s.db.state();
  await assert.rejects(s.db.runTransaction((transaction) => s.names.readMemberName(transaction, s.db, "alice wang")));
  await assert.rejects(s.auth.createGuestDeviceAccount("Alice Wang"));
  assert.equal(s.db.state(), before);
});

test("an inconsistent registry cannot redirect a name to a different member", async () => {
  const s = setup();
  s.db.seed("members/alice", { displayName: "Alice Wang", role: "MEMBER" });
  s.db.seed("members/bob", { displayName: "Bob Wang", role: "MEMBER" });
  s.db.seed(`memberNames/${s.names.memberNameId("Alice Wang")}`, { nameKey: s.names.memberNameKey("Alice Wang"), memberId: "bob", createdAt: new Date() });
  const before = s.db.state();
  await assert.rejects(s.db.runTransaction((transaction) => s.names.readMemberName(transaction, s.db, "Alice Wang")));
  await assert.rejects(s.auth.createGuestDeviceAccount("Alice Wang"));
  assert.equal(s.db.state(), before);
});

test("an existing name reservation is immutable and rejects another owner", async () => {
  const s = setup();
  const first = await s.auth.createGuestDeviceAccount("Alice Wang");
  const before = s.db.state();
  await assert.rejects(s.db.runTransaction(async (transaction) => {
    const claim = await s.names.readMemberName(transaction, s.db, "Alice Wang");
    s.names.reserveMemberName(transaction, claim, "other-id", new Date());
  }));
  assert.equal(s.db.state(), before);
  await s.db.runTransaction(async (transaction) => {
    const claim = await s.names.readMemberName(transaction, s.db, "ＡＬＩＣＥ　ＷＡＮＧ");
    s.names.reserveMemberName(transaction, claim, first.viewer.id, new Date(Date.now() + 1000));
  });
  assert.equal(s.db.state(), before, "a repeated reservation must preserve its original createdAt");
});

test("the same remembered device cannot register a duplicate and can still log out then quick login", async () => {
  const s = setup();
  const first = await s.auth.createGuestDeviceAccount("Alice Wang");
  const before = s.db.state();
  await assert.rejects(s.auth.createGuestDeviceAccount("ＡＬＩＣＥ　ＷＡＮＧ", first.token));
  assert.equal(s.db.state(), before);
  await s.auth.deactivateDeviceToken(first.token);
  assert.equal(await s.auth.viewerForDeviceToken(first.token), null);
  const remembered = await s.auth.deviceAccountsForToken(first.token);
  assert.deepEqual(remembered.map((account) => account.id), [first.viewer.id]);
  const reactivated = await s.auth.activateDeviceAccount(first.token, first.viewer.id);
  assert.equal(reactivated.id, first.viewer.id);
  assert.equal((await s.auth.viewerForDeviceToken(first.token)).id, first.viewer.id);
  assert.deepEqual(counts(s), [1, 1, 1]);
});

test("recovery accepts normalized names only with a matching code and rotates the old code", async () => {
  const s = setup();
  const first = await s.auth.createGuestDeviceAccount("Alice Wang");
  const recoveryCode = await s.auth.createRecoveryCode(first.viewer.id);
  const before = s.db.state();
  for (const [name, code] of [["Alice Wang", ""], ["Alice Wang", "AAAA-AAAA-AAAA-AAAA"], ["Bob Wang", recoveryCode]]) {
    await assert.rejects(s.auth.loginWithRecoveryOrClaimCode(name, code));
    assert.equal(s.db.state(), before);
  }
  const recovered = await s.auth.loginWithRecoveryOrClaimCode("ＡＬＩＣＥ　ＷＡＮＧ", recoveryCode);
  assert.equal(recovered.viewer.id, first.viewer.id);
  assert.ok(recovered.recoveryCode);
  assert.equal(targetMembers(s, "Alice Wang").length, 1);
  await assert.rejects(s.auth.loginWithRecoveryOrClaimCode("Alice Wang", recoveryCode));
});

async function transferFixture() {
  const s = setup();
  const source = await s.auth.createGuestDeviceAccount("Alice Wang");
  for (const eventId of ["event-one", "event-two"]) {
    s.db.seed(`events/${eventId}`, { id: eventId, status: "SCHEDULED", startsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), regularCount: 1, standbyCount: 0 });
    s.db.seed(`events/${eventId}/bookings/${source.viewer.id}`, { id: `${eventId}-${source.viewer.id}`, eventId, memberId: source.viewer.id, displayNameSnapshot: source.viewer.name, status: "REGULAR", kindSnapshot: "GUEST" });
  }
  s.transfer = (recipient, eventId = "event-one") => s.database.mutate("transfer", { recipient, eventId }, source.viewer);
  s.source = source;
  return s;
}

test("transfer resolves an existing normalized account without creating another member or credential", async () => {
  const s = await transferFixture();
  const target = await s.auth.createGuestDeviceAccount("Bob Wang");
  const before = counts(s);
  const result = await s.transfer("ＢＯＢ　ＷＡＮＧ");
  assert.deepEqual(counts(s), before);
  assert.equal(targetMembers(s, "Bob Wang").length, 1);
  assert.equal(s.db.data(`events/event-one/bookings/${target.viewer.id}`).status, "REGULAR");
  assert.equal(s.db.data(`events/event-one/bookings/${s.source.viewer.id}`).status, "TRANSFERRED");
  assert.equal(result?.claimCode, undefined);
});

test("transfer targets the immutable account after rename and uses its current display snapshot", async () => {
  const s = await transferFixture();
  const target = await s.auth.createGuestDeviceAccount("Bob Account", undefined, "Original Recipient Label");
  const impersonator = await s.auth.createGuestDeviceAccount("Other Account", undefined, "Bob Account");
  await rename(s, target.viewer, "New Recipient Label");
  const before = counts(s);
  const result = await s.transfer("ＢＯＢ　ＡＣＣＯＵＮＴ");
  assert.deepEqual(counts(s), before);
  assert.equal(result?.claimCode, undefined);
  const booking = s.db.data(`events/event-one/bookings/${target.viewer.id}`);
  assert.equal(booking.status, "REGULAR");
  assert.equal(booking.displayNameSnapshot, "New Recipient Label");
  assert.equal(s.db.data(`events/event-one/bookings/${impersonator.viewer.id}`), undefined);
  assert.equal(targetMembers(s, "Bob Account").length, 1);
});

test("renaming cannot bypass the member-id self-transfer check or rewrite past booking snapshots", async () => {
  const s = await transferFixture();
  const originalBooking = s.db.data(`events/event-one/bookings/${s.source.viewer.id}`);
  await rename(s, s.source.viewer, "New Source Label");
  assert.deepEqual(s.db.data(`events/event-one/bookings/${s.source.viewer.id}`), originalBooking);
  const before = s.db.state();
  for (const accountName of ["Alice Wang", "ＡＬＩＣＥ　ＷＡＮＧ", " alice   wang "]) {
    await assert.rejects(s.transfer(accountName));
    assert.equal(s.db.state(), before);
  }
});

test("transfer rejects its own normalized name without leaving any writes", async () => {
  const s = await transferFixture();
  const before = s.db.state();
  for (const name of ["Alice Wang", "ＡＬＩＣＥ　ＷＡＮＧ", " alice   wang "]) {
    await assert.rejects(s.transfer(name));
    assert.equal(s.db.state(), before);
  }
});

test("transfer rejects ambiguous legacy recipients without choosing a member", async () => {
  const s = await transferFixture();
  s.db.seed("members/legacy-one", { displayName: "Bob Wang", role: "MEMBER", membershipStatus: "GUEST" });
  s.db.seed("members/legacy-two", { displayName: "ＢＯＢ　ＷＡＮＧ", role: "MEMBER", membershipStatus: "GUEST" });
  const before = s.db.state();
  await assert.rejects(s.transfer("bob wang"));
  assert.equal(s.db.state(), before);
});

test("transfer atomically creates one unclaimed recipient and retries cannot duplicate it", async () => {
  const s = await transferFixture();
  const result = await s.transfer("  Bob   Wang  ");
  const [target] = targetMembers(s, "Bob Wang");
  assert.equal(target.accountName, "Bob Wang");
  assert.equal(target.accountNameKey, s.names.memberNameKey("Bob Wang"));
  assert.equal(target.displayName, "Bob Wang");
  assert.equal(target.accountType, "unclaimed");
  assert.equal(reservation(s, "Bob Wang").memberId, target.id);
  assert.ok(result.claimCode);
  assert.deepEqual(counts(s), [2, 1, 2]);
  const after = s.db.state();
  await assert.rejects(s.transfer("ＢＯＢ　ＷＡＮＧ"));
  assert.equal(s.db.state(), after);
});

test("an unclaimed transfer recipient keeps its account name after claiming and renaming", async () => {
  const s = await transferFixture();
  const transfer = await s.transfer("Bob Account");
  const [target] = targetMembers(s, "Bob Account");
  const claimed = await s.auth.loginWithRecoveryOrClaimCode("ＢＯＢ　ＡＣＣＯＵＮＴ", transfer.claimCode);
  assert.equal(claimed.viewer.id, target.id);
  assert.equal(claimed.viewer.accountName, "Bob Account");
  await rename(s, claimed.viewer, "Alice Wang");
  assert.equal(s.db.data(`members/${target.id}`).accountName, "Bob Account");
  assert.equal(s.db.data(`members/${target.id}`).displayName, "Alice Wang");
  assert.equal(reservation(s, "Bob Account").memberId, target.id);
  const before = s.db.state();
  await assert.rejects(s.auth.loginWithRecoveryOrClaimCode("Bob Account", transfer.claimCode));
  await assert.rejects(s.auth.loginWithRecoveryOrClaimCode("Alice Wang", claimed.recoveryCode));
  assert.equal(s.db.state(), before);
  const recovered = await s.auth.loginWithRecoveryOrClaimCode("Bob Account", claimed.recoveryCode);
  assert.equal(recovered.viewer.id, target.id);
  assert.equal(recovered.viewer.name, "Alice Wang");
});

test("failed transfer commits roll back recipient, reservation, booking and source status together", async () => {
  const s = await transferFixture();
  const before = s.db.state();
  s.db.failNextCommit = new Error("simulated transfer failure");
  await assert.rejects(s.transfer("Bob Wang"), /simulated transfer failure/);
  assert.equal(s.db.state(), before);
  assert.equal(targetMembers(s, "Bob Wang").length, 0);
});

test("two transfers racing registration converge on one recipient and one reservation", async () => {
  const s = await transferFixture();
  const results = await Promise.allSettled([
    s.transfer("Bob Wang", "event-one"),
    s.transfer("ＢＯＢ　ＷＡＮＧ", "event-two"),
    s.auth.createGuestDeviceAccount(" bob   wang "),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "fulfilled");
  const [target] = targetMembers(s, "Bob Wang");
  assert.equal(targetMembers(s, "Bob Wang").length, 1);
  assert.equal(reservation(s, "Bob Wang").memberId, target.id);
  assert.equal(s.db.documents("members").length, 2);
  assert.equal(s.db.documents("memberNames").length, 2);
  assert.equal(s.db.documents("deviceCredentials").length, results[2].status === "fulfilled" ? 2 : 1);
  for (const eventId of ["event-one", "event-two"]) {
    assert.equal(s.db.data(`events/${eventId}/bookings/${target.id}`).status, "REGULAR");
    assert.equal(s.db.data(`events/${eventId}/bookings/${s.source.viewer.id}`).status, "TRANSFERRED");
  }
  assert.ok(s.db.transactionRetries > 0);
});

test("the adapter enforces reads before writes and atomic rollback", async () => {
  const db = new MemoryFirestore();
  const first = db.collection("checks").doc("one"), second = db.collection("checks").doc("two");
  await assert.rejects(db.runTransaction(async (transaction) => {
    transaction.create(first, { marker: 1 });
    await transaction.get(second);
  }), /reads must precede writes/);
  assert.equal(db.store.size, 0);
  db.seed(first.path, { marker: 1 });
  await assert.rejects(db.runTransaction(async (transaction) => {
    await transaction.get(first);
    transaction.create(second, { marker: 2 });
    transaction.create(first, { marker: 3 });
  }), /already exists/);
  assert.equal(db.data(second.path), undefined);
  assert.equal(db.data(first.path).marker, 1);
});

test("president status follows immutable account identity and explicit flags", () => {
  const { roles } = setup();
  assert.equal(roles.isClubPresident({ role: "ADMIN", accountName: "BarryAdmin", displayName: "New President Name" }), true);
  assert.equal(roles.isClubPresident({ role: "ADMIN", accountName: "barryadmin", displayName: "Someone Else" }), true);
  assert.equal(roles.isClubPresident({ role: "ADMIN", accountName: "Officer", displayName: "BarryAdmin" }), false);
  assert.equal(roles.isClubPresident({ role: "MEMBER", accountName: "BarryAdmin", displayName: "BarryAdmin" }), false);
  assert.equal(roles.isClubPresident({ role: "ADMIN", primaryAdmin: false, accountName: "BarryAdmin", displayName: "BarryAdmin" }), false);
  assert.equal(roles.isClubPresident({ role: "ADMIN", primaryAdmin: true, accountName: "AnotherOwner", displayName: "Anything" }), true);
  assert.equal(roles.isClubPresident({ role: "ADMIN", displayName: "BarryAdmin" }), true, "a legacy president without accountName remains recognized");
});

// Adapter boundary: this is an in-process optimistic transaction model, not an
// emulator or proof of production locking behavior. Collection versions also
// detect query phantoms, conservatively causing retries after any collection
// change. It does not model indexes, rules, network failures, lock timeouts,
// quotas, or automatic SDK conversions beyond the Timestamp/FieldValue methods
// exercised here. Firebase Admin initialization is replaced before any module
// is evaluated; no environment file, credentials, emulator or network is used.
