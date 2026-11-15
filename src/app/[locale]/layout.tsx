import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { I18nProvider } from "@/i18n/I18nProvider";
import { isLocale, SUPPORTED_LOCALES } from "@/i18n/config";
import { getTranslator } from "@/i18n/translate";
import AppShell from "@/components/AppShell";
import "../globals.css";

export function generateStaticParams() {
  return SUPPORTED_LOCALES.map((locale) => ({ locale }));
}

type LocaleParams = { locale: string } | Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: LocaleParams }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getTranslator(locale);
  const title = t('meta.root.title');
  const description = t('meta.root.description');
  return {
    metadataBase: new URL("https://www.scorearc.futbol"),
    title,
    description,
    alternates: {
      canonical: `/${locale}`,
      languages: {
        en: "/en",
        es: "/es",
      },
    },
    openGraph: {
      title,
      description,
      url: `https://www.scorearc.futbol/${locale}`,
      siteName: "ScoreArc",
      type: "website",
      // A static card, not /api/og: the dynamic route is for per-competition
      // shares, and the root link is the one that gets pasted into WhatsApp.
      // metadataBase makes this absolute, which WhatsApp requires.
      images: [{ url: "/brand/og.png", width: 1200, height: 630, alt: t('meta.root.imageAlt') }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/brand/og.png"],
    },
  };
}

export default async function RootLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: LocaleParams;
}>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <html lang={locale}>
      <body>
        <I18nProvider locale={locale}>
          <AppShell>{children}</AppShell>
        </I18nProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
