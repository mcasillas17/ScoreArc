// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@/i18n/I18nProvider';
import { listCompetitions } from '@/server/data/competitions';
import SiteNav from './SiteNav';

const path = vi.hoisted(() => ({ current: '/es' }));

vi.mock('next/navigation', () => ({
  usePathname: () => path.current,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/telemetry/client', () => ({ trackEvent: vi.fn() }));

function renderNav(pathname: string) {
  path.current = pathname;
  return render(
    <I18nProvider locale="es">
      <SiteNav />
    </I18nProvider>,
  );
}

describe('SiteNav interaction', () => {
  afterEach(cleanup);

  it('opens the wheel from the centre button and moves focus into it', () => {
    renderNav('/es/c/liga-mx/2026-apertura/standings');

    const centre = screen.getByRole('button', { name: 'Abrir navegación' });
    expect(centre.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(centre);

    const wheel = screen.getByRole('dialog');
    expect(centre.getAttribute('aria-expanded')).toBe('true');
    expect(wheel.contains(document.activeElement)).toBe(true);
    // Inside a competition, focus lands on that competition's crest.
    expect(document.activeElement?.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement?.getAttribute('href')).toBe('/es/c/liga-mx/2026-apertura');
  });

  // Off a competition nothing is current, and focusing a crest turns the dial
  // to it -- so focus goes to the crest already at the top, leaving the wheel
  // at rest on the middle of the list rather than turned to its first entry.
  it('moves focus to the centre crest when no competition is open', () => {
    renderNav('/es');
    fireEvent.click(screen.getByRole('button', { name: 'Abrir navegación' }));
    const wheel = screen.getByRole('dialog');
    const links = Array.from(wheel.querySelectorAll('.sn-dial a'));
    expect(links.indexOf(document.activeElement as HTMLAnchorElement)).toBe(
      Math.floor((listCompetitions().length - 1) / 2),
    );
  });

  it('closes the wheel on Escape and returns focus to the centre button', () => {
    renderNav('/es');
    const centre = screen.getByRole('button', { name: 'Abrir navegación' });
    fireEvent.click(centre);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(centre.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(centre);
  });

  it('closes the wheel from the backdrop', () => {
    renderNav('/es');
    fireEvent.click(screen.getByRole('button', { name: 'Abrir navegación' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar navegación' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // The rotation is presentation only: a crest off the visible rim is
  // transparent, never removed, so the list a screen reader or a Tab key walks
  // is always the whole list.
  it('renders every competition as a link wherever the dial is turned', () => {
    const total = listCompetitions().length;
    const { container } = renderNav('/es/c/world-cup/2026');
    const dial = container.querySelector<HTMLElement>('.sn .sn-dial')!;
    const links = () => within(dial).getAllByRole('link');

    expect(links()).toHaveLength(total);
    // World Cup is first; the crests opposite it on the ring start off the rim.
    const far = Math.floor(total / 2);
    const slot = (i: number) => links()[i].closest('.sn-dial-slot')!;
    expect(slot(far).hasAttribute('data-off')).toBe(true);
    expect(slot(0).hasAttribute('data-off')).toBe(false);
    // The ring: the last competition is World Cup's neighbour, not its far end.
    expect(slot(total - 1).hasAttribute('data-off')).toBe(false);

    // Focusing a hidden crest turns the dial to it, and the list is still whole.
    fireEvent.focus(links()[far]);
    expect(slot(far).hasAttribute('data-off')).toBe(false);
    expect(slot(0).hasAttribute('data-off')).toBe(true);
    expect(links()).toHaveLength(total);
    for (const a of links()) expect(a.getAttribute('href')).toMatch(/^\/es\/c\//);
  });
});
