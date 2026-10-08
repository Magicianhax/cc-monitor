import { EventEmitter } from 'node:events';
import { openSync, readSync, closeSync, statSync, watch } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// Reading is time-boxed so a server that starts beside gigabytes of old transcripts still answers
// HTTP within milliseconds: each event-loop turn reads at most `sliceMs` of work, `chunkBytes` per
// file at a time, round-robin across files, then yields and carries on in the next turn.
const CHUNK_BYTES = 1 << 20;
const SLICE_MS = 12;

export class Tailer extends EventEmitter {
  constructor({ pollMs = 1000, chunkBytes = CHUNK_BYTES, sliceMs = SLICE_MS } = {}) {
    super();
    this.pollMs = pollMs;
    this.chunkBytes = chunkBytes;
    this.sliceMs = sliceMs;
    this.files = new Map(); // path → { offset, partial, decoder, watcher, errored }
    this.queue = new Set(); // paths with bytes to read, in arrival order
    this.pumping = false;
    this.timer = setInterval(() => { for (const p of this.files.keys()) this._schedule(p); }, pollMs);
    if (this.timer.unref) this.timer.unref();
  }
  add(path, { fromStart = false } = {}) {
    if (this.files.has(path)) return;
    let offset = 0;
    if (!fromStart) { try { offset = statSync(path).size; } catch { offset = 0; } }
    const entry = { offset, partial: '', decoder: new StringDecoder('utf8'), watcher: null, errored: false };
    try { entry.watcher = watch(path, () => this._schedule(path)); entry.watcher.on('error', () => {}); } catch { /* poll only */ }
    this.files.set(path, entry);
    this._schedule(path);
  }
  remove(path) {
    const e = this.files.get(path);
    if (!e) return;
    if (e.watcher) e.watcher.close();
    this.files.delete(path);
    this.queue.delete(path);
  }
  close() { clearInterval(this.timer); for (const p of [...this.files.keys()]) this.remove(p); }

  _schedule(path) {
    if (!this.files.has(path)) return;
    this.queue.add(path);
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(() => this._pump());
  }

  _pump() {
    const t0 = Date.now();
    while (this.queue.size && Date.now() - t0 < this.sliceMs) {
      const path = this.queue.values().next().value;
      this.queue.delete(path);
      // A file with more to read goes to the back of the queue, so one huge transcript cannot
      // starve the small ones that are changing right now.
      if (this._read(path)) this.queue.add(path);
    }
    if (this.queue.size) setImmediate(() => this._pump());
    else this.pumping = false;
  }

  /** Read the next chunk of `path`; true when bytes remain beyond it. */
  _read(path) {
    const e = this.files.get(path);
    if (!e) return false;
    let fd;
    try {
      const size = statSync(path).size;
      if (size < e.offset) { e.offset = 0; e.partial = ''; e.decoder = new StringDecoder('utf8'); }
      if (size === e.offset) return false;
      fd = openSync(path, 'r');
      const buf = Buffer.alloc(Math.min(size - e.offset, this.chunkBytes));
      const n = readSync(fd, buf, 0, buf.length, e.offset);
      e.offset += n;
      // StringDecoder holds a multi-byte character that straddles a read boundary
      // until the remaining bytes arrive, instead of emitting replacement chars.
      const text = e.partial + e.decoder.write(buf.subarray(0, n));
      const parts = text.split('\n');
      e.partial = parts.pop();
      for (const line of parts) { const l = line.replace(/\r$/, ''); if (l) this.emit('line', path, l); }
      e.errored = false;
      return n > 0 && size > e.offset;
    } catch (err) {
      // An 'error' emit with no listener throws ERR_UNHANDLED_ERROR, which from the
      // poll timer would be an uncaught exception. The tailer must never throw.
      if (!e.errored && this.listenerCount('error') > 0) { e.errored = true; this.emit('error', path, err); }
      return false;
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
    }
  }
}
