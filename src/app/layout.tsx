import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import Sidebar from "@/components/Sidebar";

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
  title: "ScoreArc · World Cup 2026 Live",
  description:
    "Live FIFA World Cup 2026 scores, group standings, and match updates — powered by ScoreArc.",
  openGraph: {
    title: "ScoreArc · World Cup 2026 Live",
    description:
      "Live radial knockout bracket, scores, top scorers, and build-your-own predictions for the 2026 World Cup.",
    url: "https://www.scorearc.futbol",
    siteName: "ScoreArc",
    type: "website",
    images: [{ url: "/api/og", width: 1200, height: 630, alt: "ScoreArc — World Cup 2026" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ScoreArc · World Cup 2026 Live",
    description:
      "Live radial knockout bracket, scores, and build-your-own predictions for the 2026 World Cup.",
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
        <div className="app-shell">
          <Sidebar />
          {children}
        </div>
      </body>
    </html>
  );
}
