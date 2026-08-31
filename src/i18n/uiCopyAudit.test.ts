import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import type * as ts from 'typescript/unstable/ast';
import { API, type Checker, type Project, type Symbol } from 'typescript/unstable/sync';
import * as tsCompiler from 'typescript/unstable/ast';
import { afterAll, describe, expect, test } from 'vitest';

const PRODUCTION_TSX_ROOTS = ['src/app', 'src/components'] as const;
const auditFileSystem = createVirtualFileSystem({});
const auditApi = new API({ fs: auditFileSystem });
let auditSourceId = 0;

afterAll(() => auditApi.close());

const RAW_IDENTITY_TEXT = new Set([
  'ScoreArc', 'ESPN', 'FIFA', 'X', 'EN', 'ES', 'MLS', 'Liga MX', 'Liguilla',
  'Premier League', 'LaLiga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Leagues Cup',
  'scorearc.futbol', 'elOpenMike',
]);

const AUDITED_ATTRIBUTE_NAMES = new Set(['aria-label', 'title', 'placeholder']);
const AUDITED_OBJECT_PROPERTY_NAMES = new Set([
  'label',
  'text',
  'heading',
  'subtitle',
  'emptyText',
  'title',
  'description',
]);
const AMBIENT_LOCALE_METHODS = new Set([
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleString',
]);
const LEGACY_LOCALIZATION_PREFIX = 'Language';
const LEGACY_TEXT_COMPONENT = `${LEGACY_LOCALIZATION_PREFIX}Text`;
const LEGACY_PROVIDER_COMPONENT = `${LEGACY_LOCALIZATION_PREFIX}Provider`;
const LEGACY_LOCALIZATION_EXPORTS = new Set([
  LEGACY_TEXT_COMPONENT,
  LEGACY_PROVIDER_COMPONENT,
]);
const UNICODE_LETTER = new RegExp('\\p{L}', 'u');

type AuditDiagnostic = {
  filePath: string;
  line: number;
  category: string;
  detail: string;
};

type AuditableCopy =
  | { kind: 'literal'; value: string }
  | { kind: 'parts'; staticText: string[] };

type CopyAnalysisContext = {
  checker: Checker;
  project: Project;
  reassignedSymbols: Set<Symbol>;
};

type LocalConstInitializer = {
  declaration: ts.VariableDeclaration;
  initializer: ts.Expression;
};

