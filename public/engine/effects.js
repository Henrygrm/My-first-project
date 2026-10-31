// Visual effects for the motion engine: particles, light, grain, shapes, icons.
import { clamp, ease, lerp, noise1, rgba, rng } from './core.js';

// ---------------------------------------------------------------------------
// Particles (deterministic: particle i at time t is a pure function)
// ---------------------------------------------------------------------------

/**
 * kinds: steam, dust, sparkle, droplets, bubbles, confetti, embers, bokeh, streaks, foam
 * area: { x, y, w, h } in pixels (where particles live / originate)
 */
export function drawParticles(ctx, { kind, count = 30, color = '#ffffff', color2, area, t, seed = 1, opacity = 1, scale = 1, W, H }) {
  const r = rng(seed);
  const m = Math.min(W, H);
  ctx.save();
  for (let i = 0; i < count; i++) {
    const a = r(), b = r(), c = r(), d = r(), e = r();
    const life = 2 + c * 3;
    const phase = fract(t / life + a);
    const px = area.x + b * area.w;
    const py = area.y + d * area.h;
    switch (kind) {
      case 'steam': {
        // Soft wisps rising, swaying, growing and fading.
        const k = phase;
        const x = px + noise1(t * 0.6 + i, seed) * m * 0.03 * (1 + k * 2);
        const y = area.y + area.h - k * area.h * 1.3;
        const rad = m * (0.025 + k * 0.06) * scale;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        const alpha = Math.sin(Math.PI * k) * 0.22 * opacity;
        g.addColorStop(0, rgba(color, alpha));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
        break;
      }
      case 'droplets': {
        // Water beads that fall and streak, with a highlight.
        const k = phase;
        const x = px;
        const y = area.y + k * area.h * 1.1;
        const rad = m * (0.004 + e * 0.008) * scale;
        const alpha = Math.min(1, Math.sin(Math.PI * k) * 1.4) * opacity;
        ctx.globalAlpha = alpha * 0.85;
        const g = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.4, rad * 0.1, x, y, rad);
        g.addColorStop(0, 'rgba(255,255,255,0.95)');
        g.addColorStop(0.35, rgba(color, 0.55));
        g.addColorStop(1, rgba(color, 0.15));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(x, y, rad, rad * 1.35, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = alpha * 0.25;
        ctx.strokeStyle = rgba(color, 0.6);
        ctx.lineWidth = rad * 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y - rad);
        ctx.lineTo(x, y - rad - m * 0.04 * scale);
        ctx.stroke();
        break;
      }
      case 'bubbles':
      case 'foam': {
        const k = phase;
        const x = px + Math.sin(t * 1.3 + i) * m * 0.01;
        const y = area.y + area.h - k * area.h;
        const rad = m * (kind === 'foam' ? 0.006 + e * 0.02 : 0.006 + e * 0.014) * scale;
        ctx.globalAlpha = Math.sin(Math.PI * k) * 0.7 * opacity;
        ctx.strokeStyle = rgba(color, 0.8);
        ctx.lineWidth = Math.max(1, rad * 0.12);
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = rgba('#ffffff', 0.5);
        ctx.beginPath();
        ctx.arc(x - rad * 0.35, y - rad * 0.35, rad * 0.22, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'sparkle': {
        const k = phase;
        const tw = Math.max(0, Math.sin(Math.PI * k * 2)) ** 3;
        const rad = m * (0.006 + e * 0.014) * scale * tw;
        if (rad < 0.5) break;
        ctx.globalAlpha = tw * opacity;
        drawSparkle(ctx, px, py, rad, color);
        break;
      }
      case 'embers': {
        const k = phase;
        const x = px + noise1(t + i * 3, seed) * m * 0.05;
        const y = area.y + area.h - k * area.h * 1.2;
        const rad = m * (0.002 + e * 0.004) * scale;
        ctx.globalAlpha = Math.sin(Math.PI * k) * opacity;
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = rad * 6;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        break;
      }
      case 'confetti': {
        const k = phase;
        const x = px + Math.sin(t * 2 + i) * m * 0.03;
        const y = area.y + k * area.h;
        const w = m * 0.012 * scale, h = m * 0.006 * scale;
        ctx.globalAlpha = Math.min(1, (1 - k) * 2) * opacity;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(t * (2 + e * 4) + i);
        ctx.scale(1, Math.cos(t * 5 + i));
        ctx.fillStyle = i % 2 && color2 ? color2 : color;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.restore();
        break;
      }
      case 'streaks': {
        // Fast light streaks (speed lines), horizontal.
        const k = phase;
        const y = py;
        const len = m * (0.15 + e * 0.3) * scale;
        const x = area.x - len + k * (area.w + len * 2);
        const g = ctx.createLinearGradient(x, y, x + len, y);
        g.addColorStop(0, rgba(color, 0));
        g.addColorStop(1, rgba(color, 0.5 * opacity));
        ctx.globalAlpha = 1;
        ctx.strokeStyle = g;
        ctx.lineWidth = Math.max(1, m * 0.002 * scale);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + len, y);
        ctx.stroke();
        break;
      }
      case 'bokeh':
      default: {
        const x = px + noise1(t * 0.15 + i, seed) * m * 0.04;
        const y = py + noise1(t * 0.12 + i * 7, seed + 1) * m * 0.04;
        const rad = m * (0.02 + e * 0.06) * scale;
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.8 + i * 1.7);
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, rgba(color, 0.18 * pulse * opacity));
        g.addColorStop(0.7, rgba(color, 0.08 * pulse * opacity));
        g.addColorStop(1, rgba(color, 0));
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
        break;
      }
      case 'dust': {
        const x = px + noise1(t * 0.3 + i, seed) * m * 0.06;
        const y = py + noise1(t * 0.25 + i * 5, seed + 2) * m * 0.06 - t * m * 0.005;
        const rad = m * (0.0012 + e * 0.0025) * scale;
        ctx.globalAlpha = (0.3 + 0.5 * Math.abs(Math.sin(t + i))) * opacity;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
  }
  ctx.restore();
}

