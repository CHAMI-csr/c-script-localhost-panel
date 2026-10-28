/** Polls known daemon log files and forwards appended lines to the app log bus. */
const fs = require('fs');
const path = require('path');

class LiveLogStreamer {
  constructor({ onLine, pollIntervalMs = 750, maxInitialBytes = 64 * 1024 } = {}) {
    this.onLine = typeof onLine === 'function' ? onLine : () => {};
    this.pollIntervalMs = pollIntervalMs;
    this.maxInitialBytes = maxInitialBytes;
    this.watchers = new Map();
    this.directories = new Map();
    this.timer = null;
  }

  static getRuntimePaths() {
    const roaming = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
    const roots = [path.join(roaming, 'c-script-localhost'), path.join(roaming, 'antigravity-localhost')];
    const result = [];
    for (const root of roots) {
      result.push({ source: 'NGINX', file: path.join(root, 'nginx', 'logs', 'error.log') });
      result.push({ source: 'NGINX Access', file: path.join(root, 'nginx', 'logs', 'access.log') });
      for (const name of ['mysql', 'mariadb']) result.push({ source: 'MariaDB', directory: path.join(root, name, 'data') });
      result.push({ source: 'PHP', directory: path.join(root, 'php') });
    }
    result.push({ source: 'MariaDB', directory: path.join(local, 'c-script-localhost', 'mysql', 'data') });
    result.push({ source: 'PHP', directory: path.join(roaming, 'c-script-localhost', 'logs', 'php') });
    return result;
  }

  watchFile(source, file) {
    if (!file || this.watchers.has(file)) return false;
    const state = { source, offset: 0, remainder: '', identity: null };
    try {
      const stat = fs.statSync(file);
      state.offset = Math.max(0, stat.size - this.maxInitialBytes);
      state.identity = `${stat.dev}:${stat.ino}`;
    } catch (_) {
      return false;
    }
    this.watchers.set(file, state);
    return true;
  }

  start(paths = LiveLogStreamer.getRuntimePaths()) {
    for (const entry of paths || []) {
      if (entry.file) this.watchFile(entry.source, entry.file);
      if (entry.directory) {
        this.directories.set(entry.directory, entry.source);
        this._discoverDirectory(entry.directory, entry.source);
      }
    }
    if (!this.timer) {
      this.timer = setInterval(() => this._poll(), this.pollIntervalMs);
      this.timer.unref?.();
    }
    this._poll();
    return { success: true, watched: this.watchers.size };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return { success: true };
  }

  list() {
    return [...this.watchers.entries()].map(([file, state]) => ({ source: state.source, file }));
  }

  _poll() {
    for (const [directory, source] of this.directories) this._discoverDirectory(directory, source);
    for (const [file, state] of this.watchers) {
      let stat;
      try { stat = fs.statSync(file); } catch (_) { continue; }
      const identity = `${stat.dev}:${stat.ino}`;
      if (state.identity !== identity || stat.size < state.offset) {
        state.identity = identity;
        state.offset = 0;
        state.remainder = '';
      }
      if (stat.size <= state.offset) continue;
      const length = Math.min(stat.size - state.offset, 1024 * 1024);
      const buffer = Buffer.allocUnsafe(length);
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const read = fs.readSync(fd, buffer, 0, length, state.offset);
        state.offset += read;
        const lines = (state.remainder + buffer.subarray(0, read).toString('utf8')).split(/\r?\n/);
        state.remainder = lines.pop() || '';
        for (const line of lines) {
          const message = line.trim();
          if (!message) continue;
          this.onLine({ source: state.source, message, level: /\b(error|fatal|critical|exception)\b/i.test(message) ? 'error' : 'info', time: new Date().toISOString(), file });
        }
      } catch (_) {
        // Files may be rotated between stat and read; the next poll resets the offset.
      } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
      }
    }
  }

  _discoverDirectory(directory, source) {
    try {
      for (const name of fs.readdirSync(directory)) {
        if (/\.(?:log|err|error)(?:\.[0-9]+)?$/i.test(name)) this.watchFile(source, path.join(directory, name));
      }
    } catch (_) {}
  }
}

module.exports = LiveLogStreamer;
