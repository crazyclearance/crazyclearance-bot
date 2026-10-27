import { readFile } from 'node:fs/promises';

// Minimal CSV parser (handles quotes, commas and newlines inside quotes).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const COLS = {
  id: 'ID', category: 'Category', question: 'Question', aliases: 'Other ways customers ask',
  dm: 'Answer (DM)', comment: 'Answer (public comment)', branch: 'Branch', status: 'Status', notes: 'Notes for staff',
};

// Turns the "Common Questions" tab into objects. Title rows above the header are skipped.
export function rowsToQuestions(rows) {
  const headerIdx = rows.findIndex(r => (r[0] || '').trim() === 'ID');
  if (headerIdx === -1) throw new Error('Sheet has no header row starting with "ID"');
  const header = rows[headerIdx].map(h => h.trim());
  const idx = {};
  for (const [key, name] of Object.entries(COLS)) {
    idx[key] = header.indexOf(name);
    if (idx[key] === -1) throw new Error(`Sheet column missing: ${name}`);
  }
  return rows.slice(headerIdx + 1)
    .filter(r => /^Q\d+/i.test((r[idx.id] || '').trim()))
    .map(r => {
      const q = {};
      for (const key of Object.keys(COLS)) q[key] = (r[idx[key]] || '').trim();
      q.id = q.id.toUpperCase();
      // Usable only if confirmed AND no placeholder text left in the answer.
      q.usable = q.status.toLowerCase() === 'confirmed'
        && q.dm !== '' && !/\[.*\]/.test(q.dm) && !/\[.*\]/.test(q.comment);
      return q;
    });
}

export function sheetCsvUrl(sheetId, tab) {
  // Sheet must be shared as "Anyone with the link can view". headers=0 keeps title rows as data.
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent(tab)}`;
}

export function createSheetStore(cfg, fetchImpl = fetch) {
  let cache = null, fetchedAt = 0;
  async function load() {
    if (cfg.sheetId) {
      const res = await fetchImpl(sheetCsvUrl(cfg.sheetId, cfg.sheetTab));
      if (!res.ok) throw new Error(`Google Sheet fetch failed: HTTP ${res.status}`);
      return rowsToQuestions(parseCsv(await res.text()));
    }
    return rowsToQuestions(parseCsv(await readFile(cfg.localCsv, 'utf8')));
  }
  return {
    async get() {
      const fresh = Date.now() - fetchedAt < cfg.sheetCacheSeconds * 1000;
      if (cache && fresh) return cache;
      try {
        cache = await load();
        fetchedAt = Date.now();
      } catch (err) {
        if (!cache) throw err; // nothing to fall back on
        console.error('[sheet] refresh failed, using last good copy:', err.message);
      }
      return cache;
    },
  };
}
