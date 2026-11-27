import { fetchObservedRedirects } from '@/lib/telemetry/redirects';
import { observeApiRoute } from '@/lib/telemetry/inbound';
import { emitHttpHealth, httpHealthEnabled } from '@/lib/telemetry/http';
import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';
import { flagUrl } from '@/lib/flags';
import { canonicalOgPayload, MIN_OG_SIGNING_SECRET_LENGTH, safeCrest } from '@/lib/ogUrl';
import { getCompetition } from '@/server/data/competitions';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getTranslator } from '@/i18n/translate';

export const runtime = 'edge';

// EDITING THE CARD? Bump OG_VERSION in src/lib/ogUrl.ts — WhatsApp and
// friends cache previews by exact URL, so a rendering change without a bump
// never reaches anyone's chats.
//
// Satori rules that have already crashed this route: no undefined style
// values (its parser trims strings unconditionally), explicit display:flex on
// any div with more than one child, no CSS filter support — and it aborts the
// WHOLE render when any <img> URL fails to fetch, which is why every image
// below goes through liveImage() first.

const assetHosts = new Map([
  ['a.espncdn.com', 'espn_cdn'], ['cdn.scorearc.futbol', 'scorearc_cdn'],
  ['r2.thesportsdb.com', 'thesportsdb_cdn'], ['flagcdn.com', 'flagcdn'],
]);

/**
 * Confirm an image URL actually answers before satori embeds it: a rotted
 * crest in a years-old share link must degrade to a card without the crest,
 * not to an empty reply. The local brand asset is embedded for the renderer.
 */
async function liveImage(url: string | null, endpoint: 'og-crest' | 'og-flag' | 'og-logo' | 'og-mark'): Promise<string | null> {
  if (!url) return null;
  const inline = endpoint === 'og-mark';
  const method = inline ? 'GET' : 'HEAD';
  const measuring = httpHealthEnabled();
  let started = measuring ? performance.now() : 0;
  let measuredUrl: string | undefined = measuring ? url : undefined;
  const timeout = AbortSignal.timeout(1500);
  let status: number | null = null;
  let outcome = 'network';
  let bytes = 0;
  function recordHop(status: number | null, outcome: string, bytes: number) {
    if (!measuredUrl) return;
    const host = URL.canParse(measuredUrl) ? new URL(measuredUrl).hostname : '';
    emitHttpHealth({ direction: 'outbound', endpoint, dependency: inline ? 'site_asset' : assetHosts.get(host) ?? 'other_asset',
      method, status, outcome, durationMs: Math.max(0, Math.round(performance.now() - started)), bytes });
  }
  try {
    // Timeboxed and redirect-checked: a slow CDN degrades like a dead one, and
    // redirects cannot leave the asset allowlist (or occur on the local mark).
    let resolvedUrl = url;
    const res = await fetchObservedRedirects(
      url,
      address => fetch(address, { method, redirect: 'manual', signal: timeout }),
      inline ? undefined : target => target.protocol === 'https:' && !target.port && assetHosts.has(target.hostname),
      (redirect, next) => {
        recordHop(redirect.status, next ? 'success' : 'redirect', 0);
        if (next) resolvedUrl = next;
        measuredUrl = measuring ? next : undefined;
        started = performance.now();
      },
    );
    status = res.status;
    if (!res.ok) { outcome = 'http_error'; return null; }
    if (!inline) {
      const mediaType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (mediaType && !mediaType.startsWith('image/')) {
        outcome = 'body';
        return null;
      }
      outcome = 'success';
      return resolvedUrl;
    }
    outcome = 'body';
    if (res.headers.get('content-type')?.split(';')[0] !== 'image/png' || !res.body) return null;
    // Our 25 KiB brand PNG stays local; Satori rejects loopback URLs in development.
    const reader = res.body.getReader();
    let binary = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 65536) {
          await reader.cancel();
          return null;
        }
        binary += String.fromCharCode(...value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!binary) return null;
    const result = `data:image/png;base64,${btoa(binary)}`;
    outcome = 'success';
    return result;
  } catch {
    if (timeout.aborted) outcome = 'timeout';
    return null;
  } finally {
    recordHop(status, outcome, bytes);
  }
}

