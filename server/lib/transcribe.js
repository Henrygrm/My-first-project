// Optional speech-to-text for spoken subtitles. Claude reviews the frames but
// cannot listen to audio, so word-level timestamps come from OpenAI's Whisper
// API when OPENAI_API_KEY is set. Without it, clips still get on-screen
// hook/caption/CTA text; they just won't have spoken-word subtitles.
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractAudio } from './ffmpeg.js';

export function transcriptionConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function transcribe(videoPath, workDir) {
  if (!transcriptionConfigured()) return null;
  const audioPath = path.join(workDir, 'speech.mp3');
  await extractAudio(videoPath, audioPath);
  const buf = await fs.readFile(audioPath);
  if (buf.length > 24 * 1024 * 1024) {
    throw new Error('Audio is too long to transcribe in one request (over 25 MB). Trim the video first.');
  }

  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'speech.mp3');
  form.append('model', process.env.WHISPER_MODEL || 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  await fs.rm(audioPath, { force: true });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    text: data.text || '',
    segments: (data.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text })),
    words: (data.words || []).map((w) => ({ start: w.start, end: w.end, text: w.word })),
  };
}
