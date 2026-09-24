import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';

/**
 * Editor chrome and syntax colours. The chrome reads the console's design tokens (`--bg-*`,
 * `--text-*`, `--accent`, `--border`), so it follows the app theme on its own; the syntax palettes
 * (Xcode-like, to sit with the console's Apple styling) are swapped by the editor when the theme
 * changes.
 */

interface Palette {
  keyword: string;
  control: string;
  type: string;
  typeDef: string;
  namespace: string;
  builtinFn: string;
  builtinVar: string;
  constant: string;
  fnDef: string;
  fnCall: string;
  property: string;
  variable: string;
  string: string;
  number: string;
  color: string;
  literal: string;
  comment: string;
  annotation: string;
  region: string;
  operator: string;
  punctuation: string;
}

const LIGHT: Palette = {
  keyword: '#AD3DA4',
  control: '#AD3DA4',
  type: '#0B4F79',
  typeDef: '#0B4F79',
  namespace: '#3E8087',
  builtinFn: '#804FB8',
  builtinVar: '#3E8087',
  constant: '#78492A',
  fnDef: '#0F68A0',
  fnCall: '#326D74',
  property: '#326D74',
  variable: '#1D1D1F',
  string: '#C41A16',
  number: '#1C00CF',
  color: '#1C00CF',
  literal: '#AD3DA4',
  comment: '#707F8C',
  annotation: '#643820',
  region: '#5D6C79',
  operator: '#1D1D1F',
  punctuation: '#6E6E73',
};

const DARK: Palette = {
  keyword: '#FF7AB2',
  control: '#FF7AB2',
  type: '#5DD8FF',
  typeDef: '#5DD8FF',
  namespace: '#67B7A4',
  builtinFn: '#B281EB',
  builtinVar: '#67B7A4',
  constant: '#FFA14F',
  fnDef: '#41A1C0',
  fnCall: '#67B7A4',
  property: '#67B7A4',
  variable: '#F5F5F7',
  string: '#FF8170',
  number: '#D9C97C',
  color: '#D9C97C',
  literal: '#FF7AB2',
  comment: '#7F8C98',
  annotation: '#FD8F3F',
  region: '#92A1B1',
  operator: '#F5F5F7',
  punctuation: '#A1A1A6',
};

function highlightStyle(p: Palette, dark: boolean): HighlightStyle {
  return HighlightStyle.define(
    [
      { tag: [t.keyword, t.definitionKeyword, t.operatorKeyword], color: p.keyword, fontWeight: '600' },
      { tag: t.controlKeyword, color: p.control, fontWeight: '600' },
      { tag: t.modifier, color: p.keyword, fontStyle: 'italic' },
      { tag: t.typeName, color: p.type },
      { tag: t.definition(t.typeName), color: p.typeDef, fontWeight: '600' },
      { tag: t.namespace, color: p.namespace },
      { tag: t.function(t.standard(t.variableName)), color: p.builtinFn },
      { tag: t.standard(t.variableName), color: p.builtinVar },
      { tag: t.constant(t.standard(t.variableName)), color: p.constant },
      { tag: t.function(t.definition(t.variableName)), color: p.fnDef, fontWeight: '600' },
      { tag: t.function(t.variableName), color: p.fnCall },
      { tag: t.function(t.propertyName), color: p.fnCall },
      { tag: t.propertyName, color: p.property },
      { tag: t.variableName, color: p.variable },
      { tag: t.string, color: p.string },
      { tag: t.number, color: p.number },
      { tag: t.color, color: p.color },
      { tag: [t.bool, t.null], color: p.literal, fontWeight: '600' },
      { tag: t.lineComment, color: p.comment, fontStyle: 'italic' },
      { tag: t.docComment, color: p.comment },
      { tag: t.annotation, color: p.annotation, fontWeight: '600' },
      { tag: t.special(t.lineComment), color: p.region, fontWeight: '700' },
      { tag: [t.operator, t.definitionOperator], color: p.operator },
      { tag: [t.punctuation, t.separator, t.paren, t.squareBracket], color: p.punctuation },
    ],
    { themeType: dark ? 'dark' : 'light' },
  );
}

const lightHighlight = highlightStyle(LIGHT, false);
const darkHighlight = highlightStyle(DARK, true);

const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace";

