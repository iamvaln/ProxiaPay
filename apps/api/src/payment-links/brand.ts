/** The checks a project's brand goes through before it is stored (spec: payment links, brand). Pure, so the page and the console agree. */

export const MAX_LOGO_BYTES = 200 * 1024;

/** ProxiaPay's own primary: what a project shows until its owner picks a colour. */
export const DEFAULT_PRIMARY_COLOR = '#0B0D12';

export const LOGO_MESSAGE = 'Use a PNG, JPEG or WebP image of at most 200 KB.';
export const COLOR_FORMAT_MESSAGE = 'Use a colour written like #1A56DB.';
export const COLOR_MESSAGE = 'This colour is too light for white text; pick a darker one.';

/** The type from the first bytes, never from a name: an SVG or an HTML page renamed .png is not an image. */
export function logoType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** WCAG contrast ratio of a colour against white (1 to 21). */
export function contrastWithWhite(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return 1.05 / (luminance + 0.05);
}

export const isHexColor = (hex: string): boolean => /^#[0-9a-fA-F]{6}$/.test(hex);

/** Six-digit hex, and readable under white text (WCAG AA, 4.5:1). */
export function isUsableColor(hex: string): boolean {
  return isHexColor(hex) && contrastWithWhite(hex) >= 4.5;
}
