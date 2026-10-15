import { render, screen, waitFor } from '@testing-library/react';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { QrCodeDialog, qrFileName } from './QrCode';

const URL_ = 'https://forms.example.com/f/org-1/MAINT';

describe('a QR code for a form', () => {
  it('shows the code with the address under it, and offers it as a picture and as a drawing for print', async () => {
    render(<QrCodeDialog open url={URL_} title="Maintenance complaint" note="Only people signed in can open it." onClose={() => undefined} />);
    const img = await screen.findByRole('img', { name: 'QR code that opens Maintenance complaint' });
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(screen.getByText(URL_)).toBeTruthy();
    expect(screen.getByText('Only people signed in can open it.')).toBeTruthy();
    const png = screen.getByRole('link', { name: 'Download picture (PNG)' });
    expect(png.getAttribute('download')).toBe('maintenance-complaint-qr.png');
    await waitFor(() => expect(screen.getByRole('link', { name: 'Download for print (SVG)' })).toBeTruthy());
    const svg = decodeURIComponent(screen.getByRole('link', { name: 'Download for print (SVG)' }).getAttribute('href')!.replace('data:image/svg+xml;charset=utf-8,', ''));
    expect(svg).toMatch(/^<svg/);
    // The drawing is the code of this address, at the level that survives a scratch.
    expect(svg).toBe(await QRCode.toString(URL_, { type: 'svg', margin: 2, errorCorrectionLevel: 'H' }));
  });

  it('names the files after what the code is for', () => {
    expect(qrFileName('Maintenance complaint', 'png')).toBe('maintenance-complaint-qr.png');
    expect(qrFileName('  Flat 4B / Boiler #2 ', 'svg')).toBe('flat-4b-boiler-2-qr.svg');
    expect(qrFileName('?!', 'png')).toBe('form-qr.png');
  });
});
