// Cutline motion engine: composition renderer.
//
// A composition is a list of scenes; each scene is a stack of layers drawn
// back to front, with a camera (zoom/pan/rotate) that moves near layers more
// than far ones (parallax). Layers animate with entrance / idle / exit
// presets plus optional keyframe tracks. Scenes join with transitions, and
// the finished frame gets a colour grade, vignette, light leaks and grain.
//
// Coordinates: x, y, w, h are fractions of the frame (0..1); sizes of type
// and strokes are fractions of the frame's shorter side (m).
import {
  clamp, contrast, drawWord, ease, EASE, fontString, layoutText, lerp, mixColor, noise1, readableOn, rgba, roundRect, sampleTrack, spring,
} from './core.js';
import {
  blobPath, burstPath, drawGlow, drawGrain, drawIcon, drawLightLeak, drawParticles, drawRays, drawSweep, drawVignette, makeGrainTile, starPath,
} from './effects.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Animation state of a layer at local time lt
// ---------------------------------------------------------------------------

function entrance(type, p, m, W, H) {
  const inv = 1 - p;
  const s = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, alpha: 1, blur: 0, clip: null, tilt: 0 };
  switch (type) {
    case 'fade': s.alpha = p; break;
    case 'rise': s.dy = inv * m * 0.09; s.alpha = clamp(p * 1.6, 0, 1); break;
    case 'drop': s.dy = -inv * H * 0.35; s.alpha = clamp(p * 4, 0, 1); break;
    case 'pop': s.sx = s.sy = 0.35 + 0.65 * p; s.alpha = clamp(p * 2.5, 0, 1); break;
    case 'zoom': s.sx = s.sy = 1 + 0.4 * inv; s.alpha = p; break;
    case 'scaleDown': s.sx = s.sy = 1 + 1.6 * inv; s.alpha = clamp(p * 1.5, 0, 1); break;
    case 'slideL': s.dx = -inv * W * 0.7; break;
    case 'slideR': s.dx = inv * W * 0.7; break;
    case 'slideU': s.dy = inv * H * 0.55; break;
    case 'slideD': s.dy = -inv * H * 0.55; break;
    case 'blur': s.blur = inv * m * 0.05; s.alpha = clamp(p * 1.4, 0, 1); s.sx = s.sy = 1.06 - 0.06 * p; break;
    case 'wipe': s.clip = { kind: 'wipe', p }; break;
    case 'wipeDown': s.clip = { kind: 'wipeDown', p }; break;
    case 'reveal': s.clip = { kind: 'reveal', p }; s.dy = inv * m * 0.04; break;
    case 'iris': s.clip = { kind: 'iris', p }; break;
    case 'spin': s.rot = -inv * 28 * DEG; s.sx = s.sy = 0.6 + 0.4 * p; s.alpha = clamp(p * 2, 0, 1); break;
    case 'tilt': s.tilt = inv * 75 * DEG; s.alpha = clamp(p * 2, 0, 1); break;
    case 'whip': s.dx = inv * W * 0.9; s.alpha = clamp(p * 3, 0, 1); break;
    case 'none': default: break;
  }
  return s;
}

const IN_EASE = {
  pop: 'outBack', drop: null, spin: 'outBackSoft', tilt: 'glide', zoom: 'glide', scaleDown: 'outExpo',
  whip: 'outExpo', slideL: 'outExpo', slideR: 'outExpo', slideU: 'outExpo', slideD: 'outExpo',
};

function layerState(layer, lt, sceneDur, env) {
  const { m, W, H } = env;
  const st = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, alpha: 1, blur: 0, clip: null, tilt: 0 };
  const speed = env.motionSpeed || 1;
  const inn = layer.in;
  if (inn && inn.type && inn.type !== 'none') {
    const at = inn.at || 0;
    const dur = (inn.dur || 0.6) / speed;
    const raw = clamp((lt - at) / dur, 0, 1);
    let p;
    if (inn.type === 'drop') p = clamp(spring(Math.max(0, lt - at) * speed, { stiffness: 140, damping: 13 }), 0, 1.15);
    else p = ease(inn.ease || IN_EASE[inn.type] || env.ease || 'outCubic', raw);
    if (lt < at) p = 0;
    merge(st, entrance(inn.type, p, m, W, H));
  }
  const out = layer.out;
  if (out && out.type && out.type !== 'none') {
    const dur = (out.dur || 0.4) / speed;
    const start = sceneDur - dur - (out.before || 0);
    if (lt > start) {
      const p = 1 - ease(out.ease || 'inCubic', clamp((lt - start) / dur, 0, 1));
      merge(st, entrance(out.type, p, m, W, H));
    }
  }
  const idle = layer.idle;
  if (idle && idle.type) {
    const a = idle.amt ?? 1;
    const sp = idle.speed ?? 1;
    const ph = idle.phase ?? 0;
    switch (idle.type) {
      case 'float': st.dy += Math.sin(lt * 1.6 * sp + ph) * m * 0.012 * a; st.rot += Math.sin(lt * 1.1 * sp + ph) * 1.4 * DEG * a; break;
      case 'breathe': { const k = 1 + 0.018 * a * Math.sin(lt * 2 * sp + ph); st.sx *= k; st.sy *= k; break; }
      case 'drift': st.dx += (lt - sceneDur / 2) * m * 0.012 * a * sp; break;
      case 'driftUp': st.dy -= (lt - sceneDur / 2) * m * 0.01 * a * sp; break;
      case 'spin': st.rot += lt * 18 * DEG * a * sp; break;
      case 'sway': st.rot += Math.sin(lt * 1.5 * sp + ph) * 3 * DEG * a; break;
      case 'pulse': { const k = 1 + 0.045 * a * (env.pulse || 0); st.sx *= k; st.sy *= k; break; }
      case 'orbit': st.dx += Math.cos(lt * 0.9 * sp + ph) * m * 0.03 * a; st.dy += Math.sin(lt * 0.9 * sp + ph) * m * 0.02 * a; break;
      default: break;
    }
  }
  const kf = layer.kf;
  if (kf) {
    if (kf.x) st.dx += (sampleTrack(kf.x, lt, 0)) * W;
    if (kf.y) st.dy += (sampleTrack(kf.y, lt, 0)) * H;
    if (kf.scale) { const k = sampleTrack(kf.scale, lt, 1); st.sx *= k; st.sy *= k; }
    if (kf.rot) st.rot += sampleTrack(kf.rot, lt, 0) * DEG;
    if (kf.opacity) st.alpha *= sampleTrack(kf.opacity, lt, 1);
    if (kf.blur) st.blur += sampleTrack(kf.blur, lt, 0) * m;
  }
  st.alpha *= layer.opacity ?? 1;
  return st;
}

function merge(a, b) {
  a.dx += b.dx; a.dy += b.dy; a.sx *= b.sx; a.sy *= b.sy; a.rot += b.rot;
  a.alpha *= b.alpha; a.blur += b.blur; a.tilt += b.tilt;
  if (b.clip) a.clip = b.clip;
}

