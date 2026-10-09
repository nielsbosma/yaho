import { nativeImage, type NativeImage } from 'electron';

/**
 * Icons drawn in code, so the app needs no image assets: a clay disc for the tray and window, with a red dot when
 * the human has unread messages, plus the small red overlay Windows shows on the taskbar button.
 */
const CLAY = [0x42, 0x64, 0xc9]; // BGR of #c96442
const RED = [0x3a, 0x45, 0xd9];
const WHITE = [0xff, 0xff, 0xff];

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

/** Distance from a point to a line segment. */
function segDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const k = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + k * dx), py - (y1 + k * dy));
}

/** Soft edge: 1 inside, 0 outside, a pixel of anti-aliasing between. */
const cover = (d: number, r: number) => Math.max(0, Math.min(1, r - d + 0.5));

export function appIcon(size = 32, unread = false): NativeImage {
  const c = size / 2;
  const R = size * 0.46;
  const bR = size * 0.2;
  const bx = size - bR - 0.5;
  const by = bR + 0.5;
  return draw(size, (x, y) => {
    if (unread) {
      const db = Math.hypot(x - bx, y - by);
      if (db <= bR + 1.5) {
        // a thin white ring separates the dot from the disc
        if (db <= bR) return [RED, cover(db, bR)];
        return [WHITE, cover(db, bR + 1.5)];
      }
    }
    const d = Math.hypot(x - c, y - c);
    if (d > R + 1) return null;
    // A white "Y": two arms meeting just above the centre, and a stem.
    const t = size * 0.075;
    const top = c - R * 0.5;
    const join = c + R * 0.05;
    const arm = R * 0.42;
    const segs: Array<[number, number, number, number]> = [
      [c - arm, top, c, join],
      [c + arm, top, c, join],
      [c, join, c, c + R * 0.52],
    ];
    const inY = segs.some(([x1, y1, x2, y2]) => segDist(x, y, x1, y1, x2, y2) < t);
    return [inY ? WHITE : CLAY, cover(d, R)];
  });
}

export function overlayBadge(): NativeImage {
  return draw(16, (x, y) => {
    const d = Math.hypot(x - 8, y - 8);
    return d <= 7.5 ? [RED, cover(d, 7)] : null;
  });
}