function blockScopedDeclarationScope(declaration: ts.VariableDeclaration): ts.Node | null {
  const declarationList = declaration.parent;
  let current: ts.Node | undefined = declarationList.parent;
  if (
    (tsCompiler.isForStatement(current)
      || tsCompiler.isForInStatement(current)
      || tsCompiler.isForOfStatement(current))
    && current.initializer === declarationList
  ) {
    return current;
  }

  while (current) {
    if (
      tsCompiler.isBlock(current)
      || tsCompiler.isCaseBlock(current)
      || tsCompiler.isSourceFile(current)
      || tsCompiler.isModuleBlock(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function hasCompetingBlockScopedDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  const scope = blockScopedDeclarationScope(declaration);
  if (!scope || !tsCompiler.isIdentifier(declaration.name)) return true;
  const declarationName = declaration.name.text;

  let competingDeclaration = false;
  const visit = (node: ts.Node) => {
    if (competingDeclaration) return;
    if (
      node !== declaration
      && tsCompiler.isVariableDeclaration(node)
      && tsCompiler.isIdentifier(node.name)
      && node.name.text === declarationName
      && tsCompiler.isVariableDeclarationList(node.parent)
      && (node.parent.flags & tsCompiler.NodeFlags.BlockScoped)
      && blockScopedDeclarationScope(node) === scope
    ) {
      competingDeclaration = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(scope);
  return competingDeclaration;
}

function normalizeJsxText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    tsCompiler.isParenthesizedExpression(expression)
    || tsCompiler.isAsExpression(expression)
    || tsCompiler.isAssertionExpression(expression)
    || tsCompiler.isSatisfiesExpression(expression)
    || tsCompiler.isNonNullExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function stringLiteralValue(expression: ts.Expression | undefined): string | null {
  if (!expression) return null;
  const unwrapped = unwrapExpression(expression);
  return tsCompiler.isStringLiteral(unwrapped) || tsCompiler.isNoSubstitutionTemplateLiteral(unwrapped)
    ? unwrapped.text
    : null;
}

function localConstInitializer(
  identifier: ts.Identifier,
  context: CopyAnalysisContext,
): LocalConstInitializer | null {
  const symbol = context.checker.getSymbolAtLocation(identifier);
  if (!symbol || context.reassignedSymbols.has(symbol) || symbol.declarations?.length !== 1) {
    return null;
  }

  const declaration = symbol.declarations[0]?.resolve(context.project);
  if (!declaration) return null;
  if (
    !tsCompiler.isVariableDeclaration(declaration)
    || !tsCompiler.isIdentifier(declaration.name)
    || !declaration.initializer
    || !tsCompiler.isVariableDeclarationList(declaration.parent)
    || !(declaration.parent.flags & tsCompiler.NodeFlags.Const)
    || hasCompetingBlockScopedDeclaration(declaration)
  ) {
    return null;
  }

  return { declaration, initializer: declaration.initializer };
}

function completeStaticString(
  expression: ts.Expression,
  context: CopyAnalysisContext,
  resolvingDeclarations: Set<ts.VariableDeclaration>,
): string | null {
  const unwrapped = unwrapExpression(expression);
  if (tsCompiler.isIdentifier(unwrapped)) {
    const resolved = localConstInitializer(unwrapped, context);
    if (!resolved || resolvingDeclarations.has(resolved.declaration)) return null;
    resolvingDeclarations.add(resolved.declaration);
    try {
      return completeStaticString(resolved.initializer, context, resolvingDeclarations);
    } finally {
      resolvingDeclarations.delete(resolved.declaration);
    }
  }

  const literalValue = stringLiteralValue(unwrapped);
  if (literalValue !== null) return literalValue;

  if (tsCompiler.isTemplateExpression(unwrapped)) {
    let value = unwrapped.head.text;
    for (const span of unwrapped.templateSpans) {
      const expressionValue = completeStaticString(span.expression, context, resolvingDeclarations);
      if (expressionValue === null) return null;
      value += expressionValue + span.literal.text;
    }
    return value;
  }

  if (
    tsCompiler.isBinaryExpression(unwrapped)
    && unwrapped.operatorToken.kind === tsCompiler.SyntaxKind.PlusToken
  ) {
    const left = completeStaticString(unwrapped.left, context, resolvingDeclarations);
    const right = completeStaticString(unwrapped.right, context, resolvingDeclarations);
    return left !== null && right !== null ? left + right : null;
  }

  return null;
}

function collectStaticRenderedText(
  expression: ts.Expression,
  staticText: string[],
  context: CopyAnalysisContext,
  resolvingDeclarations: Set<ts.VariableDeclaration>,
): void {
  const unwrapped = unwrapExpression(expression);
  if (tsCompiler.isIdentifier(unwrapped)) {
    const resolved = localConstInitializer(unwrapped, context);
    if (!resolved || resolvingDeclarations.has(resolved.declaration)) return;
    resolvingDeclarations.add(resolved.declaration);
    try {
      collectStaticRenderedText(resolved.initializer, staticText, context, resolvingDeclarations);
    } finally {
      resolvingDeclarations.delete(resolved.declaration);
    }
    return;
  }

  const literalValue = stringLiteralValue(unwrapped);
  if (literalValue !== null) {
    const normalized = normalizeJsxText(literalValue);
    if (UNICODE_LETTER.test(normalized)) staticText.push(normalized);
    return;
  }

  if (tsCompiler.isTemplateExpression(unwrapped)) {
    const head = normalizeJsxText(unwrapped.head.text);
    if (UNICODE_LETTER.test(head)) staticText.push(head);
    for (const span of unwrapped.templateSpans) {
      collectStaticRenderedText(span.expression, staticText, context, resolvingDeclarations);
      const literal = normalizeJsxText(span.literal.text);
      if (UNICODE_LETTER.test(literal)) staticText.push(literal);
    }
    return;
  }

  if (tsCompiler.isConditionalExpression(unwrapped)) {
    collectStaticRenderedText(unwrapped.whenTrue, staticText, context, resolvingDeclarations);
    collectStaticRenderedText(unwrapped.whenFalse, staticText, context, resolvingDeclarations);
    return;
  }

  if (tsCompiler.isBinaryExpression(unwrapped)) {
    switch (unwrapped.operatorToken.kind) {
      case tsCompiler.SyntaxKind.PlusToken:
        collectStaticRenderedText(unwrapped.left, staticText, context, resolvingDeclarations);
        collectStaticRenderedText(unwrapped.right, staticText, context, resolvingDeclarations);
        return;
      case tsCompiler.SyntaxKind.AmpersandAmpersandToken:
        collectStaticRenderedText(unwrapped.right, staticText, context, resolvingDeclarations);
        return;
      case tsCompiler.SyntaxKind.BarBarToken:
      case tsCompiler.SyntaxKind.QuestionQuestionToken:
        collectStaticRenderedText(unwrapped.left, staticText, context, resolvingDeclarations);
        collectStaticRenderedText(unwrapped.right, staticText, context, resolvingDeclarations);
        return;
      default:
        return;
    }
  }

  if (tsCompiler.isArrayLiteralExpression(unwrapped)) {
    for (const element of unwrapped.elements) {
      if (tsCompiler.isOmittedExpression(element)) continue;
      collectStaticRenderedText(
        tsCompiler.isSpreadElement(element) ? element.expression : element,
        staticText,
        context,
        resolvingDeclarations,
      );
    }
  }
}

function auditableCopy(
  expression: ts.Expression | undefined,
  context: CopyAnalysisContext,
): AuditableCopy | null {
  if (!expression) return null;
  const unwrapped = unwrapExpression(expression);
  const completeValue = completeStaticString(unwrapped, context, new Set());
  if (completeValue !== null) {
    return hasAuditableText(completeValue) ? { kind: 'literal', value: completeValue } : null;
  }

  const staticText: string[] = [];
  collectStaticRenderedText(unwrapped, staticText, context, new Set());
  return staticText.length > 0 ? { kind: 'parts', staticText } : null;
}

function jsxAttributeCopy(
  initializer: ts.JsxAttributeValue | undefined,
  context: CopyAnalysisContext,
): AuditableCopy | null {
  if (!initializer) return null;
  if (tsCompiler.isStringLiteral(initializer)) return auditableCopy(initializer, context);
  return tsCompiler.isJsxExpression(initializer)
    ? auditableCopy(initializer.expression, context)
    : null;
}

function copyDetail(copy: AuditableCopy): string {
  return copy.kind === 'literal'
    ? JSON.stringify(copy.value)
    : `static=${JSON.stringify(copy.staticText)}`;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (tsCompiler.isIdentifier(name) || tsCompiler.isStringLiteral(name) || tsCompiler.isNumericLiteral(name)) {
    return name.text;
  }
  if (tsCompiler.isComputedPropertyName(name)) return stringLiteralValue(name.expression);
  return null;
}

function calledMethodName(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression);
  if (tsCompiler.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  if (tsCompiler.isElementAccessExpression(unwrapped)) {
    return stringLiteralValue(unwrapped.argumentExpression);
  }
  return null;
}

function isEmptyArrayExpression(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  return tsCompiler.isArrayLiteralExpression(unwrapped) && unwrapped.elements.length === 0;
}

function isReviewedRawIdentity(value: string): boolean {
  return RAW_IDENTITY_TEXT.has(value);
}

function hasAuditableText(value: string): boolean {
  return UNICODE_LETTER.test(value) && !isReviewedRawIdentity(value);
}

function importedLegacyLocalizationName(importClause: ts.ImportClause | undefined): boolean {
  if (!importClause) return false;
  if (importClause.name && LEGACY_LOCALIZATION_EXPORTS.has(importClause.name.text)) return true;
  const bindings = importClause.namedBindings;
  if (!bindings || !tsCompiler.isNamedImports(bindings)) return false;
  return bindings.elements.some((element) =>
    LEGACY_LOCALIZATION_EXPORTS.has((element.propertyName ?? element.name).text));
}

function importsLegacyLocalizationModule(moduleSpecifier: string): boolean {
  const moduleFileName = moduleSpecifier.slice(moduleSpecifier.lastIndexOf('/') + 1);
  const moduleName = moduleFileName.split('.')[0];
  return LEGACY_LOCALIZATION_EXPORTS.has(moduleName);
}

function createBoundAuditSource(filePath: string, sourceText: string): {
  sourceFile: ts.SourceFile;
  checker: Checker;
  project: Project;
  close: () => void;
} {
  const virtualFilePath = path.resolve('.audit', `${auditSourceId++}-${path.basename(filePath)}`);
  auditFileSystem.writeFile?.(virtualFilePath, sourceText);
  const snapshot = auditApi.updateSnapshot({ openFiles: [virtualFilePath] });
  const project = snapshot.getDefaultProjectForFile(virtualFilePath);
  const sourceFile = project?.program.getSourceFile(virtualFilePath);
  if (!project || !sourceFile) {
    snapshot.dispose();
    throw new Error(`Failed to parse audit source: ${filePath}`);
  }
  return {
    sourceFile,
    checker: project.checker,
    project,
    close: () => snapshot.dispose(),
  };
}

function addAssignmentTargetSymbols(
  expression: ts.Expression,
  checker: Checker,
  symbols: Set<Symbol>,
): void {
  const unwrapped = unwrapExpression(expression);
  if (tsCompiler.isIdentifier(unwrapped)) {
    const symbol = checker.getSymbolAtLocation(unwrapped);
    if (symbol) symbols.add(symbol);
    return;
  }

  if (tsCompiler.isArrayLiteralExpression(unwrapped)) {
    for (const element of unwrapped.elements) {
      if (tsCompiler.isOmittedExpression(element)) continue;
      addAssignmentTargetSymbols(
        tsCompiler.isSpreadElement(element) ? element.expression : element,
        checker,
        symbols,
      );
    }
    return;
  }

  if (tsCompiler.isObjectLiteralExpression(unwrapped)) {
    for (const property of unwrapped.properties) {
      if (tsCompiler.isShorthandPropertyAssignment(property)) {
        addAssignmentTargetSymbols(property.name as ts.Expression, checker, symbols);
      } else if (tsCompiler.isPropertyAssignment(property)) {
        addAssignmentTargetSymbols(property.initializer, checker, symbols);
      } else if (tsCompiler.isSpreadAssignment(property)) {
        addAssignmentTargetSymbols(property.expression, checker, symbols);
      }
    }
  }
}

function reassignedSymbols(sourceFile: ts.SourceFile, checker: Checker): Set<Symbol> {
  const symbols = new Set<Symbol>();
  const visit = (node: ts.Node) => {
    if (
      tsCompiler.isBinaryExpression(node)
      && node.operatorToken.kind >= tsCompiler.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= tsCompiler.SyntaxKind.LastAssignment
    ) {
      addAssignmentTargetSymbols(node.left, checker, symbols);
    } else if (
      (tsCompiler.isPrefixUnaryExpression(node) || tsCompiler.isPostfixUnaryExpression(node))
      && (node.operator === tsCompiler.SyntaxKind.PlusPlusToken
        || node.operator === tsCompiler.SyntaxKind.MinusMinusToken)
    ) {
      addAssignmentTargetSymbols(node.operand, checker, symbols);
    } else if (
      (tsCompiler.isForInStatement(node) || tsCompiler.isForOfStatement(node))
      && !tsCompiler.isVariableDeclarationList(node.initializer)
    ) {
      addAssignmentTargetSymbols(node.initializer as ts.Expression, checker, symbols);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return symbols;
}

function auditSource(filePath: string, sourceText: string): AuditDiagnostic[] {
  const { sourceFile, checker, project, close } = createBoundAuditSource(filePath, sourceText);
  try {
    const copyAnalysisContext: CopyAnalysisContext = {
      checker,
      project,
      reassignedSymbols: reassignedSymbols(sourceFile, checker),
    };
    const diagnostics: AuditDiagnostic[] = [];

    const report = (node: ts.Node, category: string, detail: string) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      diagnostics.push({ filePath, line: line + 1, category, detail });
    };

    const visit = (node: ts.Node) => {
      if (tsCompiler.isJsxText(node)) {
        const text = normalizeJsxText(node.text);
        if (hasAuditableText(text)) report(node, 'jsx-text', JSON.stringify(text));
      }

      if (tsCompiler.isJsxExpression(node) && !tsCompiler.isJsxAttribute(node.parent)) {
        const copy = auditableCopy(node.expression, copyAnalysisContext);
        if (copy) report(node, 'jsx-expression', copyDetail(copy));
      }

      if (tsCompiler.isJsxAttribute(node)) {
        const name = node.name.getText(sourceFile);
        if (AUDITED_ATTRIBUTE_NAMES.has(name) || name === 'alt') {
          const copy = jsxAttributeCopy(node.initializer, copyAnalysisContext);
          if (copy && AUDITED_ATTRIBUTE_NAMES.has(name)) {
            const separator = copy.kind === 'literal' ? '=' : ' ';
            report(node, 'literal-attribute', `${name}${separator}${copyDetail(copy)}`);
          } else if (copy && name === 'alt') {
            report(node, 'literal-alt', copyDetail(copy));
          }
        }
      }

      if (tsCompiler.isPropertyAssignment(node)) {
        const name = propertyNameText(node.name);
        if (name && AUDITED_OBJECT_PROPERTY_NAMES.has(name)) {
          const copy = auditableCopy(node.initializer, copyAnalysisContext);
          if (copy) {
            const separator = copy.kind === 'literal' ? '=' : ' ';
            report(node, 'literal-object-property', `${name}${separator}${copyDetail(copy)}`);
          }
        }
      }

      if (tsCompiler.isCallExpression(node)) {
        const methodName = calledMethodName(node.expression);
        if (
          methodName
          && AMBIENT_LOCALE_METHODS.has(methodName)
          && (node.arguments.length === 0 || isEmptyArrayExpression(node.arguments[0]))
        ) {
          report(node, 'ambient-locale', `${methodName} requires an explicit locale`);
        }
      }

      if (tsCompiler.isImportDeclaration(node) && tsCompiler.isStringLiteral(node.moduleSpecifier)) {
        if (
          importsLegacyLocalizationModule(node.moduleSpecifier.text)
          || importedLegacyLocalizationName(node.importClause)
        ) {
          report(node, 'legacy-localization-import', JSON.stringify(node.moduleSpecifier.text));
        }
      }

      node.forEachChild(visit);
    };

    visit(sourceFile);
    return diagnostics;
  } finally {
    close();
  }
}

function productionTsxFiles(directoryPath: string): string[] {
  return readdirSync(directoryPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) return productionTsxFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')
        ? [entryPath]
        : [];
    });
}

function formatDiagnostic(diagnostic: AuditDiagnostic): string {
  return `${diagnostic.filePath}:${diagnostic.line}: ${diagnostic.category}: ${diagnostic.detail}`;
}

function auditProductionUiCopy(): string[] {
  const repositoryRoot = process.cwd();
  return PRODUCTION_TSX_ROOTS
    .flatMap((root) => productionTsxFiles(path.join(repositoryRoot, root)))
    .flatMap((absolutePath) => {
      const filePath = path.relative(repositoryRoot, absolutePath).split(path.sep).join('/');
      return auditSource(filePath, readFileSync(absolutePath, 'utf8'));
    })
    .sort((left, right) =>
      left.filePath.localeCompare(right.filePath)
      || left.line - right.line
      || left.category.localeCompare(right.category)
      || left.detail.localeCompare(right.detail))
    .map(formatDiagnostic);
}

describe('catalog-only production UI copy audit', () => {
  test('reports nested JSX copy and literal accessibility attributes', () => {
    const diagnostics = auditSource('fixture.tsx', `
      export function Fixture() {
        return <section>
          <div>
            Fixed multiline
            interface copy
          </div>
          <button aria-label={'Open panel'} title="More details" placeholder={\`Find a team\`} />
          <img alt="Team crest" />
        </section>;
      }
    `).map(formatDiagnostic);

    expect(diagnostics).toEqual([
      'fixture.tsx:5: jsx-text: "Fixed multiline interface copy"',
      'fixture.tsx:8: literal-attribute: aria-label="Open panel"',
      'fixture.tsx:8: literal-attribute: title="More details"',
      'fixture.tsx:8: literal-attribute: placeholder="Find a team"',
      'fixture.tsx:9: literal-alt: "Team crest"',
    ]);
  });

  test('reports nested string-valued UI object properties', () => {
    const diagnostics = auditSource('fixture.tsx', `
      export const metadata = {
        title: 'Fixed title',
        nested: {
          description: \`Fixed description\`,
          label: 'Fixed label',
          text: 'Fixed text',
          heading: 'Fixed heading',
          subtitle: 'Fixed subtitle',
          emptyText: 'Fixed empty state',
        },
      };
    `).map(formatDiagnostic);

    expect(diagnostics).toEqual([
      'fixture.tsx:3: literal-object-property: title="Fixed title"',
      'fixture.tsx:5: literal-object-property: description="Fixed description"',
      'fixture.tsx:6: literal-object-property: label="Fixed label"',
      'fixture.tsx:7: literal-object-property: text="Fixed text"',
      'fixture.tsx:8: literal-object-property: heading="Fixed heading"',
      'fixture.tsx:9: literal-object-property: subtitle="Fixed subtitle"',
      'fixture.tsx:10: literal-object-property: emptyText="Fixed empty state"',
    ]);
  });

  test('reports fixed copy in JSX child expressions and interpolated attributes', () => {
    const diagnostics = auditSource('fixture.tsx', `
      export function Fixture() {
        return <section>
          <p>{'Fixed expression copy'}</p>
          <p>{\`Fixed template copy\`}</p>
          <p>{\`Open \${name}\`}</p>
          <p>{\`ScoreArc \${name}\`}</p>
          <p>{\`\${name} details \${season} 完了\`}</p>
          <button title={\`Open \${name}\`} aria-label={\`Select \${team}\`} placeholder={\`Find \${team}\`} />
          <img alt={\`Crest for \${team}\`} />
        </section>;
      }
    `).map(formatDiagnostic);

    expect(diagnostics).toEqual([
      'fixture.tsx:4: jsx-expression: "Fixed expression copy"',
      'fixture.tsx:5: jsx-expression: "Fixed template copy"',
      'fixture.tsx:6: jsx-expression: static=["Open"]',
      'fixture.tsx:7: jsx-expression: static=["ScoreArc"]',
      'fixture.tsx:8: jsx-expression: static=["details","完了"]',
      'fixture.tsx:9: literal-attribute: title static=["Open"]',
      'fixture.tsx:9: literal-attribute: aria-label static=["Select"]',
      'fixture.tsx:9: literal-attribute: placeholder static=["Find"]',
      'fixture.tsx:10: literal-alt: static=["Crest for"]',
    ]);
  });

  test('reports concatenated copy across JSX, attributes, and audited object values', () => {
    const diagnostics = auditSource('fixture.tsx', `
      export function Fixture() {
        const metadata = {
          title: 'Open ' + name,
          description: ('About ' + team) + ' details',
        };
        return <section>
          <p>{'Open ' + name}</p>
          <p>{'ScoreArc' + name}</p>
          <button title={'Open ' + name} />
          <img alt={team + ' crest'} />
        </section>;
      }
    `).map(formatDiagnostic);

    expect(diagnostics).toEqual([
      'fixture.tsx:4: literal-object-property: title static=["Open"]',
      'fixture.tsx:5: literal-object-property: description static=["About","details"]',
      'fixture.tsx:8: jsx-expression: static=["Open"]',
      'fixture.tsx:9: jsx-expression: static=["ScoreArc"]',
      'fixture.tsx:10: literal-attribute: title static=["Open"]',
      'fixture.tsx:11: literal-alt: static=["crest"]',
    ]);
  });

  test('reports fixed conditional, logical, fallback, nested, and array render branches', () => {
    const diagnostics = auditSource('fixture.tsx', `
      export const metadata = {
        title: ok ? 'Ready now' : provider.title,
        description: ok && 'Ready details',
        label: provider.label || 'Fallback label',
        text: provider.text ?? 'Unknown text',
        emptyText: [provider.emptyText, 'Nothing here', ok ? ['Nested ready', provider.subtitle] : null],
      };
      export function Fixture() {
        return <>
          <p>{ok ? 'Ready now' : provider.title}</p>
          <p>{ok && 'Ready'}</p>
          <p>{provider.title || 'Fallback'}</p>
          <p>{provider.title ?? 'Unknown team'}</p>
          <p>{[provider.title, 'Array label', ok ? ['Nested ready', provider.subtitle] : null]}</p>
          <button title={ok ? provider.title : 'Open details'} aria-label={ok && 'Ready'} placeholder={provider.title || 'Fallback'} />
        </>;
      }
    `).map(formatDiagnostic);

    expect(diagnostics).toEqual([
      'fixture.tsx:3: literal-object-property: title static=["Ready now"]',
      'fixture.tsx:4: literal-object-property: description static=["Ready details"]',
      'fixture.tsx:5: literal-object-property: label static=["Fallback label"]',
      'fixture.tsx:6: literal-object-property: text static=["Unknown text"]',
      'fixture.tsx:7: literal-object-property: emptyText static=["Nothing here","Nested ready"]',
      'fixture.tsx:11: jsx-expression: static=["Ready now"]',
      'fixture.tsx:12: jsx-expression: static=["Ready"]',
      'fixture.tsx:13: jsx-expression: static=["Fallback"]',
      'fixture.tsx:14: jsx-expression: static=["Unknown team"]',
      'fixture.tsx:15: jsx-expression: static=["Array label","Nested ready"]',
      'fixture.tsx:16: literal-attribute: title static=["Open details"]',
      'fixture.tsx:16: literal-attribute: aria-label static=["Ready"]',
      'fixture.tsx:16: literal-attribute: placeholder static=["Fallback"]',
    ]);
  });

  test('does not audit condition literals, call arguments, or provider-only render values', () => {
    const diagnostics = auditSource('fixture.tsx', `
      export const metadata = {
        title: status === 'Ready condition' ? provider.title : provider.fallbackTitle,
        description: isReady('Ready argument') ? provider.description : provider.summary,
        label: formatLabel('Fixed call argument'),
        text: provider.text,
        emptyText: [provider.emptyText, provider.description],
      };
      export function Fixture() {
        return <>
          <p>{status === 'Ready condition'}</p>
          <p>{status === 'Ready condition' ? provider.title : provider.subtitle}</p>
          <p>{isReady('Ready argument') && provider.title}</p>
          <p>{formatLabel('Fixed call argument')}</p>
          <p>{provider.title}</p>
          <p>{[provider.title, provider.description]}</p>
          <button title={formatTitle('Fixed argument')} aria-label={provider.label} />
        </>;
      }
    `);

    expect(diagnostics).toEqual([]);
  });

  test('reports computed UI property names and interpolated property values', () => {
    const diagnostics = auditSource('fixture.tsx', `
      export const metadata = {
        ['title']: 'Computed title',
        [(\`description\` as string)]: \`About \${team}\`,
        nested: { [('title')]: \`Team \${name}\`, [\`description\`]: 'Nested description' },
      };
    `).map(formatDiagnostic);

    expect(diagnostics).toEqual([
      'fixture.tsx:3: literal-object-property: title="Computed title"',
      'fixture.tsx:4: literal-object-property: description static=["About"]',
      'fixture.tsx:5: literal-object-property: title static=["Team"]',
      'fixture.tsx:5: literal-object-property: description="Nested description"',
    ]);
  });

  test('reports ambient locale calls and both legacy localization imports', () => {
    const legacyTextModule = `./${LEGACY_TEXT_COMPONENT}`;
    const diagnostics = auditSource('fixture.tsx', `
      import ${LEGACY_TEXT_COMPONENT} from '${legacyTextModule}';
      import { ${LEGACY_PROVIDER_COMPONENT} as Provider } from '@/components';
      const date = value.toLocaleDateString();
      const time = value.toLocaleTimeString(([] as string[]));
      const number = value['toLocaleString']([]);
      const explicit = value.toLocaleString('en-US');
    `).map(formatDiagnostic);

    expect(diagnostics).toEqual([
      `fixture.tsx:2: legacy-localization-import: "${legacyTextModule}"`,
      'fixture.tsx:3: legacy-localization-import: "@/components"',
      'fixture.tsx:4: ambient-locale: toLocaleDateString requires an explicit locale',
      'fixture.tsx:5: ambient-locale: toLocaleTimeString requires an explicit locale',
      'fixture.tsx:6: ambient-locale: toLocaleString requires an explicit locale',
    ]);
  });

  test('reports ambient locale calls through wrapped callees', () => {
    const diagnostics = auditSource('fixture.tsx', `
      const date = (value.toLocaleDateString)();
      const number = (value['toLocaleString'])([]);
      const time = ((value.toLocaleTimeString! as typeof value.toLocaleTimeString))(([] satisfies string[]));
      const explicit = ((value.toLocaleString satisfies typeof value.toLocaleString))('en-US');
    `).map(formatDiagnostic);

    expect(diagnostics).toEqual([
      'fixture.tsx:2: ambient-locale: toLocaleDateString requires an explicit locale',
      'fixture.tsx:3: ambient-locale: toLocaleString requires an explicit locale',
      'fixture.tsx:4: ambient-locale: toLocaleTimeString requires an explicit locale',
    ]);
  });

  test('permits reviewed identities, non-copy literals, and provider expressions', () => {
    const diagnostics = auditSource('fixture.tsx', `
      const event = 'match_popup_open';
      const fieldName = getFieldName();
      const providerCard = {
        description: article.description,
        label: article.source,
        ['title']: article.title,
        [fieldName]: 'Provider-owned fixed value',
        [\`\${fieldName}\`]: 'Provider-owned template value',
      };
      export function Fixture() {
        return <div className="score-card" data-event={event}>
          <span>ScoreArc</span><span>42 · ⚽</span>
          <img alt="FIFA" src="https://example.com/crest.png" />
          <p>{article.description}</p>
          <p>{\`\${article.description}\`}</p>
          <p>{'ScoreArc'}</p>
          <p>{\`FIFA\`}</p>
          <button title={article.title} aria-label={\`\${article.label}\`} />
        </div>;
      }
    `);

    expect(diagnostics).toEqual([]);
  });

  test('reports fixed copy flowing through local const identifiers into UI sinks', () => {
    const diagnostics = auditSource('fixture.tsx', `
      export function Fixture() {
        const jsxCopy = 'Uncatalogued visible copy';
        const titleCopy = 'Fixed title copy';
        const ariaCopy = 'Fixed aria copy';
        const placeholderCopy = 'Fixed placeholder copy';
        const altCopy = 'Fixed alt copy';
        const objectCopy = 'Fixed object copy';
        const chainStart = 'Chained visible copy';
        const chainedCopy = chainStart;
        const wrappedCopy = 'Wrapped visible copy';
        const metadata = { description: objectCopy };
        return <>
          <p>{jsxCopy}</p>
          <p>{chainedCopy}</p>
          <p>{((wrappedCopy as string)!)}</p>
          <button title={titleCopy} aria-label={ariaCopy} placeholder={placeholderCopy} />
          <img alt={altCopy} />
        </>;
      }
    `).map(formatDiagnostic);

    expect(diagnostics).toEqual([
      'fixture.tsx:12: literal-object-property: description="Fixed object copy"',
      'fixture.tsx:14: jsx-expression: "Uncatalogued visible copy"',
      'fixture.tsx:15: jsx-expression: "Chained visible copy"',
      'fixture.tsx:16: jsx-expression: "Wrapped visible copy"',
      'fixture.tsx:17: literal-attribute: title="Fixed title copy"',
      'fixture.tsx:17: literal-attribute: aria-label="Fixed aria copy"',
      'fixture.tsx:17: literal-attribute: placeholder="Fixed placeholder copy"',
      'fixture.tsx:18: literal-alt: "Fixed alt copy"',
    ]);
  });

  test('leaves non-const, ambiguous, shadowed, and dynamic identifier values unresolved', () => {
    const diagnostics = auditSource('fixture.tsx', `
      import { importedCopy } from './copy';
      const shadowedCopy = 'Outer fixed copy';
      let mutableCopy = 'Mutable fixed copy';
      const { title: destructuredCopy } = provider;
      const providerCopy = provider.title;
      const dynamicCopy = formatLabel('Fixed call argument');
      const dynamicTemplate = \`\${provider.title}\`;
      const reviewedIdentity = 'ScoreArc';
      const reviewedAltIdentity = 'FIFA';
      const cyclicCopyA = cyclicCopyB;
      const cyclicCopyB = cyclicCopyA;
      const reassignedCopy = 'Reassigned fixed copy';
      reassignedCopy = provider.title;
      const ambiguousCopy = 'First ambiguous copy';
      const ambiguousCopy = 'Second ambiguous copy';
      export function Fixture(parameterCopy: string) {
        const shadowedCopy = provider.subtitle;
        return <>
          <p>{parameterCopy}</p>
          <p>{importedCopy}</p>
          <p>{mutableCopy}</p>
          <p>{destructuredCopy}</p>
          <p>{shadowedCopy}</p>
          <p>{providerCopy}</p>
          <p>{dynamicCopy}</p>
          <p>{dynamicTemplate}</p>
          <p>{reviewedIdentity}</p>
          <p>{cyclicCopyA}</p>
          <p>{reassignedCopy}</p>
          <p>{ambiguousCopy}</p>
          <button title={providerCopy} aria-label={dynamicCopy} placeholder={shadowedCopy} />
          <button title={reviewedIdentity} aria-label={reviewedIdentity} placeholder={reviewedIdentity} />
          <img alt={reviewedAltIdentity} />
        </>;
      }
    `);

    expect(diagnostics).toEqual([]);
  });

  test('finds no uncatalogued copy in production TSX', () => {
    const diagnostics = auditProductionUiCopy();
    expect(diagnostics, diagnostics.join('\n')).toEqual([]);
  });
});
