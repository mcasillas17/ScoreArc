import type { Metadata } from "next";
import localFont from "next/font/local";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.scorearc.futbol"),
  title: "ScoreArc · Live Football",
  description:
    "Live football brackets, scores, and standings — every arc.",
  openGraph: {
    title: "ScoreArc · Live Football",
    description:
      "Live football brackets, scores, and standings — every arc.",
    url: "https://www.scorearc.futbol",
    siteName: "ScoreArc",
    type: "website",
    images: [{ url: "/api/og", width: 1200, height: 630, alt: "ScoreArc — Live Football" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ScoreArc · Live Football",
    description:
      "Live football brackets, scores, and standings — every arc.",
    images: ["/api/og"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
