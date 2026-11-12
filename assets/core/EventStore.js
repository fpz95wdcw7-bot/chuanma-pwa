export class EventStore {
  constructor(storageKey = 'mahjong-current-game') {
    this.storageKey = storageKey;
    this.listeners = new Set();
    this.events = this.load();
  }

  load() {
    try { return JSON.parse(localStorage.getItem(this.storageKey) || '[]'); }
    catch { return []; }
  }

  persist() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.events));
    this.listeners.forEach((listener) => listener(this.getEvents()));
  }

  append(event) {
    const next = {
      id: `evt-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      source: 'SYSTEM',
      confidence: 1,
      metadata: {},
      ...event,
    };
    this.events.push(next);
    this.persist();
    return next;
  }

  appendMany(events) {
    const created = events.map((event, index) => ({
      id: `evt-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 7)}`,
      timestamp: new Date(Date.now() + index).toISOString(),
      source: 'SYSTEM', confidence: 1, metadata: {}, ...event,
    }));
    this.events.push(...created);
    this.persist();
    return created;
  }

  clear() { this.events = []; this.persist(); }
  getEvents() { return [...this.events]; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
