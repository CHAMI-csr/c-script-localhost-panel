/**
 * LogManager - Centralized Log Collector for Live Server Logs
 * Captures events from PHP processes, MySQL queries, and services
 */

const { EventEmitter } = require('events');

class LogManager extends EventEmitter {
  constructor(maxEntries = 200) {
    super();
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  log(source, message, level = 'info') {
    const entry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      time: new Date().toLocaleTimeString(),
      source: source || 'System',
      message: String(message || '').trim(),
      level: level // 'info' | 'warn' | 'error' | 'success'
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    this.emit('entry', entry);
    return entry;
  }

  getEntries(filterSource = null) {
    if (filterSource) {
      const f = filterSource.toLowerCase().trim();
      return this.entries.filter(e => {
        const s = (e.source || '').toLowerCase().trim();
        return s === f || s.includes(f) || f.includes(s);
      });
    }
    return [...this.entries];
  }

  clear() {
    this.entries = [];
    return { success: true };
  }
}

module.exports = LogManager;
