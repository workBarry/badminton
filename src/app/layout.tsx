import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "球友會｜公司羽球社",
  description: "公司內部羽球社活動與費用管理原型",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-Hant" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
