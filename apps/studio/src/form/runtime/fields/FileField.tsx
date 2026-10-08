import { useFormContext } from 'react-hook-form';
import { FormControl, FormField } from '@ui/form';
import { FileUploader } from '@ui/file-uploader';
import { useFormRuntime } from '../FormRuntimeContext';
import { FieldShell } from './FieldShell';
import type { FieldComponentProps } from './types';

/** Types accepted when a FILE field doesn't set `props.accept`. */
export const DEFAULT_ACCEPT = ['image/*', 'application/pdf'];
export const DEFAULT_MAX_SIZE_MB = 5;

/**
 * Holds File[]. The uploader is uncontrolled, so it remounts on form reset
 * (resetKey). Upload happens at submit time in Phase 4 (pre-signed S3); the
 * mock adapter just echoes file metadata.
 */
export function FileField({ field, required }: FieldComponentProps) {
  const { control } = useFormContext();
  const { resetKey } = useFormRuntime();
  const accept = Array.isArray(field.props?.accept) ? (field.props.accept as string[]) : DEFAULT_ACCEPT;
  const maxSizeMB = typeof field.props?.maxSizeMB === 'number' ? field.props.maxSizeMB : DEFAULT_MAX_SIZE_MB;
  const maxCount = field.validation?.max ?? 1;

  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => (
        <FieldShell field={field} required={required}>
          <FormControl>
            <div aria-required={required}>
              <FileUploader
                key={resetKey}
                allowedFileTypes={accept}
                maxSizeMB={maxSizeMB}
                multiple={maxCount > 1}
                maxCount={maxCount}
                isDragger
                compact
                buttonText={field.placeholder ?? (maxCount > 1 ? 'Upload files' : 'Upload a file')}
                onFileUpload={(files) => {
                  rhf.onChange(files ? (Array.isArray(files) ? files : [files]) : []);
                  rhf.onBlur();
                }}
              />
            </div>
          </FormControl>
        </FieldShell>
      )}
    />
  );
}
