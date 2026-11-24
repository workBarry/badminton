# 公司羽球社管理網站

這是一個 Next.js 響應式網站。活動、社員、帳單、公告與已確認的季度規劃共用同一個 Cloud Firestore 資料庫。

## 費用管理

- 預設按人查看未繳、待確認與逾期款項；可切換按活動或帳單紀錄，並篩選季度。其他期間未清款項會另外提醒。
- 活動收款依付款人計數。季度費在各場僅標示結清狀態，不重複累加金額；未開單、待確認、免收及私人轉讓分開標示。
- 未繳可作廢或作廢重開；重開可逐項修改金額與期限，原單與季度計畫均保留。作廢會退回已使用餘額，不取消活動或報名。
- 已回報轉帳須先確認收款，或核對確實未入帳後退回待繳。已確認帳單可將剩餘可退金額轉為餘額，或登記已完成人工退款（不發起銀行轉帳）。
- 帳單紀錄可查看已作廢與退款歷程、批次作廢目前篩選下的未繳帳單（每批最多 100 筆，顯示逐筆結果）、匯出 CSV。
- 目前採整筆回報／確認及剩餘款項整筆退款，尚不支援分次付款或指定部分退款金額。

執行 `npm test` 可驗證季度、帳務、社長權限及帳號名稱唯一性；測試使用記憶體模擬資料庫，不會改動 Firestore。

## 帳戶餘額異動紀錄

- 幹部可從「社員名單 → 編輯 → 目前帳戶餘額」查看該帳號的增加、扣抵、日期、原因、操作者與相關帳單／活動。從視窗右上角「⋯ → 調整餘額」開啟彈窗，填寫金額與原因，再按「儲存餘額調整」。
- 每筆手動調整都會檢查最新餘額及幹部權限，並以請求識別碼防止同次儲存重複入帳；成功後重新讀取歷史，重試載入紀錄不會重送調整。
- 新異動以 `balanceMovements` 流水與社員餘額在同一個 Firestore 交易保存，涵蓋報名抵扣、活動取消、開單、收款釋放退款、帳單作廢／重開／退款及手動調整。
- 既有紀錄依原始帳單與稽核資料整理，同一來源不重複計算；待確認退款與人工退現金不當作已入帳餘額。未保存的異動日期顯示「時間未記錄」。
- 舊資料若不足以對上目前餘額，會顯示紀錄差額；不建立假期初調整、不推算逐筆結餘，也不改寫社員實際餘額。
- 歷史查詢為幹部專用、不快取，伺服器會重新檢查管理權限；一般使用者無法藉由指定會員 ID 查看帳務紀錄。

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Cloud Firestore

- 網站透過伺服器端 Firebase Admin SDK 存取 Firestore，瀏覽器不直接持有服務帳號。
- 原本的 `data/badminton.sqlite` 保留作為本機備份與一次性匯入來源。
- 部署到 Vercel 前，必須設定 Firebase 服務帳號環境變數。

將 [.env.example](./.env.example) 複製為 `.env.local`，或在 Vercel 專案設定以下環境變數：

```bash
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@example.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_ID=(default)
```


## 季度活動與計費基準

