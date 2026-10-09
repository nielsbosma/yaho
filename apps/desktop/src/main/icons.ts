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

export function overlayBadge(): NativeImage {
  return draw(16, (x, y) => {
    const d = Math.hypot(x - 8, y - 8);
    return d <= 7.5 ? [RED, cover(d, 7)] : null;
  });
}
