import { EventEmitter } from 'node:events';
import { openSync, readSync, closeSync, statSync, watch } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export class Tailer extends EventEmitter {
  constructor({ pollMs = 1000 } = {}) {
    super();
    this.pollMs = pollMs;
    this.files = new Map(); // path → { offset, partial, decoder, watcher, errored }
    this.timer = setInterval(() => { for (const p of this.files.keys()) this._read(p); }, pollMs);
    if (this.timer.unref) this.timer.unref();
  }
  add(path, { fromStart = false } = {}) {
    if (this.files.has(path)) return;
    let offset = 0;
    if (!fromStart) { try { offset = statSync(path).size; } catch { offset = 0; } }
    const entry = { offset, partial: '', decoder: new StringDecoder('utf8'), watcher: null, errored: false };
    try { entry.watcher = watch(path, () => this._read(path)); entry.watcher.on('error', () => {}); } catch { /* poll only */ }
    this.files.set(path, entry);
    this._read(path);
  }
  remove(path) {
    const e = this.files.get(path);
    if (!e) return;
    if (e.watcher) e.watcher.close();
    this.files.delete(path);
  }
  close() { clearInterval(this.timer); for (const p of [...this.files.keys()]) this.remove(p); }

  _read(path) {
    const e = this.files.get(path);
    if (!e) return;
    let fd;
    try {
      const size = statSync(path).size;
      if (size < e.offset) { e.offset = 0; e.partial = ''; e.decoder = new StringDecoder('utf8'); }
      if (size === e.offset) return;
      fd = openSync(path, 'r');
      const buf = Buffer.alloc(size - e.offset);
      const n = readSync(fd, buf, 0, buf.length, e.offset);
      e.offset += n;
      // StringDecoder holds a multi-byte character that straddles a read boundary
      // until the remaining bytes arrive, instead of emitting replacement chars.
      const text = e.partial + e.decoder.write(buf.subarray(0, n));
      const parts = text.split('\n');
      e.partial = parts.pop();
      for (const line of parts) { const l = line.replace(/\r$/, ''); if (l) this.emit('line', path, l); }
      e.errored = false;
    } catch (err) {
      // An 'error' emit with no listener throws ERR_UNHANDLED_ERROR, which from the
      // poll timer would be an uncaught exception. The tailer must never throw.
      if (!e.errored && this.listenerCount('error') > 0) { e.errored = true; this.emit('error', path, err); }
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
    }
  }
}
