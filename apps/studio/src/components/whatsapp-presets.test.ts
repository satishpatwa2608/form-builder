import { describe, expect, it } from 'vitest';
import { whatsappPreset } from './whatsapp-presets';

describe('WhatsApp providers, set up from account details', () => {
  it('Meta: the Cloud API call with the approved template and the message as its parameter', () => {
    const p = whatsappPreset('META', { phoneNumberId: '1234567890', template: 'request_update', language: 'en', token: 'EAAG-token' });
    expect(p).toMatchObject({ url: 'https://graph.facebook.com/v20.0/1234567890/messages', method: 'POST', format: 'JSON', headerName: 'Authorization', headerValue: 'Bearer EAAG-token' });
    expect(JSON.parse((p as { body: string }).body)).toEqual({
      messaging_product: 'whatsapp',
      to: '{{to}}',
      type: 'template',
      template: { name: 'request_update', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: '{{message}}' }] }] },
    });
  });

  it('Twilio: a web-form call from the WhatsApp number, signed in with the account SID and token', () => {
    const p = whatsappPreset('TWILIO', { sid: 'AC123', token: 'secret', from: '+1 415 523 8886' });
    expect(p).toEqual({
      url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json',
      method: 'POST',
      format: 'FORM',
      body: 'From=whatsapp%3A%2B14155238886&To=whatsapp%3A{{to}}&Body={{message}}',
      headerName: 'Authorization',
      headerValue: `Basic ${btoa('AC123:secret')}`,
    });
  });

  it('says which detail is still missing', () => {
    expect(whatsappPreset('META', { phoneNumberId: '1', template: 'x', language: '' , token: 't' })).toEqual({ missing: 'Template language code' });
    expect(whatsappPreset('TWILIO', {})).toEqual({ missing: 'Account SID' });
  });
});
