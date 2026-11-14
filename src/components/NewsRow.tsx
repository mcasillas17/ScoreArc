'use client';

import type { NewsArticle } from '@/server/data/types';
import { trackEvent } from '@/lib/telemetry/client';

/**
 * One story, everywhere a story is listed: the home digest, /news and a
 * competition's news page. `detail` adds the provider's description and
 * byline; `image={false}` is a headline-only row.
 */
export default function NewsRow({
  article,
  ago,
  surface,
  image = true,
  detail = false,
}: {
  article: NewsArticle;
  ago: string | null;
  surface: string;
  image?: boolean;
  detail?: boolean;
}) {
  return (
    <a
      className={image ? 'dg-nw' : 'dg-nw dg-nw--text'}
      href={article.url}
      target="_blank"
      rel="noreferrer"
      onClick={() => trackEvent('News article opened', { surface })}
    >
      {image &&
        (article.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="dg-nwimg" src={article.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span className="dg-nwimg" aria-hidden />
        ))}
      <span className="dg-nwbody">
        <span className="dg-nwhead">{article.headline}</span>
        {/* ESPN often repeats the headline as the description. */}
        {detail && article.description && article.description !== article.headline && <span className="dg-nwdesc">{article.description}</span>}
        {(ago || (detail && article.byline)) && (
          // The age is a duration from "now", and the server's now is not the
          // browser's: a story can cross a minute between the two renders.
          <span className="dg-nwsrc" suppressHydrationWarning>
            {[detail ? article.byline : '', ago].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
    </a>
  );
}