const fract = (x) => x - Math.floor(x);

export function drawSparkle(ctx, x, y, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = r * 1.5;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const rr = i % 2 ? r * 0.18 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Light
// ---------------------------------------------------------------------------

/** A diagonal sheen band crossing `rect` at progress p (0..1). Use inside a clip. */
export function drawSweep(ctx, rect, p, color = '#ffffff', strength = 0.55, angle = -0.35) {
  const { x, y, w, h } = rect;
  const band = Math.max(w, h) * 0.35;
  const cx = lerp(x - band * 2, x + w + band * 2, p);
  ctx.save();
  ctx.translate(cx, y + h / 2);
  ctx.rotate(angle);
  const g = ctx.createLinearGradient(-band, 0, band, 0);
  g.addColorStop(0, rgba(color, 0));
  g.addColorStop(0.5, rgba(color, strength));
  g.addColorStop(1, rgba(color, 0));
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.fillRect(-band, -Math.max(w, h) * 2, band * 2, Math.max(w, h) * 4);
  ctx.restore();
}

/** Soft coloured light leak drifting across the frame. */
export function drawLightLeak(ctx, W, H, t, color, strength = 0.35, seed = 3) {
  const x = W * (0.5 + 0.6 * noise1(t * 0.2, seed));
  const y = H * (0.3 + 0.4 * noise1(t * 0.17, seed + 9));
  const r = Math.max(W, H) * 0.7;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, strength));
  g.addColorStop(1, rgba(color, 0));
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

export function drawGlow(ctx, x, y, r, color, strength = 0.5) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, strength));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** Radiating light rays behind a subject (offers, reveals). */
export function drawRays(ctx, x, y, r, t, color, count = 14, strength = 0.18) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t * 0.15);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const g = ctx.createLinearGradient(0, 0, Math.cos(a) * r, Math.sin(a) * r);
    g.addColorStop(0, rgba(color, strength));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, a - Math.PI / count / 2.4, a + Math.PI / count / 2.4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Finishing: grain and vignette
