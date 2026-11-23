export type OfficialClosure = {
  date: string;
  name: string;
  kind: "holiday" | "closure";
};

const CALENDAR_URL = "https://data.ntpc.gov.tw/api/datasets/308dcd75-6434-45bc-a95f-584da4fed251/csv/file";
const DISASTER_URL = "https://www.dgpa.gov.tw/typh/daily/nds.html";
const CALENDAR_HEADER = "date,year,name,isholiday,holidaycategory,description";
const CALENDAR_CATEGORIES = new Set(["放假之紀念日及節日", "補假", "調整放假日", "特定節日", "星期六、星期日", "補行上班日"]);
const PUBLIC_HOLIDAYS = new Set(["放假之紀念日及節日", "補假", "調整放假日"]);
const REQUEST_TIMEOUT_MS = 6000;
const DAY_MS = 86400000;
const TAIPEI_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" });

function formatDate(year: string | number, month: string, day: string) {
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function dateValue(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const value = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date ? value : NaN;
}

function dateAfter(date: string) {
  return new Date(dateValue(date) + DAY_MS).toISOString().slice(0, 10);
}

function parseCsv(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let lastIndex = 0;
  // A CSV field can contain commas, escaped quotation marks, and line breaks when quoted.
  const fields = /(?:"((?:[^"]|"")*)"|([^",\r\n]*))(,|\r\n|\r|\n|$)/gy;
  const csv = input.replace(/^\uFEFF/, "");
  for (const field of csv.matchAll(fields)) {
    if (field[0] === "" && row.length === 0) break;
    row.push(field[1]?.replace(/""/g, '"') ?? field[2]);
    lastIndex = field.index + field[0].length;
    if (field[3] !== ",") {
      rows.push(row);
      row = [];
    }
  }
  if (lastIndex !== csv.length || row.length > 0) throw new Error("資料欄位格式錯誤");
  return rows;
}

function parseCalendar(csv: string, startDate: string, endDate: string): OfficialClosure[] {
  const [header, ...rows] = parseCsv(csv.trimEnd());
  if (header?.join(",") !== CALENDAR_HEADER || rows.length === 0) throw new Error("資料欄位格式錯誤");

  const knownDates = new Set<string>();
  const holidays: OfficialClosure[] = [];
  for (const row of rows) {
    const [compactDate, year, name, isHoliday, category, description] = row.map((field) => field.trim());
    const date = formatDate(compactDate.slice(0, 4), compactDate.slice(4, 6), compactDate.slice(6));
    const expectedStatus = category === "補行上班日" ? "否" : "是";
    if (row.length !== 6 || !/^\d{8}$/.test(compactDate) || !Number.isFinite(dateValue(date)) || year !== date.slice(0, 4) || knownDates.has(date) || !CALENDAR_CATEGORIES.has(category) || isHoliday !== expectedStatus) {
      throw new Error("行事曆含有無法辨識的日期或類別");
    }
    knownDates.add(date);
    if (PUBLIC_HOLIDAYS.has(category) && date >= startDate && date <= endDate) {
      holidays.push({ date, name: name || description || category, kind: "holiday" });
    }
  }

  // The official CSV is sparse. Every weekend is present, including holidays and make-up workdays.
  const first = dateValue(`${startDate.slice(0, 4)}-01-01`);
  const last = dateValue(`${endDate.slice(0, 4)}-12-31`);
  for (let value = first; value <= last; value += DAY_MS) {
    const day = new Date(value);
    if ((day.getUTCDay() === 0 || day.getUTCDay() === 6) && !knownDates.has(day.toISOString().slice(0, 10))) {
      throw new Error("行事曆尚未完整涵蓋所選年度");
    }
  }
  return holidays;
}

function htmlText(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|#160|#x0*a0);/gi, " ").trim();
}

const CITY_SCOPE = /^(?:新北市(?:全市)?|全市)[:：]?/;
const NOTICE = /^(今天|今日|明天|明日)?((?:全日|上午|中午|下午|晚間|晚上|凌晨|半日)?(?:\d{1,2}[:：]\d{2}(?:前|起))?)(.+?)[。.]?$/;
const CLOSED = /^(?:停止上班[、，,及與]?停止上課|停止上班及上課|已達停止上班及上課標準)$/;
const OPEN_OR_PENDING = /^(?:未達停止上班及上課標準|照常上班[、，,及與]?照常上課|照常上班及上課|照常上班[、，,及與]?停止上課|停止上班[、，,及與]?照常上課|停止上課|停止上班|未達停止上班[、，,]已達停止上課標準|尚未宣布消息|預計.*發布)$/;

