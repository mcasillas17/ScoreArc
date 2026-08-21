import { readFileSync } from 'node:fs';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesheet = postcss.parse(readFileSync('src/app/globals.css', 'utf8'));

function maxWidthMediaApplies(rule: Rule, viewportWidth: number): boolean {
  const parent = rule.parent;
  if (!parent || parent.type !== 'atrule') return true;
  const mediaRule = parent as unknown as { name: string; params: string };
  if (mediaRule.name !== 'media') return true;
  const maxWidth = mediaRule.params.match(/^\(max-width:\s*(\d+)px\)$/);
  return Boolean(maxWidth && viewportWidth <= Number(maxWidth[1]));
}

function cascadeSimpleClassProperty(
  classNames: string[],
  property: string,
  viewportWidth: number,
): string | undefined {
  const targetClasses = new Set(classNames);
  let winner: { specificity: number; order: number; value: string } | undefined;
  let order = 0;

  stylesheet.walkRules((rule) => {
    order += 1;
    if (!maxWidthMediaApplies(rule, viewportWidth)) return;

    for (const selector of rule.selectors) {
      const simpleClasses = selector.trim().match(/^((?:\.[a-z0-9_-]+)+)$/i)?.[1]
        .split('.')
        .filter(Boolean);
      if (!simpleClasses || !simpleClasses.every((name) => targetClasses.has(name))) continue;

      const declaration = rule.nodes.find(
        (node) => node.type === 'decl' && node.prop === property,
      );
      if (!declaration || declaration.type !== 'decl') continue;

      const candidate = { specificity: simpleClasses.length, order, value: declaration.value };
      if (
        !winner ||
        candidate.specificity > winner.specificity ||
        (candidate.specificity === winner.specificity && candidate.order > winner.order)
      ) {
        winner = candidate;
      }
    }
  });

  return winner?.value;
}

function selectorProperty(
  selector: string,
  property: string,
  viewportWidth: number,
): string | undefined {
  let value: string | undefined;
  stylesheet.walkRules((rule) => {
    if (!maxWidthMediaApplies(rule, viewportWidth) || !rule.selectors.includes(selector)) return;
    const declaration = rule.nodes.find(
      (node) => node.type === 'decl' && node.prop === property,
    );
    if (declaration?.type === 'decl') value = declaration.value;
  });
  return value;
}

describe('responsive competition main layout', () => {
  it.each([360, 768])(
    'does not add a second sidebar offset to specialized pages at %ipx',
    (viewportWidth) => {
      for (const classes of [['main', 'tm'], ['main', 'tsp']]) {
        expect(cascadeSimpleClassProperty(classes, 'margin-left', viewportWidth)).toBe('0');
      }
    },
  );

  it('does not add a desktop sidebar offset to specialized pages', () => {
    for (const classes of [['main', 'tm'], ['main', 'tsp']]) {
      expect(cascadeSimpleClassProperty(classes, 'margin-left', 1280)).not.toBe(
        'var(--sidebar-w)',
      );
    }
  });

  it('keeps the sidebar offset on the shared shell only', () => {
    expect(cascadeSimpleClassProperty(['app-content'], 'margin-left', 1280)).toBe(
      'var(--sidebar-w)',
    );
    expect(cascadeSimpleClassProperty(['app-content'], 'margin-left', 760)).toBe('0');
  });

  it('uses compact spacing through the narrow-page breakpoint', () => {
    for (const viewportWidth of [360, 768]) {
      expect(cascadeSimpleClassProperty(['main', 'tm'], 'padding', viewportWidth)).toBe(
        '24px 16px calc(84px + env(safe-area-inset-bottom))',
      );
    }
    expect(cascadeSimpleClassProperty(['main', 'tm'], 'padding', 1280)).toBe(
      '36px 36px 56px',
    );
  });

  it('keeps squad overflow inside its own scroll container', () => {
    expect(cascadeSimpleClassProperty(['sq-wrap'], 'overflow-x', 360)).toBe('auto');
  });

  it('keeps the phone masthead sticky without showing two navigations', () => {
    expect(selectorProperty('html', 'overflow-x', 360)).toBe('clip');
    expect(selectorProperty('body', 'overflow-x', 360)).toBe('clip');
    expect(selectorProperty('.sn', 'position', 360)).toBe('sticky');
    expect(selectorProperty('.sn-tabs', 'position', 360)).toBe('fixed');
    expect(selectorProperty('.sn--open ~ .sn-tabs', 'display', 360)).toBe('none');
  });
});