// ---------------------------------------------------------------------------
// Colour roles
// ---------------------------------------------------------------------------

/** "accent", "text", "primary"… or a literal #hex. */
export function color(env, c, fallback = 'text') {
  if (!c) c = fallback;
  if (c.startsWith('#')) return c;
  return env.palette[c] || env.palette[fallback] || '#ffffff';
}

// ---------------------------------------------------------------------------
// Layer drawing
// ---------------------------------------------------------------------------

function boxOf(layer, env) {
  const w = (layer.w ?? 1) * env.W;
  const h = (layer.h ?? (layer.w ?? 1)) * env.H;
  return { cx: (layer.x ?? 0.5) * env.W, cy: (layer.y ?? 0.5) * env.H, w, h };
}

function applyCamera(ctx, layer, env) {
  const cam = env.cam;
  if (!cam || layer.fixed) return;
  const d = layer.z ?? 0;
  const f = 1 / (1 + Math.max(-0.6, d));
  const { W, H } = env;
  ctx.translate(W / 2, H / 2);
  const z = 1 + (cam.zoom - 1) * f;
  ctx.scale(z, z);
  ctx.rotate(cam.rot * DEG * f);
  ctx.translate(-W / 2 - cam.x * W * f, -H / 2 - cam.y * H * f);
}

function clipFor(ctx, clip, b) {
  if (!clip) return;
  const { cx, cy, w, h } = b;
  ctx.beginPath();
  if (clip.kind === 'wipe') ctx.rect(cx - w / 2 - 2, cy - h / 2 - h, (w + 4) * clip.p, h * 3);
  else if (clip.kind === 'wipeDown') ctx.rect(cx - w / 2 - w, cy - h / 2 - 2, w * 3, (h + 4) * clip.p);
  else if (clip.kind === 'reveal') ctx.rect(cx - w / 2 - w, cy + h / 2 - (h + 4) * clip.p, w * 3, (h + 4) * clip.p + h);
  else if (clip.kind === 'iris') ctx.arc(cx, cy, Math.hypot(w, h) / 2 * clip.p + 1, 0, Math.PI * 2);
  ctx.clip();
}

/** Fit an image of iw×ih into box w×h ('cover' crops, 'contain' fits). */
function fitRect(iw, ih, w, h, fit = 'cover', focus = { x: 0.5, y: 0.5 }) {
  const s = fit === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  return { x: -w / 2 + (w - dw) * (fit === 'contain' ? 0.5 : focus.x), y: -h / 2 + (h - dh) * (fit === 'contain' ? 0.5 : focus.y), w: dw, h: dh };
}