幹部在「新增活動 → 季度規劃」設定日期範圍、固定星期、時間、場地與容量。產生建議清單時會讀取[新北市政府辦公日曆](https://data.gov.tw/dataset/123662)與[人事行政總處停班停課公告](https://www.dgpa.gov.tw/typh/daily/nds.html)，自動排除國定假日、補假、調整放假日及已公告的新北市全市停班停課日期。公告以查詢當時的資料為準；已建立的活動可由幹部依最新公告處理。

1. 產生建議活動，再逐場新增、刪除或修改日期、時間與場地。
2. 確認前的建議清單留在目前視窗。檢查場次後，直接按「確認並建立」。
3. 確認時重新查詢政府公告，再以單一交易建立正式活動、社員預設報名、`quarterPlans` 季度規劃及 `billingPeriods` 計費基準。政府公告排除日、活動日期衝突或計費期間重疊時，整批停止。
4. 「費用管理 → 建立三個月帳單」選擇已確認季度；原始場次、每場費率與金額取自確認版，不依目前活動重新計算。

原始帳單 `grossAmount`、`amount`、`eventIds` 等欄位保留。未繳款取消活動時，以 `adjustedGrossAmount`／`adjustedAmount` 保存應繳結果，並追加 `adjustments`（日期、原因、操作者、時間、金額）。已確認收款則另建退回餘額紀錄；僅回報轉帳者需等幹部確認收款才釋放餘額。開單前取消亦會在開單時另外列出減收。

「單次加場」須明確選擇不另收社員費或另建補收帳單，並填寫原因。已確認季度的原始場數不會改變。舊有活動與帳單保留，不自動歸入新季度。

先前直接建立週五正式活動的自動排程已停用；`/api/cron/activities` 回傳 410，不再建立活動，不需要 `CRON_SECRET`。部署後不再設定 Cron。

匯入既有 SQLite 資料：

```bash
npm run db:migrate:firestore
```

這個指令會寫入雲端資料庫，僅在確認要上傳本機測試資料後執行。每位匯入的既有使用者都會產生一組一次性認領碼；終端機會顯示原始碼，Firestore 只保存加鹽雜湊值。遺失原始認領碼後無法從資料庫還原。

## 裝置帳號

- 帳號分成固定的 `accountName`（帳號名稱）與可修改的 `displayName`（顯示名稱）。帳號名稱全站唯一，建立後連幹部也不能修改；顯示名稱可在「個人資訊」自行修改，允許重複，名單與帳務會另外顯示固定帳號以便辨識。
- 第一次使用以輸入的帳號名稱建立訪客 `userId`，初始顯示名稱與帳號名稱相同。名稱本身不是登入憑證，仍需裝置憑證、復原碼或 Passkey 驗證；跨裝置復原與指定轉讓對象均使用固定帳號名稱。
- 帳號名稱比對會統一英文大小寫、Unicode 全半形及多餘空白；帳號與顯示名稱均不能包含控制字元或不可見字元。已有帳號名稱時拒絕建立第二個帳號，並提示快速登入或取回既有帳號。修改顯示名稱不會釋放原帳號名稱，也不會占用其他帳號名稱。
- 訪客註冊、轉讓建立的未認領帳號、初始化幹部及 SQLite 匯入共用 `memberNames/{名稱鍵雜湊}` 保留機制；名稱與帳號在同一交易／原子批次建立，避免併發重複。
- 舊帳號以原本名稱作為固定帳號名稱，首次修改顯示名稱時在同一交易先補上 `accountName`、`accountNameKey` 與名稱保留索引。`userId`、裝置登入、復原碼、Passkey、角色、報名與帳務關聯均保留。新帳號與轉讓查找仍檢查所有舊帳號，不能轉讓給自己；既有同名帳號不會被自動選取、合併、刪除或更名。
- 執行 `npm run accounts:names:check` 可只讀盤點 Firestore 的重複或不合法帳號名稱、索引不一致及待補欄位；重複顯示名稱僅供參考。這個指令不修改雲端資料，未完成固定帳號欄位補齊或偵測問題時以非零狀態結束。須由幹部確認既有帳號歸屬後再整理。
- 目前保留舊資料比對的完整社員查詢；如果帳號量大幅成長，再於完成名稱盤點與回填後改為只查唯一名稱索引。
- 隨機裝置憑證存放在 `HttpOnly`、`SameSite=Lax` Cookie，Firestore 只保存憑證的雜湊值。
- 每個裝置憑證最多記住 8 個曾登入的 `userId`。登出只取消目前使用者，不會刪除這台裝置的帳號清單；登入頁可直接選擇快速登入。
- 快速登入代表持有此裝置的人可開啟被記住的帳號；共用電腦應使用個人的瀏覽器設定檔。
- 未建立復原碼的帳號只可由目前裝置存取；清除網站資料、使用無痕模式或更換裝置後可能無法取回。
- 舊裝置憑證已遺失時，幹部可在社員名單為指定使用者產生一次性認領碼；系統不會只依姓名自動合併帳號。
- 使用者可在個人資訊頁建立或重新產生復原碼；重新產生及成功取回帳號後都會立即輪替，舊碼失效，新碼只顯示一次。
- 管理權限由 Firestore 的社員文件決定；只輸入與幹部相同的姓名不會取得幹部權限。
- 手機簡訊尚未實作；之後可綁定到同一個 `userId`，不必搬移活動與付款紀錄。

### 初始化幹部帳號

先檢查 Firestore 中的既有幹部與同名帳號：

```bash
npm run admin:check -- --name=BarryAdmin
```

確認後再建立或提升指定帳號：

```bash
npm run admin:bootstrap -- --name=BarryAdmin
```

若同名帳號只有一筆，指令會將該帳號設為 `ADMIN` 幹部並保留原本登入方式；若不存在，則建立待認領帳號並顯示一次性認領碼。同名帳號超過一筆時會拒絕自動提升，避免把權限授予錯誤帳號。

`BarryAdmin` 僅在尚無社長、且帳號未明確記錄 `primaryAdmin: false` 時作為初始社長預設。已有社長時不會另建第二位社長；既有 `primaryAdmin: true`／`false` 會保留。因此重新執行指令不會讓已交接的 BarryAdmin 重新取得社長身分。寫入時會在同一筆交易重新檢查社長與同名帳號，不沿用檢查階段的舊快照。

### 社長權限與交接

- 社長以社員文件的 `primaryAdmin` 識別，仍使用 `ADMIN` 管理角色；其他幹部不等於社長。
- 舊資料僅在 `role: ADMIN`、未設定 `primaryAdmin`，且名稱為 BarryAdmin（不分大小寫）時保留既有社長資格。同名訪客不會取得權限，明確的 `primaryAdmin: false` 也不會因名稱而恢復。
- 社長不能申請退出、被核准退出，或由社員管理直接改為非社員／期末退出；必須先在個人資訊頁轉交社長權限。
- 接任者須為已啟用帳號的有效社員，不能已排定或申請退出。沒有符合條件的其他社員時不能轉交，也不能直接退出。
- 交接在同一筆資料庫交易完成：接任者成為社長，原社長變為一般社員，保留活動、帳單與帳戶餘額，並留下操作紀錄。原社長之後可依原有程序申請退出。

## Passkey

Passkey 使用 WebAuthn，註冊與登入都要求 Windows Hello、Face ID、指紋或裝置 PIN 驗證。公開金鑰、計數器與裝置類型會保存於 Firestore 的 `passkeys` 集合；短效挑戰碼保存在 `passkeyChallenges`，有效時間為五分鐘。

正式部署時請固定以下環境變數，避免更換 Vercel 網址後原有 Passkey 無法使用：

```bash
PASSKEY_RP_ID=badminton.example.com
PASSKEY_ORIGIN=https://badminton.example.com
```

`PASSKEY_RP_ID` 只能是網域名稱，不包含 `https://`；`PASSKEY_ORIGIN` 則包含協定且不可有結尾斜線。本機 `http://localhost:3000` 開發可以不設定，系統會依目前網址推導。

### Android App 的 Passkey

Android App 使用 Credential Manager 顯示手機驗證。正式環境的 `PASSKEY_ORIGIN` 應固定為 App 載入的 HTTPS 網址，且主機名稱須與 `PASSKEY_RP_ID` 完全相同。新增 `PASSKEY_ANDROID_SHA256_FINGERPRINTS`，填入實際發佈 APK 的簽章憑證 SHA-256 指紋（32 組冒號分隔的十六進位值，多張憑證以逗號分隔）。可用 `apksigner verify --print-certs` 查看 APK 的公開簽章指紋。若透過 Google Play 發佈，使用 Play App Signing 的應用程式簽章，而非上傳金鑰。

部署後，該網域的 `/.well-known/assetlinks.json` 應回傳 HTTP 200 及 JSON，列出 `com.badminton.app` 和已設定的指紋。網站與 Android 來源共用同一組 RP ID。使用者可先在 App 的「個人資訊 → 帳號安全」建立 Passkey，重裝後從登入頁選「使用 Passkey 登入」。驗證成功時，App 會為同一帳號建立新的登入 Cookie。

測試環境可使用專用 HTTPS 網域及測試簽章來驗證整個流程。正式環境只設定實際發佈所使用的簽章。

## Deploy on Vercel

將 Firebase 與 Passkey 環境變數加入需要的 Vercel 環境，設定後重新部署。Production 與 Preview 的私鑰請標記為 Sensitive。

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
