# 公司羽球社管理網站

這是一個 Next.js 響應式網站。活動、社員、帳單、公告與休團日共用同一個 Cloud Firestore 資料庫。

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

將上述四個環境變數加入 Vercel 的 Production、Preview 與 Development 環境，再重新部署。Production 與 Preview 的私鑰請標記為 Sensitive。

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
