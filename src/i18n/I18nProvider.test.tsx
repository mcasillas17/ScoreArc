// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, localeCookie, useLocale, useSetLocale, useTranslations } from './I18nProvider';

vi.mock('next/navigation', () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({
    push: (href: string) => window.history.pushState(null, '', href),
  }),
}));

function LocaleSwitcher() {
  const locale = useLocale();
  const setLocale = useSetLocale();
  const t = useTranslations();

  return (
    <>
      <p>{locale}</p>
      <p>{t('common.close')}</p>
      <button type="button" onClick={() => setLocale('es')}>
        Cambiar idioma
      </button>
    </>
  );
}

describe('I18nProvider', () => {
  afterEach(cleanup);
  beforeEach(() => {
    window.history.replaceState(null, '', '/en/matches?status=live#scores');
    document.cookie = 'scorearc-language=;Path=/;Max-Age=0';
  });

  it('writes the explicit locale cookie and navigates without losing the URL suffix', () => {
    render(
      <I18nProvider locale="en">
        <LocaleSwitcher />
      </I18nProvider>,
    );

    expect(screen.getByText('en')).toBeTruthy();
    expect(screen.getByText('Close')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cambiar idioma' }));

    expect(document.cookie).toContain('scorearc-language=es');
    expect(window.location.pathname).toBe('/es/matches');
    expect(window.location.search).toBe('?status=live');
    expect(window.location.hash).toBe('#scores');
  });

  it('marks the preference cookie Secure only on HTTPS', () => {
    expect(localeCookie('es', true)).toContain(';Secure');
    expect(localeCookie('es', false)).not.toContain(';Secure');
    expect(localeCookie('es', true)).toContain('SameSite=Lax');
  });

  it.each([
    ['/en/teams?q=Am%C3%A9rica&view=women#results', '/es/teams?q=Am%C3%A9rica&view=women#results'],
    ['/en/news?view=men&q=a&view=men#top', '/es/news?q=a#top'],
    ['/en?view=unknown#matches', '/es#matches'],
    ['/en/c/nwsl/2026?view=women&tab=stats#score', '/es/c/nwsl/2026?tab=stats#score'],
    ['/en/c/nwsl/2026/matches?view=calendar#nov', '/es/c/nwsl/2026/matches?view=calendar#nov'],
  ])('switches locale from %s to %s', (source, target) => {
    window.history.replaceState(null, '', source);
    render(<I18nProvider locale="en"><LocaleSwitcher /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar idioma' }));
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(target);
  });
});