function chrome(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': {
        color: 'var(--text-primary)',
        backgroundColor: 'var(--bg-primary)',
        fontSize: '13px',
        height: '100%',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: MONO, lineHeight: '1.6' },
      '.cm-content': { caretColor: 'var(--accent)', padding: '6px 0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: dark ? 'rgba(10, 132, 255, 0.35)' : 'rgba(0, 113, 227, 0.18)' },
      '.cm-activeLine': {
        backgroundColor: dark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.035)',
      },
      '.cm-selectionMatch': {
        backgroundColor: dark ? 'rgba(255, 214, 10, 0.18)' : 'rgba(255, 204, 0, 0.28)',
      },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: dark ? 'rgba(52, 199, 89, 0.28)' : 'rgba(52, 199, 89, 0.22)',
        outline: '1px solid rgba(52, 199, 89, 0.55)',
      },
      '.cm-nonmatchingBracket': { backgroundColor: 'rgba(255, 59, 48, 0.25)' },
      '.cm-gutters': {
        backgroundColor: 'var(--bg-secondary)',
        color: 'var(--text-tertiary)',
        borderRight: '1px solid var(--border)',
      },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-primary)' },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '32px' },
      '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', color: 'var(--text-tertiary)' },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--bg-tertiary)',
        border: '1px solid var(--border)',
        color: 'var(--text-secondary)',
        borderRadius: '4px',
        padding: '0 6px',
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        boxShadow: 'var(--shadow-md)',
        overflow: 'hidden',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: MONO, fontSize: '12.5px', maxHeight: '18em' },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'var(--accent)',
        color: '#fff',
      },
      '.cm-completionDetail': { color: 'var(--text-tertiary)', fontStyle: 'normal', marginLeft: '8px' },
      '.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail': { color: 'rgba(255,255,255,0.8)' },
      '.cm-completionInfo': {
        padding: '8px 10px',
        maxWidth: '420px',
        fontSize: '12.5px',
        lineHeight: '1.5',
      },
      '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
      '.cm-panels': {
        backgroundColor: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
      },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
      '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
      '.cm-search': { fontSize: '12px', padding: '6px 8px' },
      '.cm-textfield': {
        backgroundColor: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        padding: '2px 6px',
      },
      '.cm-button': {
        backgroundImage: 'none',
        backgroundColor: 'var(--bg-tertiary)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border)',
        borderRadius: '6px',
      },
      '.cm-diagnostic': { fontFamily: MONO, fontSize: '12px', padding: '4px 8px' },
      '.cm-diagnosticSource': { opacity: '0.7' },
      '.cm-lint-marker': { width: '0.9em', height: '0.9em' },
      // Pine extras: signature help, hover docs, color swatches.
      '.cm-pine-sig, .cm-pine-hover': {
        padding: '8px 10px',
        maxWidth: '520px',
        fontSize: '12.5px',
        lineHeight: '1.5',
      },
      '.cm-pine-sig-overload': { fontFamily: MONO, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' },
      '.cm-pine-sig-overload.is-active': { color: 'var(--text-primary)' },
      '.cm-pine-sig-overload + .cm-pine-sig-overload': { marginTop: '2px' },
      '.cm-pine-sig-param': { color: 'var(--accent)', fontWeight: '700', textDecoration: 'underline' },
      '.cm-pine-sig-count': { color: 'var(--text-tertiary)', fontSize: '11px', marginBottom: '4px' },
      '.cm-pine-doc': { marginTop: '6px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' },
      '.cm-pine-doc code': { fontFamily: MONO, fontSize: '12px' },
      '.cm-pine-code': { fontFamily: MONO, whiteSpace: 'pre-wrap' },
      '.cm-pine-kind': {
        display: 'inline-block',
        fontSize: '10px',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--text-tertiary)',
        marginBottom: '4px',
      },
      '.cm-pine-swatch': {
        display: 'inline-block',
        width: '11px',
        height: '11px',
        margin: '0 3px 0 1px',
        verticalAlign: '-1px',
        borderRadius: '3px',
        border: '1px solid rgba(128, 128, 128, 0.55)',
        cursor: 'pointer',
        backgroundImage:
          'linear-gradient(45deg, #bbb 25%, transparent 25%), linear-gradient(-45deg, #bbb 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #bbb 75%), linear-gradient(-45deg, transparent 75%, #bbb 75%)',
        backgroundSize: '6px 6px',
        backgroundPosition: '0 0, 0 3px, 3px -3px, -3px 0',
        backgroundColor: '#fff',
        position: 'relative',
        overflow: 'hidden',
      },
      '.cm-pine-swatch > span': { position: 'absolute', inset: '0' },
    },
    { dark },
  );
}

/** Chrome + syntax colours for the given theme. */
export function pineTheme(dark: boolean): Extension {
  return [chrome(dark), syntaxHighlighting(dark ? darkHighlight : lightHighlight)];
}