function drawLayerContent(ctx, layer, lt, sceneDur, env, st) {
  const { W, H, m } = env;
  switch (layer.type) {
    case 'bg': return drawBackground(ctx, layer, lt, env);
    case 'image': case 'cutout': case 'logo': case 'video': return drawMedia(ctx, layer, lt, sceneDur, env, st);
    case 'text': return drawText(ctx, layer, lt, env, st);
    case 'shape': return drawShape(ctx, layer, lt, env);
    case 'particles': {
      const a = layer.area || { x: 0, y: 0, w: 1, h: 1 };
      return drawParticles(ctx, { kind: layer.kind, count: layer.count, color: color(env, layer.color, 'text'), color2: layer.color2 && color(env, layer.color2), area: { x: a.x * W, y: a.y * H, w: a.w * W, h: a.h * H }, t: lt + (layer.seedTime || 0), seed: layer.seed || 1, opacity: 1, scale: layer.scale || 1, W, H });
    }
    case 'light': return drawLight(ctx, layer, lt, sceneDur, env);
    case 'button': return drawButton(ctx, layer, lt, env);
    case 'stars': return drawStars(ctx, layer, lt, env);
    case 'icon': {
      const b = boxOf(layer, env);
      if (layer.disc) {
        ctx.fillStyle = color(env, layer.disc, 'accent');
        ctx.beginPath();
        ctx.arc(b.cx, b.cy, (layer.size || 0.05) * m * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
      return drawIcon(ctx, layer.icon, b.cx, b.cy, (layer.size || 0.05) * m, color(env, layer.color, 'accent'), layer.lineWidth || 2.2);
    }
    case 'compare': return drawCompare(ctx, layer, lt, sceneDur, env);
    default: return undefined;
  }
}

/** Draw one layer with its animation, camera, clip, blur and (if moving fast) motion blur. */
function drawLayer(ctx, layer, lt, sceneDur, env) {
  if (layer.start !== undefined && lt < layer.start) return;
  if (layer.end !== undefined && lt > layer.end) return;
  const st = layerState(layer, lt, sceneDur, env);
  if (st.alpha <= 0.002) return;

  // Motion blur: average a few sub-frame positions while the layer moves fast.
  let samples = 1;
  let prev = null;
  if (layer.mb !== false && env.motionBlur && layer.type !== 'bg' && layer.type !== 'particles') {
    const dt = (1 / env.fps) * 0.5;
    prev = layerState(layer, lt - dt, sceneDur, env);
    const moved = Math.hypot(st.dx - prev.dx, st.dy - prev.dy) + Math.abs(st.sx - prev.sx) * env.m * 0.6 + Math.abs(st.rot - prev.rot) * env.m * 0.3;
    if (moved > env.m * 0.006) samples = moved > env.m * 0.03 ? 5 : 3;
  }

  for (let i = 0; i < samples; i++) {
    const k = samples === 1 ? 0 : i / (samples - 1);
    const s = samples === 1 ? st : interpState(prev, st, k);
    ctx.save();
    // Running average: sample i drawn at 1/(i+1) gives equal weights.
    ctx.globalAlpha = s.alpha * (samples === 1 ? 1 : 1 / (i + 1)) * (env.alphaMul ?? 1);
    if (layer.blend) ctx.globalCompositeOperation = layer.blend;
    applyCamera(ctx, layer, env);
    if (layer.type !== 'bg') {
      const b = boxOf(layer, env);
      ctx.translate(b.cx + s.dx, b.cy + s.dy);
      if (s.rot) ctx.rotate(s.rot);
      if (s.tilt) {
        // Fake 3D flip: squash horizontally and shear a little for perspective.
        const c = Math.cos(s.tilt);
        ctx.transform(Math.max(0.02, c), Math.sin(s.tilt) * 0.12, 0, 1, 0, 0);
      }
      if (s.sx !== 1 || s.sy !== 1) ctx.scale(s.sx, s.sy);
      ctx.translate(-b.cx, -b.cy);
      if (s.clip) clipFor(ctx, s.clip, b);
    }
    if (s.blur > 0.3) ctx.filter = `blur(${s.blur.toFixed(1)}px)`;
    drawLayerContent(ctx, layer, lt, sceneDur, env, s);
    ctx.restore();
  }
}

function interpState(a, b, k) {
  return {
    dx: lerp(a.dx, b.dx, k), dy: lerp(a.dy, b.dy, k), sx: lerp(a.sx, b.sx, k), sy: lerp(a.sy, b.sy, k),
    rot: lerp(a.rot, b.rot, k), alpha: b.alpha, blur: b.blur, clip: b.clip, tilt: lerp(a.tilt, b.tilt, k),
  };
}

// --- backgrounds -------------------------------------------------------------

function drawBackground(ctx, layer, lt, env) {
  const { W, H, m } = env;
  const cols = (layer.colors || ['bg', 'bg2']).map((c) => color(env, c, 'bg'));
  // Backgrounds overscan so camera moves never show an edge.
  const pad = Math.max(W, H) * 0.25;
  const X = -pad, Y = -pad, BW = W + pad * 2, BH = H + pad * 2;
  switch (layer.kind) {
    case 'solid':
      ctx.fillStyle = cols[0];
      ctx.fillRect(X, Y, BW, BH);
      break;
    case 'radial': {
      const cx = W * (layer.cx ?? 0.5), cy = H * (layer.cy ?? 0.42);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.85);
      g.addColorStop(0, cols[0]);
      g.addColorStop(1, cols[1] || cols[0]);
      ctx.fillStyle = g;
      ctx.fillRect(X, Y, BW, BH);
      break;
    }
    case 'studio': {
      // Seamless photo-studio backdrop: lit wall fading to a floor, a soft
      // pool of light where the product stands.
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, cols[1] || cols[0]);
      g.addColorStop(0.62, cols[0]);
      g.addColorStop(1, mixColor(cols[1] || cols[0], '#000000', 0.25));
      ctx.fillStyle = g;
      ctx.fillRect(X, Y, BW, BH);
      const fy = H * (layer.floor ?? 0.66);
      const pool = ctx.createRadialGradient(W / 2, fy, 0, W / 2, fy, W * 0.7);
      pool.addColorStop(0, rgba(layer.light ? color(env, layer.light) : '#ffffff', env.palette.dark ? 0.14 : 0.35));
      pool.addColorStop(1, rgba('#ffffff', 0));
      ctx.fillStyle = pool;
      ctx.fillRect(X, Y, BW, BH);
      const top = ctx.createRadialGradient(W / 2, -H * 0.1, 0, W / 2, -H * 0.1, H * 0.9);
      top.addColorStop(0, rgba('#ffffff', env.palette.dark ? 0.1 : 0.25));
      top.addColorStop(1, rgba('#ffffff', 0));
      ctx.fillStyle = top;
      ctx.fillRect(X, Y, BW, BH);
      break;
    }
    case 'spotlight': {
      ctx.fillStyle = cols[0];
      ctx.fillRect(X, Y, BW, BH);
      const cx = W * (layer.cx ?? 0.5), cy = H * (layer.cy ?? 0.45);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, m * 0.75);
      g.addColorStop(0, rgba(cols[1] || '#ffffff', 0.55));
      g.addColorStop(1, rgba(cols[1] || '#ffffff', 0));
      ctx.fillStyle = g;
      ctx.fillRect(X, Y, BW, BH);
      break;
    }
    case 'mesh': {
      // Slowly moving colour fields ("aurora").
      ctx.fillStyle = cols[0];
      ctx.fillRect(X, Y, BW, BH);
      const blobs = cols.slice(1).length ? cols.slice(1) : [cols[0]];
      blobs.forEach((c, i) => {
        const x = W * (0.5 + 0.45 * noise1(lt * 0.18 + i * 3.1, 11 + i));
        const y = H * (0.5 + 0.45 * noise1(lt * 0.15 + i * 5.7, 23 + i));
        drawGlow(ctx, x, y, Math.max(W, H) * (0.55 + 0.1 * i), c, layer.strength ?? 0.6);
      });
      break;
    }
    case 'stripes': {
      ctx.fillStyle = cols[0];
      ctx.fillRect(X, Y, BW, BH);
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate(-20 * DEG);
      ctx.fillStyle = rgba(cols[1] || '#ffffff', layer.strength ?? 0.08);
      const sw = m * 0.06;
      const off = (lt * m * 0.05) % (sw * 2);
      for (let x = -Math.max(W, H) * 1.2 + off; x < Math.max(W, H) * 1.2; x += sw * 2) ctx.fillRect(x, -Math.max(W, H), sw, Math.max(W, H) * 2);
      ctx.restore();
      break;
    }
    case 'grid': {
      // Perspective floor grid that scrolls towards the viewer.
      ctx.fillStyle = cols[0];
      ctx.fillRect(X, Y, BW, BH);
      const hz = H * (layer.horizon ?? 0.55);
      ctx.save();
      ctx.strokeStyle = rgba(cols[1] || '#ffffff', layer.strength ?? 0.25);
      ctx.lineWidth = Math.max(1, m * 0.0016);
      for (let i = -12; i <= 12; i++) {
        ctx.beginPath();
        ctx.moveTo(W / 2 + i * W * 0.02, hz);
        ctx.lineTo(W / 2 + i * W * 0.3, H * 1.3);
        ctx.stroke();
      }
      const phase = (lt * 0.4) % 1;
      for (let j = 0; j < 14; j++) {
        const k = (j + phase) / 14;
        const y = hz + (H * 1.3 - hz) * k * k;
        ctx.globalAlpha = k;
        ctx.beginPath();
        ctx.moveTo(-W, y);
        ctx.lineTo(W * 2, y);
        ctx.stroke();
      }
      ctx.restore();
      const glow = ctx.createLinearGradient(0, hz - H * 0.15, 0, hz + H * 0.05);
      glow.addColorStop(0, rgba(cols[1] || '#ffffff', 0));
      glow.addColorStop(0.8, rgba(cols[1] || '#ffffff', 0.25));
      glow.addColorStop(1, rgba(cols[1] || '#ffffff', 0));
      ctx.fillStyle = glow;
      ctx.fillRect(X, hz - H * 0.15, BW, H * 0.2);
      break;
    }
    case 'paper': {
      ctx.fillStyle = cols[0];
      ctx.fillRect(X, Y, BW, BH);
      drawGlow(ctx, W * 0.2, H * 0.15, m * 0.9, cols[1] || '#ffffff', 0.25);
      drawGlow(ctx, W * 0.9, H * 0.85, m * 0.8, cols[1] || '#ffffff', 0.18);
      break;
    }
    case 'photo': {
      // A photo, heavily blurred and tinted: depth behind cutouts and type.
      const a = env.assets[layer.src];
      ctx.fillStyle = cols[0];
      ctx.fillRect(X, Y, BW, BH);
      if (a?.img) {
        ctx.save();
        ctx.filter = `blur(${Math.round(m * (layer.blur ?? 0.03))}px)`;
        const r = fitRect(a.w, a.h, BW, BH, 'cover', a.focus);
        ctx.drawImage(a.img, W / 2 + r.x, H / 2 + r.y, r.w, r.h);
        ctx.restore();
        ctx.fillStyle = rgba(cols[0], layer.tint ?? 0.55);
        ctx.fillRect(X, Y, BW, BH);
      }
      break;
    }
    case 'gradient':
    default: {
      const ang = (layer.angle ?? 150) * DEG + Math.sin(lt * 0.25) * 0.15;
      const r = Math.max(W, H);
      const g = ctx.createLinearGradient(W / 2 - Math.cos(ang) * r / 2, H / 2 - Math.sin(ang) * r / 2, W / 2 + Math.cos(ang) * r / 2, H / 2 + Math.sin(ang) * r / 2);
      cols.forEach((c, i) => g.addColorStop(cols.length === 1 ? 0 : i / (cols.length - 1), c));
      ctx.fillStyle = g;
      ctx.fillRect(X, Y, BW, BH);
      break;
    }
  }
}

