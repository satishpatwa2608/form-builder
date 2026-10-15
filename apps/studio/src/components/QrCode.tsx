import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@ui/dialog';

/** A file name from what the code is for: "Maintenance complaint" -> "maintenance-complaint-qr.png". */
export const qrFileName = (title: string, ext: 'png' | 'svg') =>
  `${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'form'
  }-qr.${ext}`;

/**
 * The QR code of an address, to print on a poster, a door or a machine: shown large, with the address under it
 * so it can be checked, and saved as a picture (PNG) or as a drawing that prints sharp at any size (SVG). Made
 * here in the browser; nothing goes to the server.
 */
export function QrCodeDialog({ url, title, note, open, onClose }: { url: string; title: string; note?: string; open: boolean; onClose: () => void }) {
  const [png, setPng] = useState<string>();
  const [svg, setSvg] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let live = true;
    // High error correction: a code on a wall still reads with a scratch or a sticker on it.
    void QRCode.toDataURL(url, { margin: 2, width: 640, errorCorrectionLevel: 'H' }).then((d) => live && setPng(d));
    void QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'H' }).then((s) => live && setSvg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`));
    return () => {
      live = false;
    };
  }, [url, open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent style={{ maxWidth: 420 }}>
        <DialogTitle>QR code: {title}</DialogTitle>
        <DialogDescription>Point a phone's camera at it to open the form. Print it, or put it on a poster or a door.</DialogDescription>
        <div style={{ display: 'grid', justifyItems: 'center', gap: 10 }}>
          {png ? <img src={png} alt={`QR code that opens ${title}`} style={{ width: 280, height: 280, maxWidth: '100%', imageRendering: 'pixelated' }} /> : <div style={{ width: 280, height: 280 }} aria-busy="true" />}
          <code style={{ fontSize: 12, overflowWrap: 'anywhere', textAlign: 'center' }}>{url}</code>
          {note && (
            <p className="text-sm" style={{ margin: 0, textAlign: 'center' }}>
              {note}
            </p>
          )}
          <div className="flex items-center gap-2">
            {png && (
              <a className="st-btn st-btn--secondary st-btn--sm" href={png} download={qrFileName(title, 'png')}>
                Download picture (PNG)
              </a>
            )}
            {svg && (
              <a className="st-btn st-btn--ghost st-btn--sm" href={svg} download={qrFileName(title, 'svg')} title="Prints sharp at any size">
                Download for print (SVG)
              </a>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
