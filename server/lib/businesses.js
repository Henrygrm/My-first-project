// Business-type profiles. These drive the AI editing brief, the no-AI
// auto-edit heuristics, and the marketing prompts, so every part of the app
// adapts to the selected industry from one place.

export const BUSINESSES = {
  restaurant: {
    id: 'restaurant',
    label: 'Restaurant & café',
    short: 'Food',
    tagline: 'Sizzle, plating, the money shot.',
    priorities: [
      'cooking action: flames, sizzling pans, steam, sauces being poured',
      'food preparation close-ups: chopping, kneading, assembling',
      'plating and garnish moments',
      'the finished dish (the "money shot") and first bite / cheese pull',
      'busy atmosphere: full tables, staff energy, coffee being poured',
    ],
    avoid: ['empty dining rooms', 'blurry walk-throughs', 'dark or greasy-looking shots', 'long static shots of menus'],
    pacing: 'Fast. 1–2.5 second cuts that follow the rhythm of the cooking, slowing slightly on the final dish.',
    structure: 'Hook with the most appetising shot (finished dish or sizzle) → quick prep sequence → plating → hero shot of the finished dish → CTA.',
    segment: { min: 1.2, max: 2.6 },
    hookFirstFrom: 'end', // flash-forward to the finished dish
    hooks: ['Watch this come together', 'Made fresh, every single order', 'This is why people queue up', 'From the pan to your plate'],
    captions: ['Fresh prep', 'Into the pan', 'Plated with care', 'The finished dish'],
    cta: 'Book a table today',
    hashtagSeeds: ['foodie', 'foodtok', 'restaurant', 'cafe', 'eatlocal'],
  },
  detailing: {
    id: 'detailing',
    label: 'Car detailing',
    short: 'Detail',
    tagline: 'Foam, polish, before & after.',
    priorities: [
      'clear BEFORE shots that show dirt, swirls or stains',
      'satisfying cleaning footage: snow foam, pressure washing, extraction',
      'polishing and paint correction passes, 50/50 paint comparisons',
      'interior transformations: seats, carpets, steering wheel',
      'glossy AFTER reveal shots: reflections, water beading, slow walk-around',
    ],
    avoid: ['shots with no visible change', 'shaky footage of the car parked', 'long setup or packing equipment'],
    pacing: 'Medium. 2–4 second cuts that let the satisfying moments breathe; save the cleanest reveal for the end.',
    structure: 'Hook with the dirtiest "before" or a 50/50 split → satisfying cleaning sequence → polishing → glossy reveal → CTA.',
    segment: { min: 1.8, max: 3.8 },
    hookFirstFrom: 'start', // open on the dirty "before" shot
    hooks: ['Wait for the reveal', 'This car had not been cleaned in years', 'Most satisfying clean of the week', 'Before vs after'],
    captions: ['The before', 'Snow foam time', 'Paint correction', 'The reveal'],
    cta: 'Book your detail today',
    hashtagSeeds: ['cardetailing', 'detailing', 'carcare', 'satisfying', 'beforeandafter'],
  },
  trades: {
    id: 'trades',
    label: 'Trades (plumber, sparky, builder)',
    short: 'Trades',
    tagline: 'Work in progress to finished result.',
    priorities: [
      'the problem at the start: leaks, old wiring, damaged surfaces, empty site',
      'skilled work in progress and tool use (cutting, welding, fitting, wiring)',
      'progress milestones of the project',
      'the clean, finished result and before/after comparisons',
      'the tradie explaining something to camera (trust-building)',
    ],
    avoid: ['walking between rooms', 'long pauses', 'messy sites without context', 'shots where nothing happens'],
    pacing: 'Medium. 2–3.5 second cuts, with speed-ups on repetitive work to compress hours into seconds.',
    structure: 'Hook with the problem or the finished result → work-in-progress montage → key skilled moment → finished result → CTA.',
    segment: { min: 1.8, max: 3.5 },
    hookFirstFrom: 'end',
    hooks: ['Here is what we found', 'Start to finish in 30 seconds', 'This is how it should be done', 'Day one vs the final result'],
    captions: ['The problem', 'Getting to work', 'Done properly', 'The finished job'],
    cta: 'Get a free quote',
    hashtagSeeds: ['tradie', 'construction', 'plumbing', 'electrician', 'renovation'],
  },
  barber: {
    id: 'barber',
    label: 'Barber & hair salon',
    short: 'Hair',
    tagline: 'Fades, transformations, the mirror moment.',
    priorities: [
      'the "before" look, clearly lit',
      'clipper and scissor work close-ups, fade blending, line-ups',
      'colour application and styling',
      'the transformation reveal and the client reacting in the mirror',
      'slow 360 of the finished cut',
    ],
    avoid: ['sweeping hair off the floor', 'payment and chat', 'unflattering angles of the client'],
    pacing: 'Fast-to-medium. 1.5–3 second cuts timed to clipper passes; hold on the final reveal.',
    structure: 'Hook with the transformation or the sharpest fade → cutting montage → detail work → reveal + reaction → CTA.',
    segment: { min: 1.4, max: 3.0 },
    hookFirstFrom: 'end',
    hooks: ['Fresh cut transformation', 'Watch this fade come to life', 'He did not recognise himself', 'Before and after the chair'],
    captions: ['The before', 'Blending the fade', 'Detail work', 'Fresh'],
    cta: 'Book your chair',
    hashtagSeeds: ['barber', 'fade', 'haircut', 'hairtransformation', 'barbershop'],
  },
  gym: {
    id: 'gym',
    label: 'Gym & personal training',
    short: 'Fitness',
    tagline: 'Energy, form, real results.',
    priorities: [
      'high-energy reps, heavy lifts, explosive movement',
      'coaching moments: the trainer correcting form, motivating',
      'members succeeding: PRs, high-fives, finishing a set',
      'clean shots of the facility and equipment',
      'transformation or progress comparisons',
    ],
    avoid: ['resting between sets', 'empty gym floor', 'poor form shown as a positive'],
    pacing: 'Fast. 1–2.5 second beat-driven cuts with peak moments landing on the cut.',
    structure: 'Hook with the most intense rep or a bold statement → training montage → coaching moment → result/PR → CTA.',
    segment: { min: 1.0, max: 2.5 },
    hookFirstFrom: 'best',
    hooks: ['Stop doing this wrong', 'This is what consistency looks like', 'Your first session looks like this', 'New PR unlocked'],
    captions: ['Warm up', 'Push it', 'Coached properly', 'Results'],
    cta: 'Claim your free session',
    hashtagSeeds: ['fitness', 'gym', 'personaltrainer', 'workout', 'gymtok'],
  },
  other: {
    id: 'other',
    label: 'Other local business',
    short: 'Local',
    tagline: 'Adapts to any industry you describe.',
    priorities: [
      'the core service being performed, shown up close',
      'visible transformation or the result the customer gets',
      'people: staff expertise, happy customers, reactions',
      'details that signal quality and care',
    ],
    avoid: ['static wide shots where nothing happens', 'dead air and setup time', 'blurry or dark footage'],
    pacing: 'Medium. 1.5–3 second cuts; slow down on the payoff.',
    structure: 'Hook with the most visually striking moment → process → result → CTA.',
    segment: { min: 1.5, max: 3.0 },
    hookFirstFrom: 'best',
    hooks: ['You need to see this', 'A day in the life of our team', 'This is how we do it', 'Wait for the end'],
    captions: ['Behind the scenes', 'The process', 'Attention to detail', 'The result'],
    cta: 'Message us to book',
    hashtagSeeds: ['smallbusiness', 'shoplocal', 'supportlocal', 'behindthescenes'],
  },
};

