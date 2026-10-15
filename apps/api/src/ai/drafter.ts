import { DRAFT_INSTRUCTIONS } from './form-draft';
import type { AppConfig } from '../config';

/** Asks an AI service to draft a form. Only the description is sent; what comes back is plain text. */
export interface FormDrafter {
  draft(description: string, signal: AbortSignal): Promise<string>;
}

export const FORM_DRAFTER = Symbol('FORM_DRAFTER');

/** Claude, through Anthropic's Messages API, with the installation's own key. */
export class AnthropicDrafter implements FormDrafter {
  constructor(
    private readonly key: string,
    private readonly model: string,
  ) {}

  async draft(description: string, signal: AbortSignal): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.model, max_tokens: 8000, system: DRAFT_INSTRUCTIONS, messages: [{ role: 'user', content: `The form is for: ${description}` }] }),
      redirect: 'error',
      signal,
    });
    // The service's own words can carry details of the account: only the status is passed on.
    if (!res.ok) throw new Error(`the AI service answered ${res.status}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
  }
}

/** The drafter this installation has, or null when it has none (the box is then not shown). */
export function drafterFor(config: Pick<AppConfig, 'AI_DRAFT_PROVIDER' | 'ANTHROPIC_API_KEY' | 'AI_DRAFT_MODEL'>): FormDrafter | null {
  if (config.AI_DRAFT_PROVIDER === 'anthropic' && config.ANTHROPIC_API_KEY) return new AnthropicDrafter(config.ANTHROPIC_API_KEY, config.AI_DRAFT_MODEL);
  return null;
}
