import type { ReactNode } from 'react';

// Collapsed-by-default section with a gold pill toggle + rotating caret.
// Shared by the match popup's stats, recent-form and head-to-head sections so
// they all read and behave identically.
export function CollapsibleSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="collapsible">
      <summary className="collapsible-toggle">
        <span>{title}</span>
        <span className="collapsible-caret" aria-hidden />
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