// #rrggbb -> rgba() at the given alpha, for the tinted glow stops. Anything
// else falls back to brand green rather than emitting rgba(NaN…), which is a
// satori throw for that one competition.
function rgba(hex: string, alpha: number): string {
  const safe = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#22c55e';
  const n = parseInt(safe.slice(1), 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}

// Long names shrink continuously instead of clipping — 22 characters wear the
// full size, longer names scale down smoothly (no visible cliff between two
// sibling cards). Satori's maxWidth does NOT shrink or wrap text, so this is
// the only thing standing between a long name and the card's edge.
function nameSize(text: string, base: number): number {
  return Math.max(28, Math.min(base, Math.round((base * 22) / Math.max(text.length, 1))));
}

/** The shared shape of the subject and champion cards: an eyebrow line, an
 *  optional image, the big name, a caption. One component so the next card
 *  variant is props, not another copied branch. */
function BigNameCard({
  eyebrow,
  image,
  imageStyle,
  title,
  titleBase,
  caption,
}: {
  eyebrow: string;
  image: string | null;
  imageStyle: { width: number; height: number; borderRadius?: number; objectFit: 'cover' | 'contain' };
  title: string;
  titleBase: number;
  caption: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
      <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 4, color: '#b9b9c2' }}>
        {eyebrow}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        {image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" style={imageStyle} />
        )}
        <div style={{ fontSize: nameSize(title, titleBase), fontWeight: 800 }}>{title}</div>
      </div>
      <div style={{ fontSize: 24, color: '#b9b9c2' }}>{caption}</div>
    </div>
  );
}

/**
 * Dynamic social-share card, in the brand's own look (public/brand/og.png):
 * ring mark, white wordmark, green underline — never the pre-brand gold, and
 * never an emoji standing in for a real mark.
 *
 * ?compId= keys the card to a competition: its glow takes the competition's
 * colour (bracketAccent, else accent.base) and its logo renders beside the
 * label. ?subject= is a team or player card. ?champ=ABR&name=... renders a
 * predicted champion — a national flag only where the competition is played
 * by nations, else the ?crest= (host-checked) club badge.
 */