export const PLATFORMS = {
  tiktok: { id: 'tiktok', label: 'TikTok', maxSeconds: 60, sweetSpot: '15–35s', notes: 'Hook within the first second. Native-looking text boxes perform well. Keep key text out of the bottom 25% and right edge (UI buttons).' },
  reels: { id: 'reels', label: 'Instagram Reels', maxSeconds: 90, sweetSpot: '10–30s', notes: 'Polished but authentic. The cover frame matters. Keep text out of the bottom 20% (caption + audio label).' },
  shorts: { id: 'shorts', label: 'YouTube Shorts', maxSeconds: 60, sweetSpot: '20–45s', notes: 'Slightly longer, story-driven edits retain well; loops back to the start are rewarded.' },
};

export function getBusiness(id, customLabel) {
  const base = BUSINESSES[id] || BUSINESSES.other;
  if (base.id === 'other' && customLabel) {
    return { ...base, label: customLabel.trim().slice(0, 80) };
  }
  return base;
}

export function getPlatform(id) {
  return PLATFORMS[id] || PLATFORMS.tiktok;
}

// Lightweight public view for the frontend.
export function publicBusinessList() {
  return Object.values(BUSINESSES).map((b) => ({
    id: b.id,
    label: b.label,
    short: b.short,
    tagline: b.tagline,
    priorities: b.priorities,
    pacing: b.pacing,
    cta: b.cta,
  }));
}
