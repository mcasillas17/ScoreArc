// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@/i18n/I18nProvider';
import { listCompetitions } from '@/server/data/competitions';
import SiteNav from './SiteNav';
import SiteFooter from './SiteFooter';

const path = vi.hoisted(() => ({ current: '/es', search: '' }));

vi.mock('next/navigation', () => ({
  usePathname: () => path.current,
  useSearchParams: () => new URLSearchParams(path.search),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/telemetry/client', () => ({ trackEvent: vi.fn() }));

function renderNav(pathname: string, search = '') {
  path.search = search;
  path.current = pathname;
  return render(
    <I18nProvider locale="es">
      <SiteNav />
    </I18nProvider>,
  );
}

describe('SiteNav interaction', () => {
  afterEach(cleanup);

  // WCAG 2.5.3: a voice user says the word on the button, so the accessible
  // name has to contain it.
  it('names the centre button with the label it shows', () => {
    renderNav('/es');
    const centre = screen.getByRole('button', { name: /Abrir navegación$/ });
    const label = centre.querySelector('.sn-centre-label')?.textContent;
    expect(label).toBeTruthy();
    expect(centre.getAttribute('aria-label')).toBe(`${label}, Abrir navegación`);
  });

  it('opens the wheel from the centre button and moves focus into it', () => {
    renderNav('/es/c/liga-mx/2026-apertura/standings');

    const centre = screen.getByRole('button', { name: /Abrir navegación$/ });
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
    fireEvent.click(screen.getByRole('button', { name: /Abrir navegación$/ }));
    const wheel = screen.getByRole('dialog');
    const links = Array.from(wheel.querySelectorAll('.sn-dial a'));
    expect(links.indexOf(document.activeElement as HTMLAnchorElement)).toBe(
      Math.floor((listCompetitions().length - 1) / 2),
    );
  });

  it('closes the wheel on Escape and returns focus to the centre button', () => {
    renderNav('/es');
    const centre = screen.getByRole('button', { name: /Abrir navegación$/ });
    fireEvent.click(centre);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(centre.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(centre);
  });

  it('links a competition reader directly to the All matchday from its category selector', () => {
    path.current = '/es/c/liga-mx-femenil/2026-apertura/matches';
    render(<I18nProvider locale="es"><SiteFooter /></I18nProvider>);
    const links = within(screen.getByRole('contentinfo')).getAllByRole('link');
    expect(links.map(a => a.getAttribute('href'))).toEqual(['/es', '/es?view=women', '/es?view=men']);
    expect(links[1].getAttribute('aria-current')).toBe('true');
  });

  it('carries the category through the brand and all collection links, including the current page', () => {
    const { container } = renderNav('/es/teams', 'view=women');
    const rail = container.querySelector('.sn')!;
    expect(rail.querySelector('.sn-brand')?.getAttribute('href')).toBe('/es?view=women');
    expect(Array.from(rail.querySelectorAll('.sn-sec[href]'), a => a.getAttribute('href'))).toEqual([
      '/es?view=women', '/es/teams?view=women', '/es/news?view=women',
    ]);
    expect(within(rail as HTMLElement).getByRole('link', { name: 'Explorar competiciones' }).getAttribute('href')).toBe('/es/competitions?view=women');
    expect(rail.querySelector('.sn-sec[aria-current="page"]')?.textContent).toBe('Equipos');
  });

  it('uses the filtered news list for the first keyboard target and closes a wheel on category-only Back', () => {
    const rendered = renderNav('/es/news', 'view=women');
    const centre = screen.getByRole('button', { name: /Abrir navegación$/ });
    fireEvent.click(centre);
    const crests = Array.from(screen.getByRole('dialog').querySelectorAll('.sn-crest'));
    expect(crests.map(a => a.getAttribute('href'))).toEqual(['/es/c/wsl/2026-27/news', '/es/c/nwsl/2026/news']);
    expect(document.activeElement).toBe(crests[0]);
    path.search = 'view=men';
    rendered.rerender(<I18nProvider locale="es"><SiteNav /></I18nProvider>);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(centre);
  });

  it('switches from News to the league crests in place and offers a separate directory destination', () => {
    renderNav('/es/news', 'view=women');
    fireEvent.click(screen.getByRole('button', { name: /Abrir navegación$/ }));
    const wheel = screen.getByRole('dialog');
    fireEvent.click(within(wheel).getByRole('button', { name: 'Ligas' }));
    expect(within(wheel).getByRole('link', { name: 'Explorar competiciones' }).getAttribute('href')).toBe('/es/competitions?view=women');
    expect(Array.from(wheel.querySelectorAll('.sn-crest'), a => a.getAttribute('href'))).toEqual([
      '/es/c/wsl/2026-27', '/es/c/nwsl/2026', '/es/c/liga-mx-femenil/2026-apertura',
    ]);
  });

  it('moves desktop keyboard focus to an eligible crest if the focused competition disappears', () => {
    const rendered = renderNav('/es');
    const rail = rendered.container.querySelector('.sn')!;
    const crest = rail.querySelector<HTMLElement>('a[href="/es/c/liga-mx/2026-apertura"]')!;
    act(() => crest.focus());
    path.search = 'view=women';
    rendered.rerender(<I18nProvider locale="es"><SiteNav /></I18nProvider>);
    expect(document.activeElement).toBe(rail.querySelector('[data-centre] a'));
    expect(document.activeElement?.getAttribute('href')).toContain('/nwsl/');
  });

  it('updates the Teams dial as search results arrive and disappear in a scoped directory', async () => {
    const content = document.createElement('main');
    content.id = 'app-content';
    document.body.appendChild(content);
    const rendered = renderNav('/es/teams', 'view=women');
    try {
      await act(async () => { content.innerHTML = '<div class="ts"><a data-team-letter="C" id="ts-C">City</a><a data-team-letter="A" id="ts-A">América</a></div>'; });
      const rail = rendered.container.querySelector('.sn-dial')!;
      fireEvent.pointerEnter(rendered.container.querySelector('.sn')!);
      expect(Array.from(rail.querySelectorAll('a'), a => a.getAttribute('href'))).toEqual(['#ts-A', '#ts-C']);
      await act(async () => { content.querySelector('.ts')!.replaceChildren(); });
      expect(rail.querySelectorAll('a')).toHaveLength(0);
    } finally { content.remove(); }
  });

  it('hands keyboard focus to the chosen team when the letter wheel closes', () => {
    const content = document.createElement('main');
    content.id = 'app-content';
    content.innerHTML = '<div class="ts"><a href="/team/gotham" id="ts-G" data-team-letter="G">Gotham</a></div>';
    document.body.appendChild(content);
    try {
      renderNav('/es/teams', 'view=women');
      fireEvent.click(screen.getByRole('button', { name: /Abrir navegación$/ }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'G' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(content.querySelector('#ts-G'));
    } finally { content.remove(); }
  });

  it('closes the wheel from the backdrop', () => {
    renderNav('/es');
    fireEvent.click(screen.getByRole('button', { name: /Abrir navegación$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar navegación' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('brings Tab back into the wheel when focus has fallen out of it', () => {
    renderNav('/es');
    fireEvent.click(screen.getByRole('button', { name: /Abrir navegación$/ }));
    const wheel = screen.getByRole('dialog');
    (document.activeElement as HTMLElement).blur();
    expect(wheel.contains(document.activeElement)).toBe(false);

    fireEvent.keyDown(document.body, { key: 'Tab' });

    expect(wheel.contains(document.activeElement)).toBe(true);
  });

  it('returns focus to the centre button when a path change closes the wheel', () => {
    const view = renderNav('/es');
    const centre = screen.getByRole('button', { name: /Abrir navegación$/ });
    fireEvent.click(centre);
    expect(screen.getByRole('dialog')).toBeTruthy();

    // Browser back: the path changes with no click inside the wheel.
    path.current = '/es/teams';
    view.rerender(
      <I18nProvider locale="es">
        <SiteNav />
      </I18nProvider>,
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(centre);
  });

  // The rotation is presentation only: a crest off the visible rim is
  // transparent, never removed, so the list a screen reader or a Tab key walks
  // is always the whole list.
  it('renders every competition of the open one\'s category as a link wherever the dial is turned', () => {
    // A competition page has a category-free URL, so its own category narrows
    // the dial: the World Cup's dial carries the men's competitions.
    const total = listCompetitions().filter((c) => c.category === 'men').length;
    const { container } = renderNav('/es/c/world-cup/2026');
    const dial = container.querySelector<HTMLElement>('.sn .sn-dial')!;
    const links = () => within(dial).getAllByRole('link');

    expect(links()).toHaveLength(total);
    // World Cup is the first competition; the crests opposite it start off the rim.
    const here = 0;
    const far = Math.floor(total / 2);
    const slot = (i: number) => links()[i].closest('.sn-dial-slot')!;
    expect(slot(here).hasAttribute('data-current')).toBe(true);
    expect(slot(far).hasAttribute('data-off')).toBe(true);
    expect(slot(here).hasAttribute('data-off')).toBe(false);
    // Its neighbours on the ring are either side of it: the last competition before, the next after.
    expect(slot(total - 1).hasAttribute('data-off')).toBe(false);
    expect(slot(here + 1).hasAttribute('data-off')).toBe(false);

    // Focusing a hidden crest turns the dial to it, and the list is still whole.
    fireEvent.focus(links()[far]);
    expect(slot(far).hasAttribute('data-off')).toBe(false);
    expect(slot(here).hasAttribute('data-off')).toBe(true);
    expect(links()).toHaveLength(total);
    for (const a of links()) expect(a.getAttribute('href')).toMatch(/^\/es(\/|$)/);
  });

  // Two levels: the sections inside, and outside them the dial of whichever
  // section is picked. Pages and leagues never share a ring.
  it('keeps the sections off the dial, and turns the dial to the section picked', () => {
    const { container } = renderNav('/es');
    const rail = container.querySelector<HTMLElement>('.sn')!;
    const levels = within(rail.querySelector<HTMLElement>('.sn-levels')!);
    const hrefs = () =>
      Array.from(rail.querySelectorAll('.sn-dial a')).map((a) => a.getAttribute('href'));
    const selected = () => rail.querySelector('.sn-sec[data-selected]')?.textContent;

    expect(levels.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/es', '/es/teams', '/es/news']);
    expect(levels.getAllByRole('button').map((b) => b.textContent)).toEqual(['Ligas', 'Jugadores']);
    // Home opens on the leagues, plain: each crest leads to its competition.
    expect(selected()).toBe('Ligas');
    expect(hrefs()).toHaveLength(listCompetitions().length);
    for (const h of hrefs()) expect(h).toMatch(/^\/es\/c\/[^/]+\/[^/]+$/);
    expect(rail.querySelector('.sn-crest-badge')).toBeNull();

    // Players has no page of its own: its dial is the leagues again, but every
    // crest is badged and named for where it leads.
    fireEvent.click(levels.getByRole('button', { name: 'Jugadores' }));
    expect(selected()).toBe('Jugadores');
    for (const h of hrefs()) expect(h).toMatch(/\/players$/);
    expect(rail.querySelectorAll('.sn-crest-badge')).toHaveLength(listCompetitions().length);
    expect(within(rail).getByRole('link', { name: 'Jugadores de Liga MX' })).toBeTruthy();

    fireEvent.click(levels.getByRole('button', { name: 'Ligas' }));
    expect(selected()).toBe('Ligas');
    expect(rail.querySelector('.sn-crest-badge')).toBeNull();
  });

  it('opens News and Teams on their own dials', () => {
    const news = renderNav('/es/news').container.querySelector<HTMLElement>('.sn')!;
    expect(news.querySelector('.sn-sec[data-selected]')?.textContent).toBe('Noticias');
    for (const a of news.querySelectorAll('.sn-dial a')) expect(a.getAttribute('href')).toMatch(/\/news$/);
    cleanup();

    // Nothing is listed in this render, so the Teams dial has nothing to index
    // -- and it does not fall back to the leagues.
    const teams = renderNav('/es/teams').container.querySelector<HTMLElement>('.sn')!;
    expect(teams.querySelector('.sn-sec[data-selected]')?.textContent).toBe('Equipos');
    expect(teams.querySelectorAll('.sn-dial a')).toHaveLength(0);
  });

  // A finger is captured by the crest it lands on. When the dial takes the
  // capture over, the crest reports losing it, and that report bubbles: the
  // dial must not read it as its own drag ending.
  it('keeps turning when the drag began on a crest, as a finger does', () => {
    renderNav('/es');
    fireEvent.click(screen.getByRole('button', { name: /Abrir navegación$/ }));
    const dial = screen.getByRole('dialog').querySelector('.sn-dial') as HTMLElement;
    const slots = Array.from(dial.querySelectorAll('.sn-dial-slot'));
    const centre = () => slots.findIndex((s) => s.hasAttribute('data-centre'));
    const crest = slots[centre()].querySelector('a') as HTMLElement;

    // jsdom lays nothing out, so the dial's centre is the origin: these are
    // points on a circle round it, a quarter turn in all.
    fireEvent.pointerDown(crest, { button: 0, buttons: 1, clientX: 300, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(crest, { buttons: 1, clientX: 260, clientY: 150, pointerId: 1 });
    fireEvent.lostPointerCapture(crest, { pointerId: 1 });
    const afterHandover = centre();
    fireEvent.pointerMove(dial, { buttons: 1, clientX: 0, clientY: 300, pointerId: 1 });

    expect(centre()).not.toBe(afterHandover);
  });

  it('carries on turning after a flick, then comes to rest on a crest', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout'] });
    try {
      renderNav('/es');
      fireEvent.click(screen.getByRole('button', { name: /Abrir navegación$/ }));
      const dial = screen.getByRole('dialog').querySelector('.sn-dial') as HTMLElement;
      const slots = Array.from(dial.querySelectorAll<HTMLElement>('.sn-dial-slot'));
      const centre = () => slots.findIndex((s) => s.hasAttribute('data-centre'));

      fireEvent.pointerDown(dial, { button: 0, buttons: 1, clientX: 300, clientY: 0, pointerId: 1 });
      for (let deg = 5; deg <= 30; deg += 5) {
        vi.advanceTimersByTime(16);
        const a = (deg * Math.PI) / 180;
        fireEvent.pointerMove(dial, { buttons: 1, clientX: 300 * Math.cos(a), clientY: 300 * Math.sin(a), pointerId: 1 });
      }
      const atRelease = centre();
      fireEvent.pointerUp(window, { pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(centre()).not.toBe(atRelease);
      expect(dial.className).not.toContain('sn-dial--dragging');
      // At rest every offset is whole: the dial is on a crest, not between two.
      for (const s of slots) expect(Math.abs(Number(s.style.getPropertyValue('--k')) % 1)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
