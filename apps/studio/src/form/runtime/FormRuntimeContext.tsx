import { createContext, useContext } from 'react';
import type { FormDefinition, FormValues, SystemContext } from '../types';
import type { FieldStates, LayoutIndex } from '../engine';
import type { DataSourceAdapter } from '../adapters/data-source/data-source-adapter';
import type { CaptchaWidget } from '../adapters/captcha/captcha-provider';

/** 'live' uses the configured provider; 'mock' a local stand-in (preview, playground, tests, no site key). */
export type CaptchaMode = 'live' | 'mock';

export interface FormRuntimeValue {
  definition: FormDefinition;
  /** Current form values - what rules and data-source params read. */
  values: FormValues;
  /** Visible/required state of every field for the current values. */
  states: FieldStates;
  /** Names a rule has switched off or is calculating: shown, not editable. */
  readOnly: ReadonlySet<string>;
  /** Option values a rule currently allows, for the lists a rule narrows. */
  allowedOptions: ReadonlyMap<string, ReadonlySet<string>>;
  systemContext: SystemContext;
  navigate: (url: string) => void;
  dataSourceAdapter: DataSourceAdapter;
  captchaMode: CaptchaMode;
  /** CaptchaField hands its widget up so the container can execute/reset it around submits. */
  registerCaptcha: (widget: CaptchaWidget | null) => void;
  /** Changes on every reset - lets uncontrolled widgets (file uploader) remount clean. */
  resetKey: number;
  /** Where each field sits (containers / columns). */
  layout: LayoutIndex;
  /** In steps mode, the SECTION shown as the current step (renders without its own frame). */
  stepSectionId?: string;
}

const FormRuntimeContext = createContext<FormRuntimeValue | null>(null);

export const FormRuntimeProvider = FormRuntimeContext.Provider;

export function useFormRuntime(): FormRuntimeValue {
  const value = useContext(FormRuntimeContext);
  if (!value) throw new Error('useFormRuntime must be used inside <FormContainer>');
  return value;
}