// --- media: photos, cutouts, logos, video --------------------------------------

function drawMedia(ctx, layer, lt, sceneDur, env, st) {
  const { m } = env;
  const b = boxOf(layer, env);
  let src = null;
  let iw = 0, ih = 0, focus = { x: 0.5, y: 0.5 };
  const asset = env.assets[layer.src];
  if (layer.type === 'video') {
    const frame = env.video?.(layer.src, lt + (layer.from || 0), layer);
    if (frame) {
      src = frame.img;
      iw = frame.w;
      ih = frame.h;
    }
  } else if (asset) {
    // A cutout layer uses the transparent version when there is one.
    const cut = layer.type === 'cutout' && asset.cut;
    src = cut ? asset.cut : asset.img;
    iw = cut ? asset.cutW : asset.w;
    ih = cut ? asset.cutH : asset.h;
    focus = asset.focus || focus;
  }
  if (!src || !iw) return;
  const isCut = layer.type === 'cutout' && asset?.cut;
  const isLogo = layer.type === 'logo';
  const fit = layer.fit || (isCut || isLogo ? 'contain' : 'cover');
  const r = fitRect(iw, ih, b.w, b.h, fit, layer.focus || focus);

  // Slow camera drift inside the frame (Ken Burns), for photos and video.
  let kb = 1, kbx = 0, kby = 0;
  if (layer.kenburns && !isCut && !isLogo) {
    const p = clamp(lt / Math.max(0.1, sceneDur), 0, 1);
    const e = EASE.inOutQuad(p);
    kb = lerp(layer.kenburns.from ?? 1.0, layer.kenburns.to ?? 1.12, e);
    kbx = lerp(layer.kenburns.x0 ?? 0, layer.kenburns.x1 ?? 0, e) * b.w;
    kby = lerp(layer.kenburns.y0 ?? 0, layer.kenburns.y1 ?? 0, e) * b.h;
  }

  ctx.save();
  ctx.translate(b.cx, b.cy);
  const radius = (layer.radius ?? 0) * m;

  if (isCut) {
    const dx = r.x, dy = r.y;
    // Contact shadow on the "floor" under the product.
    if (layer.shadow !== 'none') {
      const sy = dy + r.h * 0.985;
      ctx.save();
      ctx.translate(0, sy);
      ctx.scale(1, 0.16);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r.w * 0.55);
      g.addColorStop(0, `rgba(0,0,0,${env.palette.dark ? 0.6 : 0.35})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-r.w * 0.6, -r.w * 0.6, r.w * 1.2, r.w * 1.2);
      ctx.restore();
      ctx.shadowColor = `rgba(0,0,0,${env.palette.dark ? 0.5 : 0.28})`;
      ctx.shadowBlur = m * 0.04;
      ctx.shadowOffsetY = m * 0.02;
    }
    if (layer.reflection) {
      ctx.save();
      ctx.globalAlpha *= 0.18;
      ctx.translate(0, dy * 2 + r.h * 2);
      ctx.scale(1, -1);
      ctx.drawImage(src, dx, dy, r.w, r.h);
      ctx.restore();
    }
    ctx.drawImage(src, dx, dy, r.w, r.h);
    ctx.shadowColor = 'transparent';
    if (layer.sweep) drawSweepOn(ctx, src, { x: dx, y: dy, w: r.w, h: r.h }, lt, layer.sweep, env);
  } else {
    if (layer.shadow) {
      ctx.shadowColor = `rgba(0,0,0,${layer.shadow === 'soft' ? 0.3 : 0.5})`;
      ctx.shadowBlur = m * 0.05;
      ctx.shadowOffsetY = m * 0.02;
      ctx.fillStyle = '#000';
      roundRect(ctx, -b.w / 2, -b.h / 2, b.w, b.h, radius);
      ctx.fill();
      ctx.shadowColor = 'transparent';
    }
    if (isLogo && layer.plate) {
      const pc = color(env, layer.plate, 'surface');
      const pw = r.w + m * 0.06, ph = r.h + m * 0.05;
      ctx.fillStyle = pc;
      roundRect(ctx, -pw / 2, -ph / 2, pw, ph, m * 0.03);
      ctx.fill();
    }
    ctx.save();
    if (fit === 'cover' || radius) {
      roundRect(ctx, -b.w / 2, -b.h / 2, b.w, b.h, radius);
      ctx.clip();
    }
    ctx.scale(kb, kb);
    ctx.translate(kbx / kb, kby / kb);
    ctx.drawImage(src, r.x, r.y, r.w, r.h);
    if (layer.tint) {
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = rgba(color(env, layer.tint.color, 'bg'), layer.tint.amount ?? 0.3);
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
    if (layer.scrim) {
      // Darken the bottom (or top) so text on the photo stays readable.
      const g = ctx.createLinearGradient(0, -b.h / 2, 0, b.h / 2);
      const s = layer.scrim;
      g.addColorStop(0, `rgba(0,0,0,${s.top ?? 0.25})`);
      g.addColorStop(0.45, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${s.bottom ?? 0.65})`);
      ctx.fillStyle = g;
      roundRect(ctx, -b.w / 2, -b.h / 2, b.w, b.h, radius);
      ctx.fill();
    }
    if (layer.border) {
      ctx.strokeStyle = color(env, layer.border.color, 'surface');
      ctx.lineWidth = (layer.border.width ?? 0.01) * m;
      roundRect(ctx, -b.w / 2, -b.h / 2, b.w, b.h, radius);
      ctx.stroke();
    }
    if (layer.sweep && !isLogo) {
      ctx.save();
      roundRect(ctx, -b.w / 2, -b.h / 2, b.w, b.h, radius);
      ctx.clip();
      const p = sweepProgress(lt, layer.sweep);
      if (p !== null) drawSweep(ctx, { x: -b.w / 2, y: -b.h / 2, w: b.w, h: b.h }, p, '#ffffff', layer.sweep.strength ?? 0.35);
      ctx.restore();
    }
    if (isLogo && layer.sweep) drawSweepOn(ctx, src, { x: r.x, y: r.y, w: r.w, h: r.h }, lt, layer.sweep, env);
  }
  ctx.restore();
}

function sweepProgress(lt, sweep) {
  const at = sweep.at ?? 0.6;
  const dur = sweep.dur ?? 0.9;
  const every = sweep.every;
  let t = lt - at;
  if (every && t > 0) t %= every;
  if (t < 0 || t > dur) return null;
  return EASE.inOutQuad(t / dur);
}

