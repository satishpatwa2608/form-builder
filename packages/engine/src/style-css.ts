import type { FontFamily, FormStyle, FormTheme, StyleProps } from './types';

/**
 * Style master entries and form themes -> CSS, scoped to one form.
 *
 * Only whitelisted properties with validated values ever reach the output:
 * colours must be hex, numbers are clamped, enums are checked. Nothing a
 * designer types is copied into CSS verbatim, so a style can't escape its
 * form, load URLs, or position content over the page.
 */

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

const clamp = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;

const SHADOWS: Record<string, string> = {
  none: 'none',
  sm: '0 1px 2px rgba(0,0,0,0.06)',
  md: '0 4px 12px rgba(0,0,0,0.08)',
  lg: '0 10px 30px rgba(0,0,0,0.12)',
};

export const FONT_STACKS: Record<FontFamily, string | undefined> = {
  default: undefined,
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"Nunito", "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

/** Fixed choices, never a number someone typed: a theme cannot produce a size the layout was not made for. */
const CORNERS: Record<string, string> = { square: '2px', rounded: '10px', pill: '22px' };
const SPACING: Record<string, { wide: string; phone: string }> = {
  compact: { wide: '12px 12px', phone: '10px 10px' },
  comfortable: { wide: '22px 16px', phone: '18px 12px' },
  roomy: { wide: '34px 22px', phone: '18px 12px' },
};

/** Style ids become class names - keep them to a safe charset. */
export const styleClass = (id: string) => `fps-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;

type Decls = Array<[string, string | number | undefined]>;

const block = (selector: string, decls: Decls) => {
  const body = decls
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}:${typeof v === 'number' ? `${v}px` : v}`)
    .join(';');
  return body ? `${selector}{${body}}` : '';
};

/** CSS for one style under `scope` (the form's root selector). */
export function styleToCss(scope: string, style: FormStyle): string {
  return propsToCss(`${scope} .${styleClass(style.id)}`, style.props ?? {});
}

/** Whitelisted style properties -> CSS for the element matching `sel` (and its labels/inputs). */
function propsToCss(sel: string, p: StyleProps): string {
  const color = (v: unknown) => (isHexColor(v) ? v : undefined);
  const borderWidth = clamp(p.borderWidth, 0, 8);
  const weight = [400, 500, 600, 700].includes(p.fontWeight as number) ? String(p.fontWeight) : undefined;
  const align = p.textAlign && ['left', 'center', 'right'].includes(p.textAlign) ? p.textAlign : undefined;

  return [
    block(sel, [
      ['color', color(p.textColor)],
      ['background-color', color(p.backgroundColor)],
      ['border-style', borderWidth ? 'solid' : undefined],
      ['border-width', borderWidth],
      ['border-color', color(p.borderColor)],
      ['border-radius', clamp(p.borderRadius, 0, 32)],
      ['padding', clamp(p.padding, 0, 48)],
      ['font-size', clamp(p.fontSize, 10, 36)],
      ['font-weight', weight],
      ['text-align', align],
      ['box-shadow', p.shadow ? SHADOWS[p.shadow] : undefined],
    ]),
    block(`${sel}:hover`, [['background-color', color(p.hoverBackgroundColor)]]),
    block(`${sel} [data-slot="form-label"],${sel} label`, [['color', color(p.labelColor)]]),
    block(`${sel} input,${sel} textarea,${sel} [data-slot="select-trigger"]`, [
      ['background-color', color(p.inputBackground)],
      ['border-color', color(p.inputBorderColor)],
    ]),
  ].join('');
}

/** Everything a form needs: theme variables on the root plus each style it uses. */
export function buildFormCss(scope: string, theme: FormTheme | undefined, styles: FormStyle[]): string {
  const primary = isHexColor(theme?.primaryColor) ? theme!.primaryColor : undefined;
  const background = isHexColor(theme?.backgroundColor) ? theme!.backgroundColor : undefined;
  const font = theme?.fontFamily ? FONT_STACKS[theme.fontFamily] : undefined;
  const formStyle = theme?.styleId ? styles.find((s) => s.id === theme.styleId) : undefined;
  const mistake = isHexColor(theme?.errorColor) ? theme!.errorColor : undefined;
  const corners = theme?.corners ? CORNERS[theme.corners] : undefined;
  const gap = theme?.spacing ? SPACING[theme.spacing] : undefined;
  return [
    block(scope, [
      // Buttons, focus rings and checked states read these design-system variables.
      ['--primary', primary],
      ['--ring', primary],
      // The message under a question and the edge of a box with a mistake in it read this one.
      ['--destructive', mistake],
      // The sizes worked out from it are fixed where they are declared (the page root), so each is set here too.
      ['--radius', corners],
      ['--radius-sm', corners],
      ['--radius-md', corners],
      ['--radius-lg', corners],
      ['font-family', font],
      ['background-color', background],
      ['padding', background ? 20 : undefined],
      ['border-radius', background ? 12 : undefined],
    ]),
    // Room between questions; on a phone "roomy" is no roomier than "comfortable", since the screen has none to spare.
    gap ? block(`${scope} .fp-grid`, [['gap', gap.wide]]) : '',
    gap ? `@media (max-width:640px){${block(`${scope} .fp-grid`, [['gap', gap.phone]])}}` : '',
    ...styles.map((s) => styleToCss(scope, s)),
    // A form-level master style applies to the form root itself.
    formStyle ? propsToCss(scope, formStyle.props ?? {}) : '',
  ].join('');
}

/** Style ids a definition refers to (fields, containers, form theme). */
export function usedStyleIds(def: { fields: { styleId?: string }[]; theme?: FormTheme }): string[] {
  return [...new Set([def.theme?.styleId, ...def.fields.map((f) => f.styleId)].filter((x): x is string => !!x))];
}

/** A logo URL is only used when it's https or site-relative. */
export const safeImageUrl = (url: unknown): string | undefined =>
  typeof url === 'string' && (/^https:\/\//i.test(url) || /^\/(?!\/)/.test(url)) ? url : undefined;
