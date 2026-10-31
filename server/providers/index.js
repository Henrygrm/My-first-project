// External AI services behind small interfaces, so a provider can be swapped
// without touching the rest of the app. Each entry says what it costs, so the
// UI can show it before anything is spent. Paid providers stay off until the
// owner turns them on and adds a key.
import { aiConfigured } from '../lib/ai.js';
import { cutoutsAvailable } from '../lib/cutout.js';
import { voiceConfigured, VOICES } from './tts.js';

export function providerStatus() {
  return {
    director: { name: 'Claude (Anthropic)', configured: aiConfigured(), cost: 'about 5–15 cents per batch of ads', approved: true },
    review: { name: 'Claude frame review', configured: aiConfigured(), cost: 'about 2–4 cents per ad', approved: true },
    cutouts: { name: 'Local background removal (ISNet)', configured: cutoutsAvailable(), cost: 'free, runs on this computer', approved: true },
    voice: { name: 'OpenAI voiceover (gpt-4o-mini-tts)', configured: voiceConfigured(), cost: 'about 1–2 cents per ad', approved: true, voices: VOICES },
    images: { name: 'AI image generation', configured: false, cost: 'not enabled', approved: false },
    video: { name: 'AI video generation', configured: false, cost: 'not enabled', approved: false },
  };
}
