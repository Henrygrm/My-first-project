// Brand engine: turns a business's colours (from its logo, photos or brand kit)
// plus a creative direction into a full, contrast-checked palette.
import { clamp, contrast, ensureContrast, hexToRgb, hsl, luminance, mixColor, readableOn, rng, toHsl } from './core.js';

/** Typical colours per industry, used only when a business has none of its own. */
export const INDUSTRY_COLORS = {
  cafe: ['#7b4b2a', '#d9a066', '#2f5d50'],
  restaurant: ['#c0392b', '#f2b134', '#1e3d2f'],
  barber: ['#1f2a44', '#c8102e', '#d4af37'],
  detailing: ['#0a84ff', '#00d1ff', '#111827'],
  trades: ['#f2a900', '#1d3557', '#e63946'],
  gym: ['#ff3b30', '#ffd60a', '#0f172a'],
  other: ['#6c5ce7', '#00b894', '#fd79a8'],
};

const sat = (hex) => toHsl(hex)[1];
const light = (hex) => toHsl(hex)[2];
const hue = (hex) => toHsl(hex)[0];
const hueDist = (a, b) => {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return d > 180 ? 360 - d : d;
};

/** Is this colour usable as a brand colour (not near-white/black/grey)? */
export function isChromatic(hex) {
  const [, s, l] = toHsl(hex);
  return s > 0.18 && l > 0.12 && l < 0.9;
}

/**
 * Build palette roles.
 * brandColors: ordered best-first (e.g. from logo extraction or the brand kit).
 * tone: 'dark' | 'light' | 'bright' | 'any' (from the direction).
 * Returns { bg, bg2, surface, primary, accent, text, textMuted, onPrimary, onAccent, flash, dark }
 */
export function buildPalette({ brandColors = [], industry = 'other', tone = 'any', seed = 1, direction } = {}) {
  const r = rng(seed);
  const given = brandColors.filter((c) => hexToRgb(c)).map((c) => c.toLowerCase());
  const chroma = given.filter(isChromatic);
  const pool = chroma.length ? chroma : INDUSTRY_COLORS[industry] || INDUSTRY_COLORS.other;

  // Primary: the most characterful brand colour.
  const primary = [...pool].sort((a, b) => sat(b) * (1 - Math.abs(light(b) - 0.5)) - sat(a) * (1 - Math.abs(light(a) - 0.5)))[0];
  // Accent: a second brand colour that differs enough; otherwise derived.
  let accent = pool.find((c) => c !== primary && (hueDist(c, primary) > 28 || Math.abs(light(c) - light(primary)) > 0.25));
  if (!accent) {
    const [h, s, l] = toHsl(primary);
    if (direction === 'luxury') accent = hsl(42, 0.55, 0.62); // champagne gold
    else if (direction === 'energetic' || direction === 'playful') accent = hsl(h + 165 + r() * 30, clamp(s + 0.1, 0.55, 0.95), 0.58);
    else if (direction === 'futuristic') accent = hsl(h + 180, 0.9, 0.6);
    // Calm directions: a richer shade of the brand's own colour (monochrome
    // schemes look designed; invented second colours often look muddy).
    else accent = hsl(h, clamp(s * 1.1, 0.5, 0.9), clamp(l, 0.42, 0.6));
  }

  // Background tone: the direction's preference, unless a light-tone direction
  // would make a dark brand colour look muddy (and vice versa) — then flip.
  let dark;
  if (tone === 'dark') dark = true;
  else if (tone === 'light') dark = false;
  else if (tone === 'bright') dark = false;
  else dark = r() < 0.5;

  const [ph, ps] = toHsl(primary);
  let bg, bg2, surface;
  if (tone === 'bright') {
    // Saturated brand-coloured background (playful).
    bg = hsl(ph, clamp(ps, 0.55, 0.9), 0.55);
    bg2 = hsl(hue(accent), clamp(sat(accent), 0.55, 0.9), 0.6);
    surface = '#ffffff';
    dark = luminance(bg) < 0.35;
  } else if (dark) {
    bg = hsl(ph, clamp(ps * 0.5, 0.12, 0.4), 0.07);
    bg2 = hsl(ph, clamp(ps * 0.55, 0.12, 0.45), 0.15);
    surface = hsl(ph, clamp(ps * 0.4, 0.08, 0.3), 0.13);
  } else {
    bg = hsl(ph, clamp(ps * 0.35, 0.08, 0.35), 0.955);
    bg2 = hsl(ph, clamp(ps * 0.45, 0.1, 0.4), 0.88);
    surface = '#ffffff';
  }

  const text = dark ? hsl(ph, 0.15, 0.97) : hsl(ph, 0.3, 0.1);
  const textMuted = mixColor(text, bg, 0.35);
  // Graphics need 3:1 against the background; text on them needs 4.5:1.
  const primaryOnBg = ensureContrast(primary, bg, 3);
  const accentOnBg = ensureContrast(accent, bg, 3);
  return {
    bg, bg2, surface,
    primary: primaryOnBg,
    accent: accentOnBg,
    brand: primary,
    brand2: accent,
    text: ensureContrast(text, bg, 7),
    textMuted: ensureContrast(textMuted, bg, 4.5),
    onPrimary: readableOn(primaryOnBg),
    onAccent: readableOn(accentOnBg),
    onSurface: readableOn(surface),
    flash: dark ? '#ffffff' : accentOnBg,
    dark,
  };
}

/** Quick contrast audit used by QA. */
export function paletteIssues(p) {
  const issues = [];
  if (contrast(p.text, p.bg) < 4.5) issues.push('Body text contrast below 4.5:1');
  if (contrast(p.accent, p.bg) < 3) issues.push('Accent colour hard to see on the background');
  if (contrast(p.onAccent, p.accent) < 4.5) issues.push('Text on accent colour hard to read');
  return issues;
}
