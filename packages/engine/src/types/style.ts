/**
 * Look and feel. Styles are *controlled properties*, never raw CSS: the
 * runtime turns them into CSS scoped to one form, so a form can't restyle
 * the rest of Prism or overlay the page (these forms are public).
 */

export type FontWeight = 400 | 500 | 600 | 700;
export type Shadow = 'none' | 'sm' | 'md' | 'lg';

export interface StyleProps {
  textColor?: string;
  labelColor?: string;
  backgroundColor?: string;
  /** Its background while the mouse is over it. */
  hoverBackgroundColor?: string;
  borderColor?: string;
  /** px, 0-8 */
  borderWidth?: number;
  /** px, 0-32 */
  borderRadius?: number;
  /** px, 0-48 */
  padding?: number;
  /** px, 10-36 */
  fontSize?: number;
  fontWeight?: FontWeight;
  textAlign?: 'left' | 'center' | 'right';
  shadow?: Shadow;
  /** Background of inputs inside the styled element. */
  inputBackground?: string;
  inputBorderColor?: string;
}

/** A named, reusable entry in the style master. */
export interface FormStyle {
  id: string;
  name: string;
  description?: string;
  props: StyleProps;
}

export type Corners = 'square' | 'rounded' | 'pill';
export type Spacing = 'compact' | 'comfortable' | 'roomy';
export type FontFamily = 'default' | 'serif' | 'rounded' | 'mono';

/** Whole-form look: brand colour, font, logo, and an optional master style for the form body. */
export interface FormTheme {
  /** Buttons, focus rings, active states. */
  primaryColor?: string;
  backgroundColor?: string;
  fontFamily?: FontFamily;
  /** The colour of a mistake: the message under a question, and the edge of its box. */
  errorColor?: string;
  /** How round boxes and buttons are. Left out: the product's own. */
  corners?: Corners;
  /** How much room there is between questions. Left out: the product's own. */
  spacing?: Spacing;
  /** https:// or site-relative image URL shown above the title. */
  logoUrl?: string;
  styleId?: string;
}

/**
 * single - every field on one page
 * steps  - each top-level SECTION is a step with Next / Back
 */
export interface FormLayout {
  mode: 'single' | 'steps';
  /** Show every answer for a last look, with a way back to change each one, before the form is sent. */
  review?: boolean;
}

/** Width of a field inside the 6-track grid every field list uses. */
export type FieldWidth = 'full' | 'half' | 'third' | 'two-thirds';
