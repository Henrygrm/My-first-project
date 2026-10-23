import { TRANSITIONS } from './styles.js';

/**
 * Work out where everything lands in the finished clip. Transitions overlap
 * neighbouring shots, so a clip is shorter than the sum of its shots.
 *
 * For each segment:
 *   dur       playback length of the shot (source length / speed)
 *   play      output time the shot starts (including the transition into it)
 *   offset    output time the transition into the next shot starts
 *   trans     [xfade name, duration] of the transition into the next shot
 *   visStart / visEnd   when the shot is "the" shot on screen (cut midpoints),
 *                       used to time captions
 */
export function computeTimeline(segments) {
  const items = segments.map((s) => ({ ...s, dur: (s.end - s.start) / (s.speed || 1) }));
  items.forEach((it, k) => {
    const next = items[k + 1];
    if (!next) {
      it.trans = null;
      return;
    }
    const [xf, want] = TRANSITIONS[it.transition] || TRANSITIONS.cut;
    // Never let a transition eat more than 40% of either shot.
    it.trans = [xf, Math.max(1 / 30, Math.min(want, it.dur * 0.4, next.dur * 0.4))];
  });

  let play = 0;
  items.forEach((it, k) => {
    it.play = play;
    const d = it.trans ? it.trans[1] : 0;
    it.offset = play + it.dur - d;
    play = it.offset;
    const prevD = k ? items[k - 1].trans[1] : 0;
    it.visStart = it.play + prevD / 2;
    it.visEnd = it.offset + d / 2;
  });
  const last = items.at(-1);
  const total = last ? last.play + last.dur : 0;
  if (last) last.visEnd = total;
  return { items, total };
}

export function clipDuration(clip) {
  return computeTimeline(clip.segments).total;
}
