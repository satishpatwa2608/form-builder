export interface SubmissionSuccessConfig {
  type: 'MESSAGE' | 'REDIRECT';
  message?: string;
  redirectUrl?: string;
}

export interface SubmissionConfig {
  method: 'POST' | 'PUT';
  /** Logical id resolved by the backend's endpoint registry - never a raw URL. */
  endpointId: string;
  /** Rename payload keys: `{ fieldName: payloadKey }`. */
  mapping?: Record<string, string>;
  success?: SubmissionSuccessConfig;
}

export interface FormActionConfig {
  submit?: {
    enabled: boolean;
    label: string;
  };
  cancel?: {
    enabled: boolean;
    label: string;
    behavior: 'RESET' | 'REDIRECT';
    redirectUrl?: string;
  };
}