function cleanText(raw: string | null, maxLen: number): string {
  if (!raw) return '';
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function canonicalCompLabel(competition: NonNullable<ReturnType<typeof getCompetition>>, rawComp: string): string {
  if (!rawComp) return competition.shortName;
  const allowed = new Set<string>([competition.shortName, competition.name]);
  for (const s of Object.values(competition.seasons)) {
    allowed.add(`${competition.shortName} ${s.label}`);
    allowed.add(`${competition.name} ${s.label}`);
  }
  return allowed.has(rawComp) ? rawComp : competition.shortName;
}

async function verifyOgSignature(searchParams: URLSearchParams, secret: string): Promise<boolean> {
  const sig = searchParams.get('sig');
  if (!sig || !/^[0-9a-f]{32}$/.test(sig)) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalOgPayload(searchParams))));
  const expected = Array.from(mac.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('');
  let diff = 0;
  for (let i = 0; i < 32; i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export const GET = observeApiRoute('og', async (req: NextRequest) => {
  const { searchParams } = req.nextUrl;
  const secret = process.env.OG_SIGNING_SECRET;
  if (secret && secret.length >= MIN_OG_SIGNING_SECRET_LENGTH && !(await verifyOgSignature(searchParams, secret))) {
    return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const requestedLocale = searchParams.get('locale');
  const locale = isLocale(requestedLocale) ? requestedLocale : DEFAULT_LOCALE;
  const competitionId = searchParams.get('compId');
  const t = getTranslator(locale, competitionId ?? undefined);
  const competition = getCompetition(competitionId ?? '');
  const generic = competitionId !== null && !competition;
  const rawChamp = generic ? '' : cleanText(searchParams.get('champ'), 16).toUpperCase();
  const champ = /^[A-Z0-9-]{2,8}$/.test(rawChamp) ? rawChamp : '';
  // Length-capped: nameSize() floors at 28px, so an arbitrarily long crafted
  // value would bleed off both card edges. Real names top out near 30.
  const name = cleanText(searchParams.get('name'), 60);
  const subject = generic ? '' : cleanText(searchParams.get('subject'), 60);
  const rawComp = generic ? '' : cleanText(searchParams.get('comp'), 60);
  const comp = competition ? canonicalCompLabel(competition, rawComp) : (rawComp || t('og.liveFootball'));
  // A club abbreviation can collide with a FIFA code — Portland is POR, which
  // is also Portugal. The competition says which world we are in: flags only
  // where teams ARE nations. Legacy share URLs without compId are all World
  // Cup, so no competition defaults to the flag.
  const flagStyle = competition ? competition.teamStyle === 'flag' : true;
  const accent = competition?.bracketAccent ?? competition?.accent?.base ?? '#22c55e';
  // A mark the site CSS-inverts (Leagues Cup: black ink) renders on a light
  // pill instead — satori cannot invert, and the true mark beats an emoji.
  const logoOnChip = !!competition?.logoInvert;
  // The brand mark is guarded too, though it ships with the deploy: a
  // protected preview answers /brand/*.png with 401 HTML, and an unguarded
  // mark would turn every card on that deployment into an aborted render.
  // The 1.5s timeout bounds what the self-round-trip can cost.
  const markOrigin = process.env.VERCEL_ENV === 'production' ? 'https://www.scorearc.futbol' : req.nextUrl.origin;
  const [crest, flag, cardLogo, mark] = await Promise.all([
    liveImage(generic ? null : safeCrest(searchParams.get('crest')), 'og-crest'),
    liveImage(champ && flagStyle ? flagUrl(champ) : null, 'og-flag'),
    liveImage(competition?.logo ?? null, 'og-logo'),
    liveImage(generic ? null : `${markOrigin}/brand/scorearc-mark-512.png`, 'og-mark'),
  ]);

  return new ImageResponse(
    (
      <div
        lang={locale}
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: `radial-gradient(circle at 50% 40%, ${rgba(accent, 0.3)} 0%, ${rgba(
            accent,
            0.08,
          )} 45%, #0b0b0d 100%)`,
          color: '#f4f4f6',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 34 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            {mark && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mark} alt="" width={64} height={64} />
            )}
            <div style={{ fontSize: 56, fontWeight: 800, color: '#ffffff', letterSpacing: -1 }}>
              ScoreArc
            </div>
          </div>
          <div
            style={{
              width: 210,
              height: 7,
              marginTop: 10,
              marginLeft: 82,
              borderRadius: 4,
              background: '#22c55e',
            }}
          />
        </div>

        {subject ? (
          <BigNameCard
            eyebrow={comp}
            image={crest}
            imageStyle={{ width: 108, height: 108, objectFit: 'contain' }}
            title={subject}
            titleBase={68}
            caption={t('og.footer')}
          />
        ) : champ ? (
          <BigNameCard
            eyebrow={t('og.predictedChampion')}
            image={flag ?? crest}
            imageStyle={
              flag
                ? { width: 132, height: 88, borderRadius: 8, objectFit: 'cover' }
                : { width: 108, height: 108, objectFit: 'contain' }
            }
            title={name || champ}
            titleBase={76}
            caption={comp}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
              {cardLogo && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: logoOnChip ? 96 : 72,
                    height: 72,
                    borderRadius: 36,
                    background: logoOnChip ? '#f4f4f6' : 'transparent',
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={cardLogo} alt="" width={56} height={56} style={{ objectFit: 'contain' }} />
                </div>
              )}
              <div style={{ fontSize: nameSize(comp, 44), fontWeight: 700 }}>{comp}</div>
            </div>
            <div style={{ fontSize: 26, color: '#b9b9c2' }}>{t('og.footer')}</div>
          </div>
        )}

        <div style={{ marginTop: 40, fontSize: 22, color: '#8a8a96' }}>scorearc.futbol</div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
});
