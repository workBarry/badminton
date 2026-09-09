# 公司羽球社管理網站

這是一個 Next.js 響應式網站。活動、社員、帳單、公告與季度草稿共用同一個 Cloud Firestore 資料庫。

## 費用管理

- 預設按人查看未繳、待確認與逾期款項；可切換按活動或帳單紀錄，並篩選季度。其他期間未清款項會另外提醒。
- 活動收款依付款人計數。季度費在各場僅標示結清狀態，不重複累加金額；未開單、待確認、免收及私人轉讓分開標示。
- 未繳可作廢或作廢重開；重開可逐項修改金額與期限，原單與季度計畫均保留。作廢會退回已使用餘額，不取消活動或報名。
- 已回報轉帳須先確認收款，或核對確實未入帳後退回待繳。已確認帳單可將剩餘可退金額轉為餘額，或登記已完成人工退款（不發起銀行轉帳）。
- 帳單紀錄可查看已作廢與退款歷程、批次作廢目前篩選下的未繳帳單（每批最多 100 筆，顯示逐筆結果）、匯出 CSV。
- 目前採整筆回報／確認及剩餘款項整筆退款，尚不支援分次付款或指定部分退款金額。

執行 `npm test` 可驗證季度與帳務流程；測試使用記憶體模擬資料庫，不會改動 Firestore。

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

幹部在「新增活動 → 季度規劃」設定日期範圍、固定星期、時間、場地與容量。指定假日／公司休假日期（每行 YYYY-MM-DD）與週末排除規則只用於產生建議清單；目前不自動下載國定假日。

1. 產生建議活動，再逐場新增、刪除或修改日期、時間與場地。
2. 儲存草稿至 Firestore 的 `quarterPlans`，其他幹部可重新開啟。版本不符時拒絕覆寫。
3. 確認後以單一交易建立正式活動、社員預設報名及 `billingPeriods` 計費基準。日期衝突或期間重疊會整批停止。
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

- 第一次使用會建立新的訪客 `userId`；姓名只用於顯示，因此同名使用者仍是不同帳號。
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

若同名帳號只有一筆，指令會將該帳號設為最高的 `ADMIN` 角色並保留原本登入方式；若不存在，則建立待認領帳號並顯示一次性認領碼。同名帳號超過一筆時會拒絕自動提升，避免把權限授予錯誤帳號。

## Passkey

Passkey 使用 WebAuthn，註冊與登入都要求 Windows Hello、Face ID、指紋或裝置 PIN 驗證。公開金鑰、計數器與裝置類型會保存於 Firestore 的 `passkeys` 集合；短效挑戰碼保存在 `passkeyChallenges`，有效時間為五分鐘。

正式部署時請固定以下環境變數，避免更換 Vercel 網址後原有 Passkey 無法使用：

```bash
PASSKEY_RP_ID=badminton.example.com
PASSKEY_ORIGIN=https://badminton.example.com
```

`PASSKEY_RP_ID` 只能是網域名稱，不包含 `https://`；`PASSKEY_ORIGIN` 則包含協定且不可有結尾斜線。本機 `http://localhost:3000` 開發可以不設定，系統會依目前網址推導。

## Deploy on Vercel

將 Firebase 與 Passkey 環境變數加入需要的 Vercel 環境，設定後重新部署。Production 與 Preview 的私鑰請標記為 Sensitive。

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
