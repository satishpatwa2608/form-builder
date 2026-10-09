import { useUi } from '../FormRuntimeContext';
import { useEffect, useRef, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@ui/form';
import { Checkbox } from '@ui/checkbox';
import { captchaProviders, MOCK_CAPTCHA_TOKEN_PREFIX, type CaptchaWidget } from '../../adapters/captcha/captcha-provider';
import { useFormRuntime } from '../FormRuntimeContext';
import { VISIBLE_BORDER, errorText } from '../styles';
import type { FieldComponentProps } from './types';

const mockToken = () => `${MOCK_CAPTCHA_TOKEN_PREFIX}${Date.now()}`;

/**
 * Holds the provider token as a string. Live mode renders the configured
 * provider's widget; mock mode renders a local checkbox (checkbox mode) or
 * nothing (invisible / v3) and hands the container a widget that issues mock
 * tokens, so submit flows behave the same either way.
 */
export function CaptchaField({ field }: FieldComponentProps) {
  const ui = useUi();
  const { setValue, control } = useFormContext();
  const { definition, captchaMode, registerCaptcha } = useFormRuntime();
  const config = definition.captcha;
  const mode = config?.mode ?? 'CHECKBOX';
  const container = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const setToken = (token: string) => setValue(field.name, token, { shouldValidate: !!token, shouldDirty: true });

  useEffect(() => {
    if (captchaMode === 'mock') {
      const widget: CaptchaWidget = {
        execute: async () => {
          const token = mockToken();
          setToken(token);
          return token;
        },
        reset: () => setToken(''),
      };
      registerCaptcha(widget);
      return () => registerCaptcha(null);
    }

    if (!config?.siteKey || !container.current) return;
    let cancelled = false;
    captchaProviders[config.provider]
      .render(container.current, { siteKey: config.siteKey, mode, onToken: setToken, onExpire: () => setToken('') })
      .then((widget) => !cancelled && registerCaptcha(widget))
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
      registerCaptcha(null);
    };
    // Re-render the widget only when the provider setup changes; tokens flow through setValue.
  }, [captchaMode, config?.provider, config?.siteKey, mode, field.name]);

  const showMockCheckbox = captchaMode === 'mock' && mode === 'CHECKBOX';

  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => (
        <FormItem>
          {showMockCheckbox ? (
            <div className="flex items-center gap-2 rounded-md border border-gray-300 p-3" style={{ maxWidth: 320 }}>
              <FormControl>
                <Checkbox
                  className={VISIBLE_BORDER}
                  checked={!!rhf.value}
                  onCheckedChange={(checked) => setToken(checked ? mockToken() : '')}
                />
              </FormControl>
              <FormLabel className="font-medium">{ui('notRobot')}</FormLabel>
              <span className="text-xs text-muted-foreground" style={{ marginLeft: 'auto' }}>
                test mode
              </span>
            </div>
          ) : (
            <div ref={container} />
          )}
          {captchaMode === 'mock' && mode !== 'CHECKBOX' && (
            <p className="text-xs text-muted-foreground">{ui('invisibleCheck')}</p>
          )}
          {loadError && (
            <p className="text-xs" style={errorText}>
              Verification could not load ({loadError}). Check your connection and reload.
            </p>
          )}
          <FormMessage style={errorText} />
        </FormItem>
      )}
    />
  );
}
