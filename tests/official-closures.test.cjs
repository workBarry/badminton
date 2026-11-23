/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const filename = path.resolve(__dirname, "../src/lib/official-closures.ts");
const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
new Function("module", "exports", code)(loaded, loaded.exports);
const { fetchOfficialClosures } = loaded.exports;

const HEADER = "\uFEFFdate,year,name,isholiday,holidaycategory,description";
const DAY = 86400000;
const TODAY = "2026-11-23";
const TOMORROW = "2026-11-24";

function calendar(...overrides) {
  const days = new Map(overrides.map((row) => [row.slice(0, 8), row]));
  for (let date = new Date("2026-01-01T00:00:00Z"); date.getUTCFullYear() === 2026; date = new Date(date.getTime() + DAY)) {
    const compact = date.toISOString().slice(0, 10).replace(/-/g, "");
    if ([0, 6].includes(date.getUTCDay()) && !days.has(compact)) days.set(compact, `${compact},2026,,是,星期六、星期日,`);
  }
  return [HEADER, ...days.values()].join("\r\n");
}

function bulletin(rows = "", date = "115年 11月 23日", updated = "2026/11/23") {
  return `<div class="Header_YMD">${date} 天然災害停止上班及上課情形</div>
    <h4>更新時間：${updated} 11:00:00</h4>
    <TABLE id="Table"><TR><TH>縣市名稱</TH><TH>是否停止上班上課情形</TH></TR><TBODY>
    ${rows || "<TR><TD headers='city_Name' colspan='2'><FONT><h2>無停班停課訊息。</h2></FONT></TD></TR>"}
    </TBODY></TABLE>`;
}

function city(name, ...notices) {
  return `<TR><TD headers='city_Name'><FONT>${name}</FONT></TD><TD headers='StopWorkSchool_Info'>${notices.map((notice) => `<FONT>${notice}</FONT>`).join("\n")}</TD></TR>`;
}

function source(csv, html) {
  return async (url, options) => {
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    if (url.includes("data.ntpc.gov.tw")) return new Response(csv, { headers: { "content-type": "text/csv;charset=UTF-8" } });
    assert.equal(url, "https://www.dgpa.gov.tw/typh/daily/nds.html");
    return new Response(html, { headers: { "content-type": "text/html" } });
  };
}

test("accepts named public holidays and make-up days while excluding routine weekends and sector-specific dates", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-23T03:00:00Z") });
  const csv = calendar(
    '20261121,2026,測試紀念日,是,放假之紀念日及節日,"範例,備註"',
    '20261123,2026,,是,補假,"紀念日補假,\r\n第二行有""引號"""',
    "20261124,2026,,是,調整放假日,",
    "20261125,2026,軍人節,是,特定節日,",
    "20261128,2026,,否,補行上班日,",
  );
  assert.deepEqual(await fetchOfficialClosures("2026-11-20", "2026-11-29", source(csv, bulletin())), [
    { date: "2026-11-21", name: "測試紀念日", kind: "holiday" },
    { date: TODAY, name: '紀念日補假,\r\n第二行有"引號"', kind: "holiday" },
    { date: TOMORROW, name: "調整放假日", kind: "holiday" },
  ]);
});

test("uses only New Taipei citywide work-and-school notices and merges overlapping dates", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-23T03:00:00Z") });
  const csv = calendar("20261123,2026,測試紀念日,是,放假之紀念日及節日,");
  const html = bulletin(city("臺北市", "今天停止上班、停止上課。") + city("新北市",
    "烏來區:今天停止上班、停止上課。",
    "今天上午09:00起照常上班、停止上課。",
    "【測試】今天停止上班、停止上課。",
    "今天下午01:00起停止上班、停止上課。",
    "明天已達停止上班及上課標準。",
  ));
  assert.deepEqual(await fetchOfficialClosures(TODAY, TOMORROW, source(csv, html)), [
    { date: TODAY, name: "測試紀念日／新北市天然災害停班停課（下午01:00起）", kind: "closure" },
    { date: TOMORROW, name: "新北市天然災害停班停課", kind: "closure" },
  ]);
});

test("anchors relative closure dates to the previous evening when the displayed bulletin is current", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-22T16:02:00Z") });
  const html = bulletin(city("新北市", "明天停止上班、停止上課。"), "115年 11月 23日", "2026/11/22");
  assert.deepEqual(await fetchOfficialClosures(TODAY, TOMORROW, source(calendar(), html)), [
    { date: TODAY, name: "新北市天然災害停班停課", kind: "closure" },
  ]);
});

test("rejects stale or unrecognized bulletins and incomplete calendar coverage", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-23T03:00:00Z") });
  await assert.rejects(fetchOfficialClosures(TODAY, TOMORROW, source(calendar(), bulletin("", "115年 11月 22日", "2026/11/22"))), /公告尚未更新至今天/);
  await assert.rejects(fetchOfficialClosures(TODAY, TOMORROW, source(calendar(), "無停班停課訊息。")), /無法辨識公告格式/);
  await assert.rejects(fetchOfficialClosures(TODAY, TOMORROW, source(calendar(), bulletin(city("新北市", "無法辨識的內容")))), /無法辨識新北市公告內容/);
  await assert.rejects(fetchOfficialClosures(TODAY, TOMORROW, source(`${HEADER}\n20261123,2026,測試紀念日,是,放假之紀念日及節日,`, bulletin())), /行事曆尚未完整涵蓋所選年度/);
});
