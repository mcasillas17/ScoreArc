// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/i18n/I18nProvider';
import SiteNav from './SiteNav';

vi.mock('next/navigation', () => ({
  usePathname: () => '/es',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/telemetry/client', () => ({ trackEvent: vi.fn() }));

describe('SiteNav interaction', () => {
  afterEach(cleanup);

  it('moves focus off the hidden bottom Menu control when it opens the drawer', () => {
    render(
      <I18nProvider locale="es">
        <SiteNav />
      </I18nProvider>,
    );

    const bottomMenu = screen.getByRole('button', { name: 'Menú' });
    bottomMenu.focus();
    fireEvent.click(bottomMenu);

    const mastheadMenu = screen.getByRole('button', { name: 'Cerrar menú' });
    expect(mastheadMenu.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(mastheadMenu);
  });
});
