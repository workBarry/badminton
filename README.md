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

## Deploy on Vercel

將上述四個環境變數加入 Vercel 的 Production、Preview 與 Development 環境，再重新部署。Production 與 Preview 的私鑰請標記為 Sensitive。

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
