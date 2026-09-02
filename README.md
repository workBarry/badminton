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
- 未建立復原碼的帳號只可由目前裝置存取；清除網站資料、使用無痕模式或更換裝置後可能無法取回。
- 使用者可建立復原碼，或用既有帳號的一次性認領碼登入。成功後會立即輪替成新的復原碼。
- 管理權限由 Firestore 的社員文件決定；只輸入與幹部相同的姓名不會取得幹部權限。
- 手機簡訊與 Passkey 尚未實作，之後可綁定到同一個 `userId`，不必搬移活動與付款紀錄。

## Deploy on Vercel

將上述四個環境變數加入 Vercel 的 Production、Preview 與 Development 環境，再重新部署。Production 與 Preview 的私鑰請標記為 Sensitive。

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