/** Light sweep masked to the image's own alpha (shine across a product or logo). */
function drawSweepOn(ctx, src, rect, lt, sweep, env) {
  const p = sweepProgress(lt, sweep);
  if (p === null || !env.makeCanvas) return;
  const w = Math.ceil(rect.w), h = Math.ceil(rect.h);
  if (w < 2 || h < 2) return;
  const c = env.scratch(w, h);
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);
  drawSweep(g, { x: 0, y: 0, w, h }, p, '#ffffff', sweep.strength ?? 0.6);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(src, 0, 0, w, h);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(c, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

// --- text -----------------------------------------------------------------------

function drawText(ctx, layer, lt, env, st) {
  const { W, m } = env;
  const role = env.fonts[layer.role || 'display'] || env.fonts.display;
  const size = (layer.size || 0.08) * m * (role.scale || 1);
  const maxW = (layer.maxW ?? 0.84) * W;
  const tracking = layer.tracking ?? role.tracking ?? 0;
  const lay = layoutText(ctx, {
    text: layer.text, font: role, size, maxW, maxLines: layer.lines || 3, caseMode: layer.case || role.case, tracking,
    lineHeight: layer.lineHeight || role.lineHeight || 1.06, minSize: size * 0.4, align: layer.align || 'center',
  });
  if (!lay.words.length) return;
  const b = boxOf(layer, env);
  const fg = color(env, layer.color, 'text');
  const emColor = color(env, layer.emColor || 'accent', 'accent');
  const anchorY = layer.anchor === 'top' ? 0 : layer.anchor === 'bottom' ? -lay.height : -lay.height / 2;
  const originX = layer.align === 'left' ? b.cx - b.w / 2 : layer.align === 'right' ? b.cx + b.w / 2 : b.cx;
  const originY = b.cy + anchorY;
  ctx.font = fontString(role, lay.size);
  ctx.textBaseline = 'top';

  // Background box behind the whole block or each line.
  if (layer.box) {
    const bc = color(env, layer.box.color, 'accent');
    const pad = (layer.box.pad ?? 0.025) * m;
    const rad = (layer.box.radius ?? env.radius ?? 0.015) * m;
    const reveal = layer.box.reveal ? clamp((lt - (layer.in?.at || 0)) / 0.45, 0, 1) : 1;
    ctx.fillStyle = bc;
    if (layer.box.perLine) {
      lay.lines.forEach((line, li) => {
        const lx = layer.align === 'left' ? originX : layer.align === 'right' ? originX - line.width : originX - line.width / 2;
        roundRect(ctx, lx - pad, originY + li * lay.lineHeight - pad * 0.45, (line.width + pad * 2) * EASE.outExpo(reveal), lay.lineHeight + pad * 0.5, rad);
        ctx.fill();
      });
    } else {
      const bw = lay.width + pad * 2, bh = lay.height + pad * 1.2;
      const bx = layer.align === 'left' ? originX - pad : layer.align === 'right' ? originX - lay.width - pad : originX - bw / 2;
      roundRect(ctx, bx, originY - pad * 0.6, bw * EASE.outExpo(reveal), bh, rad);
      ctx.fill();
    }
  }

  if (layer.glow) {
    ctx.shadowColor = color(env, layer.glow === true ? 'accent' : layer.glow);
    ctx.shadowBlur = lay.size * 0.35;
  } else if (layer.shadow !== false && (layer.onPhoto || layer.shadow)) {
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = lay.size * 0.2;
    ctx.shadowOffsetY = lay.size * 0.04;
  }

  const anim = layer.textAnim || 'words';
  const at = layer.textAt ?? layer.in?.at ?? 0;
  const stagger = (layer.stagger ?? 0.075) / (env.motionSpeed || 1);
  const total = lay.words.length;
  const chars = lay.words.reduce((s, w) => s + w.text.length, 0);
  let charIndex = 0;
  for (const w of lay.words) {
    let p = 1;
    let dx = 0, dy = 0, sc = 1, alpha = 1, blur = 0, shown = w.text;
    const local = lt - at;
    if (anim === 'words' || anim === 'pop' || anim === 'blurWords' || anim === 'slideWords') {
      p = clamp((local - w.index * stagger) / 0.42, 0, 1);
      const e = anim === 'pop' ? EASE.outBack(p) : EASE.glide(p);
      alpha = clamp(p * 2, 0, 1);
      if (anim === 'words') dy = (1 - e) * lay.size * 0.55;
      if (anim === 'pop') sc = 0.3 + 0.7 * e;
      if (anim === 'blurWords') { blur = (1 - p) * lay.size * 0.25; sc = 1.15 - 0.15 * e; }
      if (anim === 'slideWords') dx = (1 - e) * lay.size * 1.2;
    } else if (anim === 'lines') {
      p = clamp((local - w.line * stagger * 2.2) / 0.5, 0, 1);
      dy = (1 - EASE.outExpo(p)) * lay.lineHeight;
      alpha = p > 0 ? 1 : 0;
    } else if (anim === 'chars' || anim === 'typewriter') {
      const n = Math.floor(clamp(local / Math.max(0.3, 0.035 * chars), 0, 1) * chars) - charIndex;
      shown = w.text.slice(0, Math.max(0, n));
      charIndex += w.text.length;
      if (!shown) continue;
    } else if (anim === 'none' || anim === 'block') {
      // The layer's own entrance animates the whole block.
    }
    if (alpha <= 0) continue;
    const x = originX + w.x + dx;
    const y = originY + w.y + dy;
    ctx.save();
    ctx.globalAlpha *= alpha;
    if (blur > 0.3) ctx.filter = `blur(${blur.toFixed(1)}px)`;
    if (sc !== 1) {
      ctx.translate(x + w.w / 2, y + lay.size / 2);
      ctx.scale(sc, sc);
      ctx.translate(-(x + w.w / 2), -(y + lay.size / 2));
    }
    const isEm = w.em;
    if (isEm && (layer.emStyle || env.emStyle) === 'box') {
      ctx.save();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = emColor;
      const pad = lay.size * 0.12;
      roundRect(ctx, x - pad, y - pad * 0.3, (w.w + pad * 2) * clamp(p * 1.4, 0, 1), lay.size * 1.05, lay.size * 0.12);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = readableOn(emColor);
    } else {
      ctx.fillStyle = isEm ? emColor : fg;
    }
    if (layer.outline) {
      ctx.strokeStyle = color(env, layer.outline, 'text');
      ctx.lineWidth = lay.size * 0.035;
      drawWord(ctx, shown, x, y, lay.size, tracking, true);
    } else {
      drawWord(ctx, shown, x, y, lay.size, tracking);
    }
    if (isEm && (layer.emStyle || env.emStyle) === 'underline') {
      const u = clamp((local - w.index * stagger - 0.25) / 0.4, 0, 1);
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = emColor;
      ctx.fillRect(x, y + lay.size * 1.0, w.w * EASE.outExpo(u), Math.max(2, lay.size * 0.07));
    }
    ctx.restore();
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  if (layer.underline) {
    const u = clamp((lt - at - total * stagger * 0.6) / 0.5, 0, 1);
    const lw = Math.min(lay.width, (layer.underline.w ?? 0.28) * W);
    ctx.fillStyle = color(env, layer.underline.color, 'accent');
    const ux = layer.align === 'left' ? originX : originX - lw / 2;
    roundRect(ctx, ux, originY + lay.height + m * 0.025, lw * EASE.outExpo(u), Math.max(3, m * 0.008), m * 0.004);
    ctx.fill();
  }
}

// --- shapes, light, buttons, stars, compare ---------------------------------------

function drawShape(ctx, layer, lt, env) {
  const { m } = env;
  const b = boxOf(layer, env);
  const fill = layer.fill ? color(env, layer.fill, 'accent') : null;
  const stroke = layer.stroke ? color(env, layer.stroke, 'accent') : null;
  const lw = (layer.lw ?? 0.006) * m;
  const draw = layer.draw ? clamp((lt - (layer.draw.at ?? 0)) / (layer.draw.dur ?? 0.7), 0, 1) : 1;
  const de = EASE.inOutCubic(draw);
  ctx.save();
  if (layer.glow) {
    ctx.shadowColor = fill || stroke;
    ctx.shadowBlur = m * 0.04;
  }
  switch (layer.shape) {
    case 'circle':
    case 'ring': {
      const r = Math.min(b.w, b.h) / 2;
      ctx.beginPath();
      ctx.arc(b.cx, b.cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * de);
      if (fill && layer.shape === 'circle') { ctx.lineTo(b.cx, b.cy); ctx.fillStyle = fill; ctx.fill(); }
      if (stroke || layer.shape === 'ring') { ctx.strokeStyle = stroke || fill; ctx.lineWidth = lw; ctx.stroke(); }
      break;
    }
    case 'line': {
      ctx.strokeStyle = stroke || fill;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(b.cx - b.w / 2, b.cy);
      ctx.lineTo(b.cx - b.w / 2 + b.w * de, b.cy);
      ctx.stroke();
      break;
    }
    case 'burst': {
      burstPath(ctx, b.cx, b.cy, Math.min(b.w, b.h) / 2 * (0.2 + 0.8 * de), layer.points || 18, 0.86, lt * 0.3);
      ctx.fillStyle = fill || stroke;
      ctx.fill();
      break;
    }
    case 'blob': {
      blobPath(ctx, b.cx, b.cy, Math.min(b.w, b.h) / 2, lt, layer.seed || 1, layer.wobble ?? 0.18);
      ctx.fillStyle = fill || stroke;
      ctx.fill();
      break;
    }
    case 'frame': {
      // Corner brackets (editorial / cinematic framing).
      const L = Math.min(b.w, b.h) * 0.18 * de;
      ctx.strokeStyle = stroke || fill;
      ctx.lineWidth = lw;
      const x0 = b.cx - b.w / 2, y0 = b.cy - b.h / 2, x1 = b.cx + b.w / 2, y1 = b.cy + b.h / 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0 + L); ctx.lineTo(x0, y0); ctx.lineTo(x0 + L, y0);
      ctx.moveTo(x1 - L, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + L);
      ctx.moveTo(x1, y1 - L); ctx.lineTo(x1, y1); ctx.lineTo(x1 - L, y1);
      ctx.moveTo(x0 + L, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - L);
      ctx.stroke();
      break;
    }
    case 'rect':
    default: {
      const rad = (layer.radius ?? 0) * m;
      roundRect(ctx, b.cx - b.w / 2, b.cy - b.h / 2, b.w * (layer.draw ? de : 1), b.h, rad);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
      break;
    }
  }
  ctx.restore();
}

function drawLight(ctx, layer, lt, sceneDur, env) {
  const { W, H, m } = env;
  const c = color(env, layer.color || '#ffffff', 'text');
  switch (layer.kind) {
    case 'leak': return drawLightLeak(ctx, W, H, lt + (layer.seed || 0), c, layer.strength ?? 0.3, layer.seed || 3);
    case 'glow': return drawGlow(ctx, (layer.x ?? 0.5) * W, (layer.y ?? 0.5) * H, (layer.r ?? 0.5) * m, c, (layer.strength ?? 0.5) * (layer.pulse ? 0.75 + 0.25 * (env.pulse || 0) : 1));
    case 'rays': return drawRays(ctx, (layer.x ?? 0.5) * W, (layer.y ?? 0.5) * H, (layer.r ?? 0.9) * m, lt, c, layer.count || 14, layer.strength ?? 0.16);
    case 'sweep': {
      const p = sweepProgress(lt, layer);
      if (p !== null) drawSweep(ctx, { x: 0, y: 0, w: W, h: H }, p, c, layer.strength ?? 0.25);
      return undefined;
    }
    default: return undefined;
  }
}

function drawButton(ctx, layer, lt, env) {
  const { m } = env;
  const b = boxOf(layer, env);
  const role = env.fonts[layer.role || 'body'] || env.fonts.body;
  const size = (layer.size || 0.045) * m;
  const label = layer.case === 'none' ? layer.text : (role.case === 'upper' || layer.case === 'upper') ? String(layer.text).toUpperCase() : layer.text;
  ctx.font = fontString({ ...role, weight: role.boldWeight || role.weight }, size);
  const tw = ctx.measureText(label).width;
  const arrow = layer.arrow !== false;
  const w = tw + size * (arrow ? 3.2 : 2.2);
  const h = size * 2.3;
  const bg = color(env, layer.color || 'accent', 'accent');
  const fg = layer.textColor ? color(env, layer.textColor) : readableOn(bg);
  const pulse = 1 + 0.035 * (env.pulse || 0);
  ctx.save();
  ctx.translate(b.cx, b.cy);
  ctx.scale(pulse, pulse);
  ctx.shadowColor = rgba(bg, 0.45);
  ctx.shadowBlur = m * 0.04;
  ctx.shadowOffsetY = m * 0.012;
  ctx.fillStyle = bg;
  roundRect(ctx, -w / 2, -h / 2, w, h, layer.pill === false ? (env.radius ?? 0.015) * m : h / 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const x0 = -w / 2 + size * 1.1;
  ctx.fillText(label, x0, size * 0.04);
  if (arrow) drawIcon(ctx, 'arrow', x0 + tw + size * 0.95, 0, size * 0.9, fg, 2.6);
  // Occasional shine across the button.
  const p = sweepProgress(lt, { at: 0.9, dur: 0.8, every: 2.4 });
  if (p !== null) {
    roundRect(ctx, -w / 2, -h / 2, w, h, h / 2);
    ctx.clip();
    drawSweep(ctx, { x: -w / 2, y: -h / 2, w, h }, p, '#ffffff', 0.45);
  }
  ctx.restore();
  ctx.textAlign = 'start';
}

function drawStars(ctx, layer, lt, env) {
  const { m } = env;
  const b = boxOf(layer, env);
  const n = layer.count || 5;
  const r = (layer.size || 0.035) * m;
  const gap = r * 2.5;
  const c = color(env, layer.color || 'accent', 'accent');
  for (let i = 0; i < n; i++) {
    const k = EASE.outBack(clamp((lt - (layer.in?.at || 0) - i * 0.09) / 0.35, 0, 1));
    if (k <= 0) continue;
    ctx.save();
    ctx.translate(b.cx + (i - (n - 1) / 2) * gap, b.cy);
    ctx.scale(k, k);
    ctx.fillStyle = c;
    starPath(ctx, 0, 0, r);
    ctx.fill();
    ctx.restore();
  }
}

function drawCompare(ctx, layer, lt, sceneDur, env) {
  const { m } = env;
  const b = boxOf(layer, env);
  const A = env.assets[layer.a], B = env.assets[layer.b];
  if (!A?.img || !B?.img) return;
  const p = sampleTrack(layer.split || [[0, 1], [0.4, 1], [1.6, 0.5, 'inOutCubic']], lt, 0.5);
  const radius = (layer.radius ?? 0.02) * m;
  ctx.save();
  roundRect(ctx, b.cx - b.w / 2, b.cy - b.h / 2, b.w, b.h, radius);
  ctx.clip();
  const ra = fitRect(A.w, A.h, b.w, b.h, 'cover', A.focus);
  const rb = fitRect(B.w, B.h, b.w, b.h, 'cover', B.focus);
  ctx.drawImage(B.img, b.cx + rb.x, b.cy + rb.y, rb.w, rb.h);
  const sx = b.cx - b.w / 2 + b.w * p;
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.cx - b.w / 2, b.cy - b.h / 2, b.w * p, b.h);
  ctx.clip();
  ctx.drawImage(A.img, b.cx + ra.x, b.cy + ra.y, ra.w, ra.h);
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(sx - m * 0.003, b.cy - b.h / 2, m * 0.006, b.h);
  ctx.beginPath();
  ctx.arc(sx, b.cy, m * 0.03, 0, Math.PI * 2);
  ctx.fill();
  drawIcon(ctx, 'arrow', sx + m * 0.008, b.cy, m * 0.022, '#111111', 2.6);
  ctx.restore();
  const label = (text, x, align) => {
    if (!text) return;
    const role = env.fonts.body;
    const size = m * 0.03;
    ctx.font = fontString({ ...role, weight: role.boldWeight || role.weight }, size);
    const tw = ctx.measureText(text.toUpperCase()).width;
    const bx = align === 'left' ? x : x - tw - size;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(ctx, bx, b.cy - b.h / 2 + size, tw + size, size * 1.6, size * 0.3);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text.toUpperCase(), bx + size / 2, b.cy - b.h / 2 + size * 1.8);
  };
  label(layer.labelA, b.cx - b.w / 2 + m * 0.02, 'left');
  label(layer.labelB, b.cx + b.w / 2 - m * 0.02, 'right');
}