// ---------------------------------------------------------------------------

/** A 256×256 noise tile; draw it with drawGrain each frame at a random offset. */
export function makeGrainTile(makeCanvas, seed = 7) {
  const S = 256;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const r = rng(seed);
  for (let i = 0; i < S * S; i++) {
    const v = 128 + (r() - 0.5) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

export function drawGrain(ctx, tile, W, H, frame, amount) {
  if (!tile || amount <= 0) return;
  const r = rng(frame + 11);
  const ox = Math.floor(r() * 256), oy = Math.floor(r() * 256);
  ctx.save();
  ctx.globalAlpha = amount;
  ctx.globalCompositeOperation = 'overlay';
  for (let y = -oy; y < H; y += 256) for (let x = -ox; x < W; x += 256) ctx.drawImage(tile, x, y);
  ctx.restore();
}

export function drawVignette(ctx, W, H, amount = 0.35, color = '#000000') {
  if (amount <= 0) return;
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  g.addColorStop(0, rgba(color, 0));
  g.addColorStop(1, rgba(color, amount));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Starburst badge outline (offers). */
export function burstPath(ctx, x, y, r, points = 16, inner = 0.86, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = rot + (i * Math.PI) / points;
    const rr = i % 2 ? r * inner : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

/** Organic blob that slowly morphs (backgrounds, playful looks). */
export function blobPath(ctx, x, y, r, t, seed = 1, wobble = 0.18) {
  ctx.beginPath();
  const n = 64;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + wobble * (noise1(Math.cos(a) * 1.5 + t * 0.4, seed) * 0.6 + noise1(Math.sin(a) * 1.5 + t * 0.3, seed + 3) * 0.4);
    const px = x + Math.cos(a) * r * k, py = y + Math.sin(a) * r * k;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

export function starPath(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Icons: simple 24×24 line icons drawn as SVG path data (our own drawings)
// ---------------------------------------------------------------------------

export const ICONS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2',
  pin: 'M12 21s-6-5.6-6-11a6 6 0 1 1 12 0c0 5.4-6 11-6 11zM12 7.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
  phone: 'M6.5 3h3l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A17 17 0 0 1 4.5 5a2 2 0 0 1 2-2z',
  shield: 'M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z',
  leaf: 'M5 19c0-8 5-13 14-14 0 9-5 14-13 14M5 19l7-7',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  cup: 'M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3',
  scissors: 'M6 6a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M6 13a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M8 10l12 8M8 14l12-8',
  car: 'M4 16v-3l2-5h12l2 5v3zM4 16v2h3v-2M17 16v2h3v-2M7.5 13.5h.01M16.5 13.5h.01',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  wrench: 'M15 4a5 5 0 0 0-4.6 6.9L4 17.3 6.7 20l6.4-6.4A5 5 0 0 0 20 9l-3 3-3-3 3-3a5 5 0 0 0-2-2z',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  fork: 'M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M16 3c-2 0-3 3-3 6s1 4 3 4v8',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  heart: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z',
  dumbbell: 'M3 10v4M6 8v8M18 8v8M21 10v4M6 12h12',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  tag: 'M3 12V4h8l9 9-8 8zM7.5 7.5h.01',
  truck: 'M3 6h11v10H3zM14 10h4l3 3v3h-7M7 18a1.5 1.5 0 1 0 0-.01M17 18a1.5 1.5 0 1 0 0-.01',
};

const iconCache = new Map();
export function drawIcon(ctx, name, x, y, size, color, lineWidth = 2) {
  const d = ICONS[name] || ICONS.check;
  let p = iconCache.get(name);
  if (!p && typeof Path2D !== 'undefined') {
    p = new Path2D(d);
    iconCache.set(name, p);
  }
  if (!p) return;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(p);
  ctx.restore();
}

export { clamp, ease };
