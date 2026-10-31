// Client footage inside motion-engine scenes: FFmpeg decodes the needed part
// of a video to raw frames, which become canvas images for the compositor.
import { spawn } from 'node:child_process';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { FFMPEG, toneMap } from '../ffmpeg.js';

export class VideoSource {
  /**
   * @param {object} spec { path, w, h, hdr } display size of the source
   * @param {number} W, H frame size of the composition (frames are scaled to cover it)
   */
  constructor(spec, W, H, fps = 30) {
    this.spec = spec;
    this.fps = fps;
    const s = Math.max(W / spec.w, H / spec.h);
    this.w = Math.max(2, Math.round((spec.w * s) / 2) * 2);
    this.h = Math.max(2, Math.round((spec.h * s) / 2) * 2);
    this.frameBytes = this.w * this.h * 4;
    this.canvas = createCanvas(this.w, this.h);
    this.proc = null;
    this.pos = -1; // source time of the last frame read
  }

  async start(ts) {
    this.stop();
    const tm = await toneMap(this.spec);
    const vf = [tm, `scale=${this.w}:${this.h}`, `fps=${this.fps}`, 'format=rgba'].filter(Boolean).join(',');
    this.proc = spawn(FFMPEG, ['-v', 'error', '-ss', Math.max(0, ts).toFixed(3), '-i', this.spec.path, '-an', '-vf', vf, '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    this.chunks = [];
    this.buffered = 0;
    this.ended = false;
    this.waiters = [];
    this.proc.stdout.on('data', (d) => {
      this.chunks.push(d);
      this.buffered += d.length;
      this.wake();
    });
    this.proc.on('close', () => {
      this.ended = true;
      this.wake();
    });
    this.proc.on('error', () => {
      this.ended = true;
      this.wake();
    });
    this.startTs = Math.max(0, ts);
    this.index = 0;
  }

  wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  async readFrame() {
    while (this.buffered < this.frameBytes) {
      if (this.ended) return null;
      await new Promise((r) => this.waiters.push(r));
    }
    const buf = Buffer.allocUnsafe(this.frameBytes);
    let off = 0;
    while (off < this.frameBytes) {
      const c = this.chunks[0];
      const take = Math.min(c.length, this.frameBytes - off);
      c.copy(buf, off, 0, take);
      off += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    this.buffered -= this.frameBytes;
    const t = this.startTs + this.index / this.fps;
    this.index++;
    return { buf, t };
  }

  /** The frame at source time ts (sequential reads are fast; jumps restart the decoder). */
  async frameAt(ts) {
    const step = 1 / this.fps;
    if (!this.proc || ts < this.pos - step * 0.5 || ts > this.pos + 1.5) await this.start(ts);
    let frame = null;
    while (this.pos < ts - step * 0.5) {
      const f = await this.readFrame();
      if (!f) break;
      frame = f;
      this.pos = f.t;
    }
    if (frame) {
      this.canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.buf.buffer, frame.buf.byteOffset, frame.buf.length), this.w, this.h), 0, 0);
      this.last = { img: this.canvas, w: this.w, h: this.h };
    }
    return this.last || null;
  }

  stop() {
    if (this.proc) {
      this.proc.stdout.removeAllListeners('data');
      this.proc.kill('SIGKILL');
    }
    this.proc = null;
  }
}
