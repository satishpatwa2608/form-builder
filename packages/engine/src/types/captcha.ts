/** Only the public site key ever belongs here - secret keys stay server-side. */
export interface CaptchaConfig {
  enabled: boolean;
  provider: 'RECAPTCHA' | 'TURNSTILE' | 'HCAPTCHA';
  siteKey: string;
  mode: 'CHECKBOX' | 'INVISIBLE' | 'V3';
}
