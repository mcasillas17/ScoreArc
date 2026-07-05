import type { CSSProperties, ReactNode } from 'react';

// Collapsed-by-default section with a pill toggle + rotating caret. Shared by the
// match popup's stats, lineups, form/H2H and commentary sections. `tone` sets the
// pill's accent color (text/border/background all derive from it); defaults to gold.
export function CollapsibleSection({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <details className="collapsible" style={tone ? ({ ['--pill-color']: tone } as CSSProperties) : undefined}>
      <summary className="collapsible-toggle">
        <span>{title}</span>
        <span className="collapsible-caret" aria-hidden />
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
