// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/i18n/I18nProvider';
import type { StatLeader } from '@/server/data/types';
import LeadersBlock from './LeadersBlock';

vi.mock('next/navigation', () => ({ usePathname: () => '/en', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));
afterEach(cleanup);
const rows = (prefix: string, n: number): StatLeader[] =>
  Array.from({ length: n }, (_, i) => ({
    rank: i + 1, player: `${prefix}${i + 1}`, teamId: 't', teamName: 'T', teamAbbr: 'TTT', value: 10 - i,
  }) as StatLeader);

it('shows the top five scorers, switches to assists, and links to players', () => {
  render(
    <I18nProvider locale="en">
      <LeadersBlock scorers={rows('S', 10)} assists={rows('A', 10)} playersHref="/en/c/x/y/players" />
    </I18nProvider>,
  );
  expect(screen.getAllByRole('row')).toHaveLength(6); // header + 5
  expect(screen.getByText('S1')).toBeTruthy();
  expect(screen.queryByText('S6')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Assists' }));
  expect(screen.getByText('A1')).toBeTruthy();
  expect(screen.getByRole('link', { name: /All players/ }).getAttribute('href')).toBe('/en/c/x/y/players');
});

it('renders nothing when there are no leaders', () => {
  const { container } = render(<I18nProvider locale="en"><LeadersBlock scorers={[]} assists={[]} /></I18nProvider>);
  expect(container.innerHTML).toBe('');
});