// ---------------------------------------------------------------------------
// Scenes, transitions and finishing
// ---------------------------------------------------------------------------

function cameraAt(scene, lt) {
  const c = scene.camera || {};
  return {
    zoom: sampleTrack(c.zoom, lt, 1),
    x: sampleTrack(c.x, lt, 0),
    y: sampleTrack(c.y, lt, 0),
    rot: sampleTrack(c.rot, lt, 0),
  };
}

function drawScene(ctx, scene, lt, env) {
  env.cam = cameraAt(scene, lt);
  for (const layer of scene.layers) drawLayer(ctx, layer, lt, scene.duration, env);
  env.cam = null;
}

function buffer(env, key) {
  env._buf = env._buf || {};
  if (!env._buf[key]) env._buf[key] = env.makeCanvas(env.W, env.H);
  return env._buf[key];
}

function transitionComposite(ctx, A, B, type, p, env, dir = 1) {
  const { W, H, m } = env;
  const e = EASE.inOutCubic(p);
  ctx.save();
  switch (type) {
    case 'push':
    case 'slide': {
      ctx.drawImage(A, -e * W * dir, 0);
      ctx.drawImage(B, (1 - e) * W * dir, 0);
      break;
    }
    case 'pushUp': {
      ctx.drawImage(A, 0, -e * H);
      ctx.drawImage(B, 0, (1 - e) * H);
      break;
    }
    case 'whip': {
      // Fast push with heavy horizontal motion blur in the middle.
      const k = EASE.inOutExpo(p);
      const blur = Math.sin(Math.PI * p) * m * 0.06;
      ctx.filter = blur > 0.5 ? `blur(${blur.toFixed(1)}px)` : 'none';
      ctx.drawImage(A, -k * W * dir, 0);
      ctx.drawImage(B, (1 - k) * W * dir, 0);
      break;
    }
    case 'zoom': {
      // Fly through the outgoing scene into the next.
      const k = EASE.inExpo(Math.min(1, p * 1.25));
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(1 + k * 1.5, 1 + k * 1.5);
      ctx.globalAlpha = 1 - EASE.inQuad(p);
      ctx.filter = `blur(${(k * m * 0.03).toFixed(1)}px)`;
      ctx.drawImage(A, -W / 2, -H / 2);
      ctx.restore();
      ctx.save();
      ctx.translate(W / 2, H / 2);
      const s = 0.7 + 0.3 * EASE.outExpo(p);
      ctx.scale(s, s);
      ctx.globalAlpha = EASE.outQuad(p);
      ctx.drawImage(B, -W / 2, -H / 2);
      ctx.restore();
      break;
    }
    case 'iris': {
      ctx.drawImage(A, 0, 0);
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, Math.hypot(W, H) / 2 * EASE.inOutCubic(p), 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(B, 0, 0);
      break;
    }
    case 'wipe': {
      ctx.drawImage(A, 0, 0);
      ctx.beginPath();
      const x = dir > 0 ? 0 : W * (1 - e);
      ctx.rect(x, 0, W * e, H);
      ctx.clip();
      ctx.drawImage(B, 0, 0);
      break;
    }
    case 'brand': {
      // An accent-coloured panel sweeps across, covering then revealing.
      const c1 = env.palette.accent, c2 = env.palette.primary;
      ctx.drawImage(p < 0.5 ? A : B, 0, 0);
      const k1 = EASE.inOutCubic(clamp(p * 1.6, 0, 1));
      const k2 = EASE.inOutCubic(clamp(p * 1.6 - 0.6, 0, 1));
      ctx.fillStyle = c2;
      ctx.fillRect(W * (k2 * 1.0) - W * 0.0, 0, W * (k1 - k2), H);
      ctx.fillStyle = c1;
      ctx.fillRect(W * (k2 * 1.0) + W * 0.06 * (k1 - k2), 0, W * Math.max(0, (k1 - k2) - 0.12), H);
      break;
    }
    case 'flash': {
      ctx.drawImage(p < 0.5 ? A : B, 0, 0);
      ctx.globalAlpha = 1 - Math.abs(p - 0.5) * 2;
      ctx.fillStyle = env.flashColor || '#ffffff';
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'blur': {
      const k = Math.sin(Math.PI * p);
      ctx.filter = `blur(${(k * m * 0.04).toFixed(1)}px)`;
      ctx.globalAlpha = 1;
      ctx.drawImage(A, 0, 0);
      ctx.globalAlpha = e;
      ctx.drawImage(B, 0, 0);
      break;
    }
    case 'split': {
      ctx.drawImage(B, 0, 0);
      const k = EASE.inOutExpo(p);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H / 2);
      ctx.clip();
      ctx.drawImage(A, -k * W, 0);
      ctx.restore();
      ctx.beginPath();
      ctx.rect(0, H / 2, W, H / 2);
      ctx.clip();
      ctx.drawImage(A, k * W, 0);
      break;
    }
    case 'cut':
      ctx.drawImage(B, 0, 0);
      break;
    case 'fade':
    case 'dissolve':
    default:
      ctx.drawImage(A, 0, 0);
      ctx.globalAlpha = e;
      ctx.drawImage(B, 0, 0);
      break;
  }
  ctx.restore();
}

