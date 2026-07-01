import { ImageResponse } from 'next/og';
import { flagUrl } from '@/lib/flags';

export const runtime = 'edge';

// Dynamic social-share card. Default = branded; with ?champ=ABR&name=Team it
// renders the user's predicted World Cup champion.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const champ = searchParams.get('champ')?.toUpperCase() ?? '';
  const name = searchParams.get('name') ?? '';
  const flag = champ ? flagUrl(champ) : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background:
            'radial-gradient(circle at 50% 42%, #3a2c05 0%, #16130a 45%, #0b0b0d 100%)',
          color: '#f4f4f6',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28 }}>
          <div style={{ fontSize: 44 }}>⚽</div>
          <div style={{ fontSize: 52, fontWeight: 800, color: '#e8b84b', letterSpacing: -1 }}>
            ScoreArc
          </div>
        </div>

        {champ ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                letterSpacing: 4,
                color: '#b9b9c2',
              }}
            >
              🏆 MY PREDICTED CHAMPION
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
              {flag && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={flag}
                  alt=""
                  width={132}
                  height={88}
                  style={{ borderRadius: 8, objectFit: 'cover' }}
                />
              )}
              <div style={{ fontSize: 76, fontWeight: 800 }}>{name || champ}</div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 40, fontWeight: 700 }}>World Cup 2026</div>
            <div style={{ fontSize: 26, color: '#b9b9c2' }}>
              Live radial bracket · scores · build your own
            </div>
          </div>
        )}

        <div style={{ marginTop: 40, fontSize: 22, color: '#8a8a96' }}>scorearc.futbol</div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
