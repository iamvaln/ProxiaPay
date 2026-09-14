import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * A QR code rendered entirely in the browser. The value never leaves the page: it is encoded
 * locally into a PNG data URL, which matters because the one thing this is used for is an
 * authenticator secret.
 */
export function QrCode({ value, alt, size = 192 }: { value: string; alt: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 2, width: size })
      .then((url) => { if (!cancelled) setSrc(url); })
      .catch(() => { if (!cancelled) setSrc(null); });
    return () => { cancelled = true; };
  }, [value, size]);
  if (!src) return null;
  return <img src={src} alt={alt} width={size} height={size} style={{ display: 'block', margin: '0 auto', imageRendering: 'pixelated' }} />;
}
