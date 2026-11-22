// Talks to the map worker.
//
// Each "channel" (one per view) only cares about its latest request: while a
// map is being computed, newer requests replace any queued one, so dragging a
// slider never builds up a backlog. Each channel has its own worker, so the
// views do not wait for each other.

export class MapChannel {
  constructor() {
    this.worker = new Worker(new URL("../worker.js", import.meta.url), { type: "module" });
    this.nextId = 1;
    this.busy = false;
    this.pending = null;      // { params, resolve, reject }
    this.current = null;
    this.worker.onmessage = (e) => this.onResult(e.data);
    this.worker.onerror = (e) => {
      const cur = this.current;
      this.current = null;
      this.busy = false;
      if (cur) cur.reject(new Error(e.message || "worker error"));
      this.flush();
    };
  }

  /**
   * Request a map. Resolves with { map, mc, ms }, or with null if a newer
   * request superseded this one before it started.
   */
  request(params) {
    return new Promise((resolve, reject) => {
      if (this.pending) this.pending.resolve(null);
      this.pending = { params, resolve, reject };
      this.flush();
    });
  }

  flush() {
    if (this.busy || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    this.busy = true;
    this.current = { ...job, id: this.nextId++ };
    this.worker.postMessage({ id: this.current.id, ...job.params });
  }

  onResult(data) {
    const cur = this.current;
    this.current = null;
    this.busy = false;
    if (cur && cur.id === data.id) {
      if (data.error) cur.reject(new Error(data.error));
      else cur.resolve(data);
    }
    this.flush();
  }
}

/** Runs requests strictly one after another (for the Compare grid). */
export class MapQueue {
  constructor() {
    this.worker = new Worker(new URL("../worker.js", import.meta.url), { type: "module" });
    this.nextId = 1;
    this.waiting = new Map();
    this.worker.onmessage = (e) => {
      const w = this.waiting.get(e.data.id);
      if (!w) return;
      this.waiting.delete(e.data.id);
      if (e.data.error) w.reject(new Error(e.data.error));
      else w.resolve(e.data);
    };
  }

  request(params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...params });
    });
  }
}
