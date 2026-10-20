import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Brandloom", template: "%s · Brandloom" },
  description: "Social media manager for Core Champs, JNK Nutrition, Muscle Rulz, Scoops Monster and ProScience Nutra.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