function parseDisasterBulletin(html: string, today: string, startDate: string, endDate: string): OfficialClosure[] {
  const document = html.replace(/<!--[\s\S]*?-->/g, "");
  const heading = document.match(/<div\b[^>]*\bclass=["']Header_YMD["'][^>]*>([\s\S]*?)<\/div>/i);
  const displayed = heading && htmlText(heading[1]).match(/^(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*天然災害停止上班及上課情形$/);
  const updated = document.match(/更新時間\s*[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+\d{1,2}:\d{2}:\d{2}/);
  const table = document.match(/<table\b[^>]*\bid=["']Table["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!displayed || !updated || !table || !htmlText(table).includes("縣市名稱") || !htmlText(table).includes("是否停止上班上課情形")) {
    throw new Error("無法辨識公告格式");
  }

  const bulletinDate = formatDate(Number(displayed[1]) + 1911, displayed[2], displayed[3]);
  const updatedDate = formatDate(updated[1], updated[2], updated[3]);
  const yesterday = new Date(dateValue(today) - DAY_MS).toISOString().slice(0, 10);
  if (bulletinDate !== today || (updatedDate !== today && updatedDate !== yesterday)) throw new Error("公告尚未更新至今天");

  const records = Array.from(table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi));
  const closures: OfficialClosure[] = [];
  let hasAnnouncements = false;
  let hasClearNotice = false;
  for (const [, row] of records) {
    const city = row.match(/<td\b[^>]*\bheaders=["']city_Name["'][^>]*>([\s\S]*?)<\/td>/i);
    if (!city) continue;
    const cityName = htmlText(city[1]);
    if (/^無停班停課訊息[。.]?$/.test(cityName)) {
      hasClearNotice = true;
      continue;
    }
    const details = row.match(/<td\b[^>]*\bheaders=["']StopWorkSchool_Info["'][^>]*>([\s\S]*?)<\/td>/i);
    if (!/^[\u3400-\u9fff]{2,3}[縣市]$/.test(cityName) || !details || !htmlText(details[1])) throw new Error("無法辨識縣市公告內容");
    hasAnnouncements = true;
    if (cityName !== "新北市") continue;

    const lines = details[1].split(/<br\s*\/?>|<\/?font\b[^>]*>/i).map((line) => htmlText(line).replace(/\s+/g, "")).filter(Boolean);
    for (const line of lines) {
      if (/^(?:[【[(（]測試(?:訊息)?[】\])）]|測試(?:訊息)?[:：])/.test(line)) continue;
      const statement = line.replace(CITY_SCOPE, "");
      const notice = statement.match(NOTICE);
      if (notice?.[1] && CLOSED.test(notice[3])) {
        const date = /^(明天|明日)$/.test(notice[1]) ? dateAfter(updatedDate) : updatedDate;
        if (date >= today && date >= startDate && date <= endDate) {
          const time = notice[2] ? `（${notice[2]}）` : "";
          closures.push({ date, name: `新北市天然災害停班停課${time}`, kind: "closure" });
        }
        continue;
      }
      if (notice && OPEN_OR_PENDING.test(notice[3])) continue;
      // A locality or school before the date limits the announcement's geographic scope.
      if (/^.+?[:：](?:今天|今日|明天|明日)/.test(statement)) continue;
      throw new Error("無法辨識新北市公告內容");
    }
  }
  if (hasClearNotice === hasAnnouncements) throw new Error("無法辨識是否已發布停班停課公告");
  return closures;
}

async function getSource<T>(fetcher: typeof fetch, url: string, label: string, contentType: string, parser: (body: string) => T): Promise<T> {
  try {
    const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.headers.get("content-type")?.includes(contentType)) throw new Error("回應格式不符");
    return parser(await response.text());
  } catch (error) {
    const reason = error instanceof Error && !["TimeoutError", "AbortError", "TypeError"].includes(error.name) ? `（${error.message}）` : "";
    throw new Error(`無法取得${label}${reason}，請稍後重試。`);
  }
}

export async function fetchOfficialClosures(startDate: string, endDate: string, fetcher: typeof fetch = fetch): Promise<OfficialClosure[]> {
  if (!Number.isFinite(dateValue(startDate)) || !Number.isFinite(dateValue(endDate)) || startDate > endDate) {
    throw new Error("查詢起訖日期必須是有效日期，且起日不得晚於迄日。");
  }
  const today = TAIPEI_DATE.format(new Date());
  const [holidays, closures] = await Promise.all([
    getSource(fetcher, CALENDAR_URL, "政府辦公日曆", "text/csv", (body) => parseCalendar(body, startDate, endDate)),
    getSource(fetcher, DISASTER_URL, "人事行政總處停班停課公告", "text/html", (body) => parseDisasterBulletin(body, today, startDate, endDate)),
  ]);
  const byDate = new Map<string, { names: Set<string>; kind: OfficialClosure["kind"] }>();
  for (const entry of [...holidays, ...closures]) {
    const day = byDate.get(entry.date);
    if (day) {
      day.names.add(entry.name);
      if (entry.kind === "closure") day.kind = entry.kind;
    } else {
      byDate.set(entry.date, { names: new Set([entry.name]), kind: entry.kind });
    }
  }
  return Array.from(byDate, ([date, { names, kind }]) => ({ date, name: [...names].join("／"), kind }))
    .sort((left, right) => left.date.localeCompare(right.date));
}
