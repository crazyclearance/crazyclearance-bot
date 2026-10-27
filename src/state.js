// In-memory state. Resets when the server restarts, which is fine for these jobs.

export function createState({ humanPauseHours = 12, now = () => Date.now() } = {}) {
  const seen = new Map();      // event id -> time (Meta can send the same webhook twice)
  const pausedUntil = new Map(); // thread key -> time
  const history = new Map();   // thread key -> [{role,text,at}]
  const log = [];              // last 500 decisions, for /admin

  const DAY = 24 * 3600 * 1000;
  const key = (accountId, userId) => `${accountId}:${userId}`;

  function prune() {
    const t = now();
    for (const [k, at] of seen) if (t - at > DAY) seen.delete(k);
    for (const [k, until] of pausedUntil) if (until < t) pausedUntil.delete(k);
    for (const [k, h] of history) if (!h.length || t - h[h.length - 1].at > DAY) history.delete(k);
  }
  setInterval(prune, 3600 * 1000).unref?.();

  return {
    firstTime(id) {
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.set(id, now());
      return true;
    },
    pauseForHuman(accountId, userId) {
      pausedUntil.set(key(accountId, userId), now() + humanPauseHours * 3600 * 1000);
    },
    isPaused(accountId, userId) {
      const until = pausedUntil.get(key(accountId, userId));
      return Boolean(until && until > now());
    },
    remember(accountId, userId, role, text) {
      const k = key(accountId, userId);
      const h = history.get(k) || [];
      h.push({ role, text, at: now() });
      history.set(k, h.slice(-6));
    },
    historyFor(accountId, userId) {
      return (history.get(key(accountId, userId)) || []).map(({ role, text }) => ({ role, text }));
    },
    record(entry) {
      log.unshift({ at: new Date(now()).toISOString(), ...entry });
      if (log.length > 500) log.length = 500;
    },
    recent() { return log; },
  };
}
