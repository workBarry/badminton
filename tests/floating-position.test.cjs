/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const loaded = { exports: {} };
const source = fs.readFileSync(path.resolve(__dirname, "../src/lib/floating-position.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
new Function("module", "exports", code)(loaded, loaded.exports);
const { floatingPoint, floatingRelative, floatingPanel } = loaded.exports;
const mobile = { x: 0, y: 0, width: 360, height: 800 };

test("drag coordinates are confined to usable viewport and survive normalized resize", () => {
  assert.deepEqual(floatingRelative({ x: -100, y: 5000 }, mobile), { x: 0, y: 1 });
  assert.deepEqual(floatingPoint({ x: 0, y: 1 }, mobile), { x: 16, y: 736 });
  assert.deepEqual(floatingPoint({ x: 1, y: 1 }, { x: 5, y: 30, width: 320, height: 300 }), { x: 261, y: 266 });
});
test("popup opens above bottom bell and below top bell without leaving viewport", () => {
  const above = floatingPanel(floatingPoint({ x: 1, y: 1 }, mobile), mobile);
  assert.equal(above.translateY, "-100%");
  assert.equal(above.top, 724);
  assert.equal(above.left, 16);
  assert.equal(above.width, 328);
  const below = floatingPanel(floatingPoint({ x: 0, y: 0 }, mobile), mobile);
  assert.equal(below.translateY, "0");
  assert.equal(below.top, 76);
  assert.ok(below.top + below.maxHeight <= mobile.height - 16);
});
test("short shifted visual viewport keeps popup width and height within visible area", () => {
  const visible = { x: 20, y: 50, width: 320, height: 230 };
  const point = floatingPoint({ x: 0.5, y: 1 }, visible);
  const popup = floatingPanel(point, visible);
  assert.ok(popup.left >= visible.x + 16);
  assert.ok(popup.left + popup.width <= visible.x + visible.width - 16);
  assert.ok(popup.top - popup.maxHeight >= visible.y + 16);
  assert.ok(popup.maxHeight > 0);
});