/** Scene index and local time at composition time t. */
export function sceneAt(comp, t) {
  let i = comp.scenes.findIndex((s) => t < s.start + s.duration);
  if (i < 0) i = comp.scenes.length - 1;
  return { i, lt: t - comp.scenes[i].start };
}

/**
 * Render composition `comp` at time t into ctx.
 * env = { makeCanvas(w,h), assets: { id: { img, w, h, cut?, cutW, cutH, focus } }, video?(id, t, layer) }
 */
export function renderFrame(ctx, comp, t, env) {
  const W = comp.width, H = comp.height;
  Object.assign(env, {
    W, H, m: Math.min(W, H), fps: comp.fps || 30,
    palette: comp.palette, fonts: comp.fonts,
    motionSpeed: comp.motion?.speed || 1, ease: comp.motion?.ease || 'outCubic',
    motionBlur: comp.motion?.blur !== false, radius: comp.shape?.radius ?? 0.015,
    emStyle: comp.emStyle || 'color', flashColor: comp.palette.flash,
  });
  if (!env.scratch) {
    env._scratch = {};
    env.scratch = (w, h) => {
      const k = `${w}x${h}`;
      if (!env._scratch[k]) env._scratch[k] = env.makeCanvas(w, h);
      return env._scratch[k];
    };
  }
  const beat = comp.beat || 0;
  env.pulse = beat ? Math.exp(-((((t - (comp.beatOffset || 0)) % beat) + beat) % beat) / beat * 6) : 0;

  const { i, lt } = sceneAt(comp, t);
  const scene = comp.scenes[i];
  const main = buffer(env, 'main');
  const mctx = main.getContext('2d');
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.globalAlpha = 1;
  mctx.globalCompositeOperation = 'source-over';
  mctx.filter = 'none';
  mctx.clearRect(0, 0, W, H);

  const tr = scene.transition;
  const trDur = tr && tr.type !== 'cut' && i > 0 ? Math.min(tr.duration || 0.5, scene.duration * 0.5) : 0;
  if (trDur && lt < trDur) {
    const prev = comp.scenes[i - 1];
    const A = buffer(env, 'a'), B = buffer(env, 'b');
    const actx = A.getContext('2d'), bctx = B.getContext('2d');
    actx.setTransform(1, 0, 0, 1, 0, 0); actx.clearRect(0, 0, W, H);
    bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.clearRect(0, 0, W, H);
    drawScene(actx, prev, prev.duration + lt, env);
    drawScene(bctx, scene, lt, env);
    transitionComposite(mctx, A, B, tr.type, lt / trDur, env, tr.dir || 1);
  } else {
    drawScene(mctx, scene, lt, env);
  }

  // Finishing.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  ctx.filter = comp.grade?.filter || 'none';
  ctx.drawImage(main, 0, 0);
  ctx.filter = 'none';
  if (comp.overlays) {
    env.cam = null;
    for (const layer of comp.overlays) drawLayer(ctx, layer, t, comp.duration, env);
  }
  if (comp.grade?.leak) drawLightLeak(ctx, W, H, t, comp.grade.leak.color || comp.palette.accent, comp.grade.leak.strength ?? 0.15, 5);
  drawVignette(ctx, W, H, comp.grade?.vignette ?? 0.25);
  if (comp.grade?.grain) {
    if (!env.grain) env.grain = makeGrainTile(env.makeCanvas);
    drawGrain(ctx, env.grain, W, H, Math.round(t * (comp.fps || 30)), comp.grade.grain);
  }
  if (comp.grade?.letterbox) {
    const bh = H * comp.grade.letterbox;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, bh);
    ctx.fillRect(0, H - bh, W, bh);
  }
  // Fade from black at the very start, to black at the very end if asked.
  if (comp.fadeIn && t < comp.fadeIn) {
    ctx.globalAlpha = 1 - t / comp.fadeIn;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

/** Positions (pixel boxes) where text was laid out at time t: used by QA safe-zone checks. */
export function textBoxes(comp, t, measureCtx) {
  const { i, lt } = sceneAt(comp, t);
  const scene = comp.scenes[i];
  const W = comp.width, H = comp.height, m = Math.min(W, H);
  const out = [];
  for (const layer of scene.layers) {
    if (layer.type !== 'text' && layer.type !== 'button') continue;
    if (layer.start !== undefined && lt < layer.start) continue;
    const role = comp.fonts[layer.role || (layer.type === 'button' ? 'body' : 'display')] || comp.fonts.display;
    const cx = (layer.x ?? 0.5) * W, cy = (layer.y ?? 0.5) * H;
    if (layer.type === 'button') {
      const size = (layer.size || 0.045) * m;
      measureCtx.font = fontString(role, size);
      const w = measureCtx.measureText(layer.text).width + size * 3.2;
      out.push({ id: layer.id, x: cx - w / 2, y: cy - size * 1.15, w, h: size * 2.3, text: layer.text, layer });
      continue;
    }
    const size = (layer.size || 0.08) * m * (role.scale || 1);
    const lay = layoutText(measureCtx, { text: layer.text, font: role, size, maxW: (layer.maxW ?? 0.84) * W, maxLines: layer.lines || 3, caseMode: layer.case || role.case, tracking: layer.tracking ?? role.tracking ?? 0, lineHeight: layer.lineHeight || role.lineHeight || 1.06, minSize: size * 0.4, align: layer.align || 'center' });
    if (!lay.words.length) continue;
    const anchorY = layer.anchor === 'top' ? 0 : layer.anchor === 'bottom' ? -lay.height : -lay.height / 2;
    const bw = (layer.w ?? 1) * W;
    const x = layer.align === 'left' ? cx - bw / 2 : layer.align === 'right' ? cx + bw / 2 - lay.width : cx - lay.width / 2;
    out.push({ id: layer.id, x, y: cy + anchorY, w: lay.width, h: lay.height, size: lay.size, text: layer.text, layer });
  }
  return out;
}

export { contrast };
