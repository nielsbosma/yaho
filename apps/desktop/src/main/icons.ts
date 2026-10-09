import { nativeImage, type NativeImage } from 'electron';

/**
 * Icons drawn in code, so the app needs no image files: the Yaho mark for the tray and window, plus the small red
 * overlay Windows shows on the taskbar button.
 */
const ACCENT = [0x8f, 0xbf, 0x5f]; // BGR of #5fbf8f, the loop
const DOT = [0xc3, 0xe0, 0xa8]; // BGR of #a8e0c3
const BG = [0x1e, 0x21, 0x1c]; // BGR of #1c211e
const RED = [0x3a, 0x45, 0xd9];

function draw(size: number, paint: (x: number, y: number) => [number[], number] | null): NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = paint(x + 0.5, y + 0.5);
      if (!px) continue;
      const [[b, g, r], a] = px as [[number, number, number], number];
      const i = (y * size + x) * 4;
      buf[i] = Math.round(b * a);
      buf[i + 1] = Math.round(g * a);
      buf[i + 2] = Math.round(r * a);
      buf[i + 3] = Math.round(255 * a);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

/** Soft edge: 1 inside, 0 outside, a pixel of anti-aliasing between. */
const cover = (d: number, r: number) => Math.max(0, Math.min(1, r - d + 0.5));

/** Rounded square: true inside, with a soft edge. */
function roundRect(x: number, y: number, size: number, r: number): number {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return cover(Math.hypot(x - cx, y - cy), r);
}

/**
 * The mark from assets/logo/mark.svg: a dark rounded square, the wordmark's green loop, and the dot riding it.
 * With unread messages the dot turns red, which doubles as the tray's badge.
 */
export function appIcon(size = 32, unread = false): NativeImage {
  const k = size / 64;
  return draw(size, (x, y) => {
    const bg = roundRect(x, y, size, 14 * k);
    if (bg <= 0) return null;
    const dot = Math.hypot(x - 44 * k, y - 20 * k);
    const dotR = (unread ? 8 : 6) * k;
    if (dot <= dotR + 0.5) return [unread ? RED : DOT, Math.min(bg, cover(dot, dotR))];
    const ring = Math.abs(Math.hypot(x - 30 * k, y - 35 * k) - 14 * k);
    if (ring <= 4 * k + 0.5) return [ACCENT, Math.min(bg, cover(ring, 4 * k))];
    return [BG, bg];
  });
}

/** 3x5 pixel digits (and a plus) for the badge count; each row is 3 bits, left to right. */
const GLYPHS: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 1, 1, 1],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7],
  '+': [0, 2, 7, 2, 0],
};
const WHITE = [0xff, 0xff, 0xff];

/**
 * The taskbar overlay: a red disc with the unread count in white (9+ above nine). Drawn at 32 px for a 2x
 * scale factor, so it stays sharp on high-DPI screens; Windows shows it at 16 px.
 */
export function overlayBadge(count = 0): NativeImage {
  const size = 32;
  const text = count > 9 ? '9+' : count > 0 ? String(count) : '';
  const px = text.length > 1 ? 3 : 4; // one font pixel, in image pixels
  const width = text.length * 3 * px + (text.length - 1) * px;
  const left = Math.round((size - width) / 2);
  const top = Math.round((size - 5 * px) / 2);
  const ink = (x: number, y: number) => {
    const col = Math.floor((x - left) / px);
    const row = Math.floor((y - top) / px);
    if (row < 0 || row > 4 || col < 0) return false;
    const ch = text[Math.floor(col / 4)];
    const bit = col % 4;
    return !!ch && bit < 3 && ((GLYPHS[ch]![row]! >> (2 - bit)) & 1) === 1;
  };
  const img = draw(size, (x, y) => {
    const d = Math.hypot(x - 16, y - 16);
    if (d > 16) return null;
    return [ink(x, y) ? WHITE : RED, cover(d, 15.5)];
  });
  return nativeImage.createFromBuffer(img.toPNG(), { scaleFactor: 2 });
}
