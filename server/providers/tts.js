// Voiceover via OpenAI text-to-speech (approved by the owner; needs
// OPENAI_API_KEY). Swap this file to change provider: it only has to turn
// a script into an audio file.
import fs from 'node:fs/promises';

export const VOICES = {
  coral: 'Warm, friendly (female)',
  sage: 'Calm, trustworthy (female)',
  ash: 'Confident, clear (male)',
  onyx: 'Deep, premium (male)',
  verse: 'Energetic, upbeat (male)',
  shimmer: 'Bright, upbeat (female)',
};

export const voiceConfigured = () => Boolean(process.env.OPENAI_API_KEY);

/** Speak `text` into an mp3 at outPath. style: a short delivery note ("upbeat, excited"). */
export async function speak(text, outPath, { voice = 'coral', style = '' } = {}) {
  if (!voiceConfigured()) throw Object.assign(new Error('Voiceover needs an OpenAI API key. Add it on the Settings page.'), { code: 'SETUP_REQUIRED' });
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
        voice: VOICES[voice] ? voice : 'coral',
        input: String(text).slice(0, 1500),
        instructions: `Read this as a short social media ad for a local business. ${style || 'Warm, natural and confident; not salesy.'}`,
        response_format: 'mp3',
      }),
    }).catch((err) => ({ ok: false, status: 0, text: async () => err.message }));
    if (res.ok || (res.status && res.status < 500 && res.status !== 429)) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw Object.assign(new Error('Your OpenAI key was rejected. Check it on the Settings page.'), { code: 'SETUP_REQUIRED' });
    if (res.status === 429) throw new Error('OpenAI rate limit or out of credit. Check your balance at platform.openai.com.');
    throw new Error(`Voiceover failed (${res.status || 'network'}): ${body.slice(0, 160)}`);
  }
  await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}
