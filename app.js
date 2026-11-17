/* ECG Records v2 -- one app for the website (<organisation>.github.io) and for the device's PHONE PAGE.
 * Website: no server of its own; it reads and writes the private records repository (<organisation>/ecg-records)
 * through the GitHub API with the viewer's access key, which stays in this browser.
 * Phone page: the device serves this same app (<meta name="ecg-device">) and answers in place of GitHub (/api/...).
 * The records: recordings/<folder>/... (the device's files, never changed), index.json (the list), meta.json (each
 * recording's details -- name or code, age, sex, note, reviewed, in the bin -- every field with when, who and where it
 * was last changed) and changes.jsonl (every change, one line each, only ever added to). The rules are the device's
 * (cloud_sync.py): per field the newer edit wins wherever it was made; the change lists are joined; nothing is erased. */
'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keep = {
    get(k) { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v, long) { try { (long ? localStorage : sessionStorage).setItem(k, v); } catch (e) { /* private window */ } },
    del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) { /* */ } },
  };
  const DEV = !!document.querySelector('meta[name="ecg-device"]');
  const ORG = !DEV && location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : '';
  const S = {
    api: keep.get('ecg.api') || 'https://api.github.com',
    repo: keep.get('ecg.repo') || (ORG ? `${ORG}/ecg-records` : ''),
    key: keep.get('ecg.key') || '', branch: '', head: '',
    index: null, meta: {}, changes: [], reports: {}, ecgs: {}, seg: {},
    online: null, left: 0, device: null, gone: false,
    filter: keep.get('ecg.filter') || 'all', sort: keep.get('ecg.sort') || 'new', q: '', aq: '',
    draw: null, dirty: false, pending: false, busy: false,
  };
  if (!DEV) (() => {                          // a sign-in link (#key=...&repo=...): sign in, then a clean address bar
    const f = new URLSearchParams(location.hash.slice(1));
    if (!f.get('key')) return;
    S.key = f.get('key');
    keep.set('ecg.key', S.key, true);
    if (f.get('repo')) { S.repo = f.get('repo'); keep.set('ecg.repo', S.repo, true); }
    history.replaceState(null, '', location.pathname + '#/');
  })();

  const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    back: svg('<path d="M15 18l-6-6 6-6"/>'),
    down: svg('<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/>'),
    doc: svg('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>'),
    redo: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
    user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    restore: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7"/>'),
    table: svg('<path d="M3 5h18v14H3zM3 10h18M9 5v14"/>'),
    wifi: svg('<path d="M2 8.8a15 15 0 0 1 20 0M5 12.6a10 10 0 0 1 14 0M8.5 16.2a5 5 0 0 1 7 0"/><path d="M12 19.5h.01"/>'),
    cloud: svg('<path d="M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 9.5a4.3 4.3 0 0 1-1 8.5z"/>'),
  };
  const LOGO = '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8"/><path d="M4 17h6l2.2-5 3 11 3.2-15 2.8 9H28"/></svg>';
  const HEADS = [['MI_ANY', 'Myocardial infarction (any)'], ['MI_ACUTE', 'Acute MI'], ['MI_OLD', 'Old MI'],
    ['ISCH_STT', 'Ischaemic ST-T change'], ['CD_WIDE', 'Wide QRS (conduction)'], ['MI_CD', 'MI with conduction delay']];
  const LEADS = [['I', 'I'], ['II', 'II'], ['III', 'III'], ['aVR', 'aVR'], ['aVL', 'aVL'], ['aVF', 'aVF'], ['V2', 'V2']];
  const FILTERS = [['all', 'All'], ['REFER', 'Refer'], ['NOT NORMAL', 'Not normal'], ['NO REFER', 'No refer'],
    ['NO AI RESULT', 'No result'], ['review', 'To review'], ['bin', 'Bin']];
  const SORTS = [['new', 'Newest first'], ['old', 'Oldest first'], ['name', 'Name A–Z'], ['result', 'Refer first']];
  const RANK = { REFER: 0, 'NOT NORMAL': 1, 'NO AI RESULT': 2, 'NO REFER': 3 };
  const SEX = { F: 'Female', M: 'Male', O: 'Other' };
  const PLACE = { website: 'website', 'phone page': 'phone page', device: 'device' };

  // ------------------------------------------------------------------ details and changes: the device's rules
  const FIELDS = ['label', 'age', 'sex', 'note', 'reviewed', 'deleted'], BOOLS = ['reviewed', 'deleted'];
  const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const atOf = e => String((e || {}).at || '').replace(' ', 'T');
  const byAt = (a, b) => (String(a.at || '') < String(b.at || '') ? -1 : String(a.at || '') > String(b.at || '') ? 1
    : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  const rid = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
  const valOf = (meta, rec, f) => { const e = (meta[rec] || {})[f]; return e ? (BOOLS.includes(f) ? !!e.v : String(e.v ?? '')) : (BOOLS.includes(f) ? false : ''); };
  const val = (rec, f) => valOf(S.meta, rec, f);
  function normMeta(m) {
    if (!m || typeof m !== 'object') return {};
    let src = m.records;
    if (!src || typeof src !== 'object') {          // labels.json, the older form: {id: {label, note, at}}
      src = {};
      for (const [k, e] of Object.entries(m)) {
        if (!e || typeof e !== 'object') continue;
        src[k] = {};
        for (const f of ['label', 'note']) if (f in e) src[k][f] = { v: String(e[f] || ''), at: atOf(e), by: '', where: 'device' };
      }
    }
    const out = {};
    for (const [k, r] of Object.entries(src)) {
      if (!/^R\d{4,}$/.test(k) || !r || typeof r !== 'object') continue;
      out[k] = {};
      for (const [f, x] of Object.entries(r)) {
        if (!FIELDS.includes(f) || !x || typeof x !== 'object') continue;
        out[k][f] = { v: BOOLS.includes(f) ? !!x.v : String(x.v ?? ''), at: String(x.at || ''), by: String(x.by || ''), where: String(x.where || '') };
      }
    }
    return out;
  }
  function parseChanges(text) {
    const d = {};
    for (const ln of String(text || '').split('\n')) {
      try { const c = JSON.parse(ln); if (c && typeof c === 'object' && c.id) d[String(c.id)] = c; } catch (e) { /* not a line */ }
    }
    return Object.values(d).sort(byAt);
  }
  const sortDeep = o => (Array.isArray(o) ? o.map(sortDeep) : o && typeof o === 'object'
    ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sortDeep(o[k])])) : o);
  const metaText = m => `${JSON.stringify(sortDeep({ records: m, schema: 'aiecg-meta/2' }), null, 1)}\n`;   // as the device writes it
  const changesText = list => list.map(c => `{${Object.keys(c).sort().map(k => `${JSON.stringify(k)}: ${JSON.stringify(c[k])}`).join(', ')}}\n`).join('');
  const printable = s => [...String(s ?? '')].map(c => (/[\p{C}\p{Z}]/u.test(c) ? ' ' : c)).join('').split(/\s+/).filter(Boolean).join(' ');
  function cleanFields(fields) {                  // -> [fields, ''] or [null, why]
    const out = {};
    for (const [f, v0] of Object.entries(fields)) {
      if (!FIELDS.includes(f)) return [null, `Unknown field ${f}.`];
      if (BOOLS.includes(f)) { out[f] = !!v0; continue; }
      let v = String(v0 ?? '');
      if (f === 'label') {
        v = v.split(/\s+/).filter(Boolean).join(' ');
        if (v && !/^(?=.*[A-Za-z0-9])[^\x00-\x1f<>"\\/{}]{1,40}$/u.test(v)) return [null, 'Name or code: up to 40 characters, with a letter or digit, without < > " / \\ { }.'];
      } else if (f === 'age') {
        v = v.trim();
        if (v && (!/^\d{1,3}$/.test(v) || +v > 120)) return [null, 'Age: a whole number of years, 0 to 120.'];
        v = v ? String(+v) : '';
      } else if (f === 'sex') {
        v = v.trim().toUpperCase().slice(0, 1);
        if (!['', 'F', 'M', 'O'].includes(v)) return [null, 'Sex: female, male or other.'];
      } else v = [...printable(v)].slice(0, 200).join('');
      out[f] = v;
    }
    return [out, ''];
  }
  function applyEdit(meta, changes, rec, fields, by, where, reason) {
    const now = nowIso(), add = [], r = meta[rec] || (meta[rec] = {});
    by = printable(by).slice(0, 40);
    for (const [f, v] of Object.entries(fields)) {
      const old = valOf(meta, rec, f);
      if (old === v) continue;
      r[f] = { v, at: now, by, where };
      const c = { id: rid(), at: now, by, where, rec, what: f, from: old, to: v };
      if (reason && f === 'deleted') c.reason = printable(reason).slice(0, 120);
      changes.push(c); add.push(c);
    }
    changes.sort(byAt);
    return add;
  }
  const parseJSON = (t, dflt) => { try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : dflt; } catch (e) { return dflt; } };

  // ------------------------------------------------------------------ the two ways in: GitHub, or the device itself
  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  async function gh(path, { method = 'GET', body, raw = false, ok = [] } = {}) {
    let r;
    try {
      r = await fetch(`${S.api}/repos/${S.repo}${path}`, {
        method, cache: 'no-store', body: body ? JSON.stringify(body) : undefined,
        headers: { Authorization: `Bearer ${S.key}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      });
    } catch (e) { const x = new Error('No connection. Check the internet, then try again.'); x.status = 0; throw x; }
    if (ok.includes(r.status)) return null;
    if (!r.ok) {
      const x = new Error(`GitHub answered ${r.status}.`); x.status = r.status;
      try { x.detail = (await r.json()).message; } catch (e) { /* */ }
      throw x;
    }
    return raw ? r : r.json();
  }
  const rawAt = async (p, ref) => { const r = await gh(`/contents/${enc(p)}${ref ? `?ref=${ref}` : ''}`, { raw: true, ok: [404] }); return r ? r.text() : ''; };
  const GH = {
    async load() {
      if (!S.branch) S.branch = (await gh('')).default_branch || 'main';
      const ref = await gh(`/git/ref/heads/${enc(S.branch)}`, { ok: [404, 409] });
      if (!ref) return { head: '', index: { recordings: [] }, meta: {}, changes: [] };
      const sha = ref.object.sha;
      const [it, mt, ct] = await Promise.all([rawAt('index.json', sha), rawAt('meta.json', sha), rawAt('changes.jsonl', sha)]);
      const lt = mt ? '' : await rawAt('labels.json', sha);
      return { head: sha, index: parseJSON(it, { recordings: [] }), meta: normMeta(parseJSON(mt || lt, {})), changes: parseChanges(ct) };
    },
    async version() { const ref = await gh(`/git/ref/heads/${enc(S.branch)}`, { ok: [404, 409] }); return ref ? ref.object.sha : ''; },
    async edit(rec, fields, reason) {               // one commit of meta.json + changes.jsonl; again if the records moved
      for (let i = 0; i < 5; i++) {
        const ref = await gh(`/git/ref/heads/${enc(S.branch)}`);
        const sha = ref.object.sha;
        const [cm, mt, ct] = await Promise.all([gh(`/git/commits/${sha}`), rawAt('meta.json', sha), rawAt('changes.jsonl', sha)]);
        const meta = normMeta(parseJSON(mt || await rawAt('labels.json', sha), {})), changes = parseChanges(ct);
        const add = applyEdit(meta, changes, rec, fields, me(), 'website', reason);
        if (add.length) {
          const tree = await gh('/git/trees', { method: 'POST', body: { base_tree: cm.tree.sha, tree: [
            { path: 'meta.json', mode: '100644', type: 'blob', content: metaText(meta) },
            { path: 'changes.jsonl', mode: '100644', type: 'blob', content: changesText(changes) }] } });
          const what = add.map(c => (c.what === 'label' ? 'name' : c.what === 'deleted' ? (c.to ? 'to the bin' : 'restored') : c.what)).join(', ');
          const nc = await gh('/git/commits', { method: 'POST', body: { message: `${rec}: ${what} (website, ${me()})`, tree: tree.sha, parents: [sha] } });
          try { await gh(`/git/refs/heads/${enc(S.branch)}`, { method: 'PATCH', body: { sha: nc.sha, force: false } }); }
          catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
          adopt({ head: nc.sha, index: S.index, meta, changes });
          return add.length;
        }
        if (sha === S.head) { S.meta = meta; S.changes = changes; }
        return 0;
      }
      const x = new Error('The records were busy. Try again.'); x.status = 409; throw x;
    },
    bytes: async (r, f) => new Uint8Array(await (await gh(`/contents/${enc(`recordings/${r.folder}/${f}`)}`, { raw: true })).arrayBuffer()),
    text: async (r, f) => (await gh(`/contents/${enc(`recordings/${r.folder}/${f}`)}`, { raw: true })).text(),
  };
  async function dv(path, { method = 'GET', body, raw = false } = {}) {
    let r;
    try {
      r = await fetch(path, { method, cache: 'no-store', credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined,
        headers: body ? { 'Content-Type': 'application/json' } : {} });
    } catch (e) { const x = new Error('The device is not answering: its Wi-Fi may be off.'); x.status = 0; throw x; }
    if (!r.ok) {
      const x = new Error(r.status === 403 ? 'Signed out.' : `The device answered ${r.status}.`); x.status = r.status;
      try { x.detail = (await r.json()).error; } catch (e) { /* */ }
      throw x;
    }
    return raw ? r : r.json();
  }
  const DV = {
    async load() {
      const d = await dv('/api/state');
      S.online = d.online; S.left = d.left; S.device = d.device; S.gone = false;
      return { head: d.version, index: d.index, meta: normMeta({ records: d.meta || {} }), changes: (d.changes || []).sort(byAt) };
    },
    async version() { const d = await dv('/api/version'); S.online = d.online; S.left = d.left; S.gone = false; return d.version; },
    async edit(rec, fields, reason) {
      const d = await dv('/api/edit', { method: 'POST', body: { rec, fields, by: me(), reason } });
      adopt(await DV.load());
      return d.changes;
    },
    bytes: async (r, f) => new Uint8Array(await (await dv(`/f/${enc(r.folder)}/${enc(f)}`, { raw: true })).arrayBuffer()),
    text: async (r, f) => (await dv(`/f/${enc(r.folder)}/${enc(f)}`, { raw: true })).text(),
  };
  const B = DEV ? DV : GH;
  const why = e => (DEV ? (e.status === 0 ? e.message : e.status === 403 ? 'Signed out. Reload the page and enter the code on the device.'
    : e.detail || e.message || 'Something went wrong.')
    : e.status === 401 ? 'This key is not valid (mistyped, revoked or expired). Sign in again.'
      : e.status === 404 ? `This key cannot open ${S.repo}. Check the records name and the key's repository access.`
        : e.status === 403 ? 'GitHub refused this: the key may only read, or the hourly limit was reached.'
          : e.status === 409 || e.status === 422 ? 'The records changed meanwhile. Try again.' : (e.message || 'Something went wrong.'));

  function adopt(d) {                            // -> the change lines that are new to this page
    const known = new Set(S.changes.map(c => c.id)), first = !S.index;
    S.head = d.head; S.index = d.index || { recordings: [] }; S.meta = d.meta || {}; S.changes = d.changes || [];
    return first ? [] : S.changes.filter(c => !known.has(c.id));
  }
  async function load(force) { if (S.index && !force) return []; return adopt(await B.load()); }

  // ------------------------------------------------------------------ small helpers
  const num = id => parseInt(String(id).slice(1), 10) || 0;
  const chip = (t, tone) => `<span class="chip ${tone}">${esc(t)}</span>`;
  const sigChip = r => {
    const noisy = r.noisy || [];
    if (r.grade !== 'FAIR' && r.grade !== 'POOR' && !noisy.length) return '';
    return chip(`SIGNAL ${r.grade}${noisy.length ? ` · NOISE ${noisy.join(' ')}` : ''}`, r.grade === 'POOR' ? 'red' : 'amber');
  };
  const when = r => { const m = /^(\d{1,2} \w{3} \d{4}) (\d{2}:\d{2})/.exec(r.when || ''); return m ? `${m[1]}, ${m[2]}` : (r.clock_ok === false ? 'Time not verified' : (r.when || '–')); };
  const ago = iso => {
    const t = Date.parse(iso || ''); if (!t) return 'not yet';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const stamp = iso => { const t = Date.parse(iso || ''); return t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–'; };
  const fmt = (v, d = 0, unit = '') => (v === null || v === undefined || v === '' || Number.isNaN(+v)) ? '–' : `${(+v).toFixed(d)}${unit}`;
  const safe = s => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const base = r => (safe(val(r.id, 'label')) ? `${r.id}_${safe(val(r.id, 'label'))}` : r.id);
  const demo = id => [val(id, 'age') && `${val(id, 'age')} y`, SEX[val(id, 'sex')]].filter(Boolean).join(' · ');
  const mb = n => (n ? (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`) : '');
  const me = () => keep.get('ecg.by') || '';
  const lastOf = (rec, f) => [...S.changes].reverse().find(c => c.rec === rec && c.what === f);
  function toast(msg, bad) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.className = bad ? 'show bad' : 'show';
    clearTimeout(t.h); t.h = setTimeout(() => { t.className = ''; }, bad ? 6500 : 4500);
  }
  function saveAs(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 8000);
  }
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {                            // [{name, data: Uint8Array}] -> a ZIP (stored), for downloads
    const te = new TextEncoder(), parts = [], cen = [], d = new Date();
    const tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    let off = 0;
    for (const f of files) {
      const nm = te.encode(f.name), c = crc32(f.data), n = f.data.length;
      const L = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [10, tm, 2], [12, dt, 2], [14, c, 4], [18, n, 4], [22, n, 4], [26, nm.length, 2]]
        .forEach(([o, v, s]) => (s === 4 ? L.setUint32(o, v, true) : L.setUint16(o, v, true)));
      const C = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [12, tm, 2], [14, dt, 2], [16, c, 4], [20, n, 4], [24, n, 4], [28, nm.length, 2], [42, off, 4]]
        .forEach(([o, v, s]) => (s === 4 ? C.setUint32(o, v, true) : C.setUint16(o, v, true)));
      parts.push(L.buffer, nm, f.data); cen.push(C.buffer, nm);
      off += 30 + nm.length + n;
    }
    const size = cen.reduce((s, p) => s + p.byteLength, 0), E = new DataView(new ArrayBuffer(22));
    E.setUint32(0, 0x06054b50, true); E.setUint16(8, files.length, true); E.setUint16(10, files.length, true);
    E.setUint32(12, size, true); E.setUint32(16, off, true);
    return new Blob([...parts, ...cen, E.buffer], { type: 'application/zip' });
  }
  const cell = v => { let s = String(v ?? ''); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = (head, rows) => new Blob([`﻿${[head, ...rows].map(r => r.map(cell).join(',')).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const today = () => new Date().toISOString().slice(0, 10);

  // ------------------------------------------------------------------ dialogs
  function modal({ title, html, ok = 'OK', danger = false, onOk, onCancel }) {
    const prev = document.activeElement, wrap = document.createElement('div');
    wrap.className = 'scrim';
    wrap.innerHTML = `<form class="modal card" role="dialog" aria-modal="true" aria-labelledby="m-t" autocomplete="off">
      <h3 id="m-t">${esc(title)}</h3>${html}<p class="err" id="m-err" role="alert"></p>
      <div class="m-act"><button type="button" class="btn" id="m-no">Cancel</button><button type="submit" class="btn ${danger ? 'dangerf' : 'primary'}" id="m-ok">${esc(ok)}</button></div></form>`;
    document.body.appendChild(wrap);
    const f = $('form', wrap);
    const close = cancelled => { wrap.remove(); document.removeEventListener('keydown', key, true); if (cancelled && onCancel) onCancel(); if (prev && prev.focus) prev.focus(); };
    const key = e => { if (e.key === 'Escape' && wrap === $$('.scrim').pop()) { e.stopPropagation(); close(true); } };
    document.addEventListener('keydown', key, true);
    $('#m-no', wrap).onclick = () => close(true);
    wrap.onmousedown = e => { if (e.target === wrap) close(true); };
    f.onsubmit = async ev => {
      ev.preventDefault();
      const b = $('#m-ok', wrap); b.disabled = true; $('#m-err', wrap).textContent = '';
      try { if (await onOk(wrap) !== false) close(false); } catch (e) { $('#m-err', wrap).textContent = e.status !== undefined ? why(e) : e.message; }
      b.disabled = false;
    };
    ($('input, select, textarea', f) || $('#m-ok', wrap)).focus();
  }
  function askName(force) {                        // who makes the change: written in the history
    if (me() && !force) return Promise.resolve(true);
    return new Promise(res => modal({
      title: 'Your name', ok: force ? 'Save' : 'Continue', onCancel: () => res(false),
      html: `<p class="muted">It is written with every change you make, in the history that everyone with the records sees. It is kept in this browser.</p>
        <label><span>Name</span><input id="m-me" maxlength="40" value="${esc(me())}" placeholder="For example: Dr A. Rao" required></label>`,
      onOk: w => {
        const v = printable($('#m-me', w).value).slice(0, 40);
        if (!v) throw new Error('Type your name.');
        keep.set('ecg.by', v, true); res(true); drawMenu(); return true;
      },
    }));
  }

  // ------------------------------------------------------------------ the frame
  function shell() {
    const org = S.repo.split('/')[0] || '';
    $('#app').innerHTML = `
      <header class="top"><div class="wrap bar">
        <a class="brand" href="#/">${LOGO}<span><b>ECG Records</b><small>${DEV ? 'On the device' : esc(org)}</small></span></a>
        <nav class="nav" aria-label="Views"><a href="#/" id="n-list">Recordings</a><a href="#/activity" id="n-act">Activity</a></nav>
        <div class="grow"></div>
        <button class="btn ghost" id="reload" title="Load the latest">${I.redo}<span>Refresh</span></button>
        <div class="menu"><button class="btn ghost" id="me" aria-haspopup="true" aria-expanded="false" title="You">${I.user}</button>
          <div class="pop" id="pop" hidden></div></div>
      </div>${DEV ? '<div class="devbar" id="dev"></div>' : ''}</header>
      <main class="wrap" id="main"></main>
      <footer class="wrap foot">For clinical assistance only: a doctor confirms every result. ${DEV
    ? 'This page exists only while the device shares, on its Wi-Fi network.'
    : 'The records are private and open only with a key.'}</footer>`;
    $('#reload').onclick = async () => {
      if (S.dirty) return toast('Save or undo the details first.', true);
      S.reports = {}; S.ecgs = {};
      try { const add = await load(true); render(true); toast(add.length ? `${add.length} new change${add.length === 1 ? '' : 's'}.` : 'Up to date.'); } catch (e) { fail(e); }
    };
    const pop = $('#pop'), btn = $('#me');
    btn.onclick = e => { e.stopPropagation(); pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden)); };
    document.addEventListener('click', e => { if (!pop.contains(e.target)) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    drawMenu();
  }
  function drawMenu() {
    const pop = $('#pop'); if (!pop) return;
    pop.innerHTML = `${DEV ? '' : `<p class="muted small">Records: <b>${esc(S.repo)}</b></p>`}
      <p class="muted small">You: <b>${esc(me() || 'not set')}</b></p>
      <button id="m-name">${me() ? 'Change your name' : 'Set your name'}</button>
      ${DEV ? '<button id="m-sync">Sync with the online records now</button><button id="m-off">Turn the device\'s Wi-Fi off</button>'
    : '<button id="m-copy">Copy a sign-in link</button><button id="m-out">Sign out on this device</button>'}`;
    $('#m-name').onclick = () => askName(true);
    if (DEV) { $('#m-sync').onclick = syncNow; $('#m-off').onclick = wifiOff; return; }
    $('#m-copy').onclick = async () => {
      const link = `${location.origin}${location.pathname}#key=${encodeURIComponent(S.key)}&repo=${encodeURIComponent(S.repo)}`;
      try { await navigator.clipboard.writeText(link); toast('Sign-in link copied. Anyone with it can open the records: send it only to the doctors you choose.'); }
      catch (e) { toast('The browser did not allow copying here.', true); }
    };
    $('#m-out').onclick = () => { keep.del('ecg.key'); S.key = ''; S.index = null; S.head = ''; go(); };
  }
  function drawStatus() {                          // the phone page's strip: the Wi-Fi and the online records
    const el = $('#dev'); if (!el) return;
    if (S.gone) {
      el.className = 'devbar gone';
      el.innerHTML = `<div class="wrap in">${I.wifi}<span><b>The device is not answering.</b> It stopped sharing or its Wi-Fi went off. On the device: SHARE, then PHONE PAGE, then reload this page.</span></div>`;
      return;
    }
    const o = S.online || {}, now = o.now || {}, last = o.last || {}, min = Math.ceil((S.left || 0) / 60);
    let dot = 'ok', txt;
    if (!o.configured) { dot = 'off'; txt = 'Online records not set up'; }
    else if (now.state === 'busy') { dot = 'busy'; txt = 'Online records: syncing…'; }
    else if (now.state === 'fail') { dot = 'bad'; txt = now.msg; }
    else if (now.state === 'ok') txt = `In step with the online records · ${ago(now.at)}`;
    else if (last.at) { dot = last.ok ? 'ok' : 'bad'; txt = last.ok ? `Online records: last in step ${ago(last.at)}` : `Online records: last try failed (${String(last.why || '').toLowerCase()})`; }
    else { dot = 'off'; txt = 'Online records: not synced yet'; }
    el.className = 'devbar';
    el.innerHTML = `<div class="wrap in">
      <span class="it">${I.wifi}<span><b>On the device</b>${S.device && S.device.net ? ` · ${esc(S.device.net)}` : ''} · Wi-Fi off in ${min} min${min <= 3 ? ' <button class="lnk" id="d-keep">Keep on</button>' : ''}
        <button class="lnk danger" id="d-off">Turn off</button></span></span>
      <span class="it"><i class="dot ${dot}"></i><span>${esc(txt)}</span>${o.configured ? '<button class="lnk" id="d-sync">Sync now</button>' : ''}</span></div>`;
    if ($('#d-keep')) $('#d-keep').onclick = async () => { try { await load(true); drawStatus(); toast('The Wi-Fi stays on for 10 more minutes.'); } catch (e) { toast(why(e), true); } };
    if ($('#d-sync')) $('#d-sync').onclick = syncNow;
    $('#d-off').onclick = wifiOff;
  }
  async function syncNow() {
    try { await dv('/api/sync', { method: 'POST', body: {} }); S.online = { ...(S.online || {}), now: { state: 'busy' } }; drawStatus(); toast('Syncing with the online records…'); }
    catch (e) { toast(why(e), true); }
  }
  function wifiOff() {
    modal({ title: 'Turn the device\'s Wi-Fi off?', ok: 'Turn off', danger: true,
      html: '<p>This page closes. Saved details stay on the device; the online records take them at the next UPLOAD.</p>',
      onOk: async () => { await dv('/api/off', { method: 'POST', body: {} }); S.gone = true; drawStatus(); toast('The Wi-Fi is turning off. Recording is possible again on the device.'); return true; } });
  }
  function fail(e) {
    if (!DEV && e.status === 401) { keep.del('ecg.key'); S.key = ''; return viewSignIn(why(e)); }
    if (DEV && e.status === 403) { location.reload(); return; }
    if (DEV && e.status === 0) { S.gone = true; drawStatus(); }
    const m = $('#main') || $('#app');
    m.innerHTML = `<div class="empty">${esc(why(e))}<br><button class="btn" id="again">Try again</button></div>`;
    $('#again').onclick = () => { S.index = null; go(); };
  }

  // ------------------------------------------------------------------ sign in (website)
  function viewSignIn(err) {
    document.title = 'ECG Records';
    $('#app').innerHTML = `<main class="signin"><form class="card" id="si" autocomplete="off">
      ${LOGO}<h1>ECG Records</h1><p class="muted">Sign in with your access key to open the recordings.</p>
      <label><span>Access key</span><input id="k" type="password" spellcheck="false" placeholder="github_pat_…" required></label>
      <details${S.repo ? '' : ' open'}><summary>Records: <b>${esc(S.repo || 'not set')}</b></summary>
        <label><span>Records repository (organisation/name)</span><input id="rp" value="${esc(S.repo)}" placeholder="organisation/ecg-records" required></label></details>
      <label class="check"><input type="checkbox" id="long" checked><span>Keep me signed in on this device</span></label>
      <button class="btn primary wide" type="submit" id="go">Sign in</button>
      <p class="err" id="err" role="alert">${esc(err || '')}</p>
      <p class="muted small">The key stays in this browser and is sent only to GitHub.</p></form></main>`;
    $('#si').onsubmit = async ev => {
      ev.preventDefault();
      const b = $('#go');
      S.key = $('#k').value.trim(); S.repo = $('#rp').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
      b.disabled = true; b.textContent = 'Checking…'; $('#err').textContent = '';
      try {
        S.branch = (await gh('')).default_branch || 'main';
        keep.set('ecg.key', S.key, $('#long').checked); keep.set('ecg.repo', S.repo, true);
        S.index = null; go();
      } catch (e) { $('#err').textContent = why(e); b.disabled = false; b.textContent = 'Sign in'; }
    };
  }

  // ------------------------------------------------------------------ the list
  const pass = (r, f) => (f === 'bin' ? val(r.id, 'deleted')
    : !val(r.id, 'deleted') && (f === 'all' || (f === 'review' ? !val(r.id, 'reviewed') : r.result === f)));
  const sorter = {
    new: (a, b) => num(b.id) - num(a.id),
    old: (a, b) => num(a.id) - num(b.id),
    name: (a, b) => (val(a.id, 'label') || '￿').localeCompare(val(b.id, 'label') || '￿', undefined, { sensitivity: 'base', numeric: true }) || num(b.id) - num(a.id),
    result: (a, b) => (RANK[a.result] ?? 9) - (RANK[b.result] ?? 9) || num(b.id) - num(a.id),
  };
  function viewList() {
    document.title = 'ECG Records';
    const all = S.index.recordings || [], act = all.filter(r => !val(r.id, 'deleted')), bin = all.length - act.length;
    const n = t => act.filter(r => r.result === t).length;
    if (S.filter === 'bin' && !bin) S.filter = 'all';
    $('#main').innerHTML = `
      <section class="tiles">
        <button class="tile" data-f="all"><span>Recordings</span><b>${act.length}</b></button>
        <button class="tile red" data-f="REFER"><span>Refer</span><b>${n('REFER')}</b></button>
        <button class="tile amber" data-f="NOT NORMAL"><span>Not normal</span><b>${n('NOT NORMAL')}</b></button>
        <button class="tile acc" data-f="review"><span>To review</span><b>${act.filter(r => !val(r.id, 'reviewed')).length}</b></button>
      </section>
      <section class="tools">
        <input id="q" type="search" placeholder="Search name, number, note, result or date" value="${esc(S.q)}" aria-label="Search">
        <select id="sort" aria-label="Order">${SORTS.map(([k, t]) => `<option value="${k}"${S.sort === k ? ' selected' : ''}>${t}</option>`).join('')}</select>
        <div class="grow"></div>
        <button class="btn" id="csv" data-short="CSV" title="One row per recording shown, with its details">${I.table}<span class="long">Register (CSV)</span></button>
        <button class="btn" id="pdfs" data-short="PDFs" title="The PDF reports of the recordings shown, as one ZIP">${I.down}<span class="long">Reports (ZIP)</span></button>
      </section>
      <div class="seg" id="filters">${FILTERS.filter(([k]) => k !== 'bin' || bin).map(([k, t]) => `<button type="button" data-f="${esc(k)}">${t}${k === 'bin' ? ` (${bin})` : ''}</button>`).join('')}</div>
      <p class="sub" id="sub"></p>
      <section class="list" id="list"></section>`;
    const draw = () => {
      const q = S.q.trim().toLowerCase();
      const shown = all.filter(r => pass(r, S.filter) && (!q || `${r.id} ${val(r.id, 'label')} ${val(r.id, 'note')} ${r.result} ${when(r)} ${demo(r.id)}`.toLowerCase().includes(q)))
        .sort(sorter[S.sort] || sorter.new);
      S.shown = shown;
      $$('[data-f]').forEach(b => b.classList.toggle('on', b.dataset.f === S.filter));
      const where = DEV ? `${all.length} on the device` : `last upload from the device ${ago(S.index.uploaded)}`;
      $('#sub').textContent = `${shown.length} shown · ${where}`;
      $('#csv').disabled = $('#pdfs').disabled = !shown.length;
      $('#list').innerHTML = shown.length
        ? '<div class="thead"><span>Recording</span><span>Name or code</span><span>Recorded</span><span>AI result</span><span>Heart rate</span></div>'
          + shown.map(r => `<a class="row${val(r.id, 'deleted') ? ' del' : ''}" href="#/r/${esc(r.id)}">
            <span class="id">${esc(r.id)}${val(r.id, 'reviewed') ? `<i class="ok" title="Reviewed">${I.check}</i>` : ''}${r.test ? '<i class="tag">test</i>' : ''}${r.online === false ? '<i class="tag" title="Goes online at the next UPLOAD">not online</i>' : ''}</span>
            <span class="nm">${val(r.id, 'label') ? esc(val(r.id, 'label')) : '<span class="muted">–</span>'}${demo(r.id) ? ` <span class="muted">${esc(demo(r.id))}</span>` : ''}</span>
            <span class="dt">${esc(when(r))}</span>
            <span class="rs">${chip(r.result, r.tone)} ${sigChip(r)}</span>
            <span class="hr">${r.hr ? `${Math.round(r.hr)} /min` : '–'}</span></a>`).join('')
        : `<div class="empty">${all.length ? (S.filter === 'bin' ? 'The bin is empty.' : 'Nothing matches.')
          : DEV ? 'No recordings on the device yet.' : 'No recordings online yet. On the device: SHARE, then UPLOAD.'}</div>`;
    };
    draw();
    $('#q').oninput = e => { S.q = e.target.value; draw(); };
    $('#sort').onchange = e => { S.sort = e.target.value; keep.set('ecg.sort', S.sort, true); draw(); };
    $$('[data-f]').forEach(b => { b.onclick = () => { S.filter = b.dataset.f; keep.set('ecg.filter', S.filter, true); draw(); }; });
    $('#pdfs').onclick = () => zipReports(S.shown || []);
    $('#csv').onclick = () => register(S.shown || []);
  }
  function register(recs) {
    const head = ['Recording', 'Name or code', 'Age', 'Sex', 'Recorded', 'AI result', 'Score', 'Refer limit', 'Heart rate (/min)',
      'Signal', 'Noise on', 'Duration (s)', 'Clean beats', 'Reviewed', 'Note', 'In the bin', 'Folder'];
    const rows = recs.map(r => [r.id, val(r.id, 'label'), val(r.id, 'age'), SEX[val(r.id, 'sex')] || '', when(r), r.result,
      r.score === null || r.score === undefined ? '' : (+r.score).toFixed(3), r.thr === null || r.thr === undefined ? '' : (+r.thr).toFixed(3),
      r.hr ? Math.round(r.hr) : '', r.grade || '', (r.noisy || []).join(' '), r.dur ?? '', r.total ? `${r.clean} of ${r.total}` : '',
      val(r.id, 'reviewed') ? 'yes' : 'no', val(r.id, 'note'), val(r.id, 'deleted') ? 'yes' : 'no', r.folder]);
    saveAs(csv(head, rows), `ECG_register_${today()}.csv`);
    toast(`Register of ${recs.length} recording${recs.length === 1 ? '' : 's'} downloaded.`);
  }
  async function zipReports(recs) {
    if (!recs.length) return;
    const out = [];
    try {
      for (let i = 0; i < recs.length; i++) {
        toast(`Preparing the reports… ${i + 1} of ${recs.length}`);
        out.push({ name: `${base(recs[i])}.pdf`, data: await B.bytes(recs[i], 'report.pdf') });
      }
      saveAs(zip(out), `ECG_reports_${today()}.zip`);
      toast(`${out.length} report${out.length === 1 ? '' : 's'} downloaded.`);
    } catch (e) { toast(why(e), true); }
  }

  // ------------------------------------------------------------------ one recording
  const say = c => {
    const q = x => (x === '' || x === undefined || x === null ? '–' : `“${esc(x)}”`);
    switch (c.what) {
      case 'label': return c.to ? (c.from ? `Name or code ${q(c.from)} → ${q(c.to)}` : `Name or code set to ${q(c.to)}`) : `Name or code ${q(c.from)} cleared`;
      case 'age': return c.to ? `Age ${c.from ? `${esc(c.from)} → ` : 'set to '}${esc(c.to)}` : 'Age cleared';
      case 'sex': return c.to ? `Sex ${c.from ? `${esc(SEX[c.from] || c.from)} → ` : 'set to '}${esc(SEX[c.to] || c.to)}` : 'Sex cleared';
      case 'note': return c.to ? (c.from ? `Note changed to ${q(c.to)}` : `Note added: ${q(c.to)}`) : 'Note cleared';
      case 'reviewed': return c.to ? 'Marked reviewed' : 'Marked not reviewed';
      case 'deleted': return c.to ? `Moved to the bin${c.reason ? `: ${q(c.reason)}` : ''}` : 'Restored from the bin';
      case 'uploaded': return 'Uploaded from the device';
      default: return esc(c.what);
    }
  };
  const byline = c => `${esc(c.by || (c.where === 'device' ? 'The device' : 'Someone'))} · ${esc(PLACE[c.where] || c.where || '')} · ${esc(stamp(c.at))}`;
  const tone = c => (c.what === 'deleted' && c.to ? 'del' : c.what === 'uploaded' ? 'up' : '');
  const plain = c => say(c).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  async function viewDetail(id) {
    const r = (S.index.recordings || []).find(x => x.id === id);
    document.title = `${id} – ECG Records`;
    if (!r) {
      $('#main').innerHTML = `<a class="back" href="#/">${I.back}All recordings</a><div class="empty">${esc(id)} is not ${DEV ? 'on the device' : 'in the online records'}.</div>`;
      return;
    }
    const del = val(id, 'deleted'), dc = del ? lastOf(id, 'deleted') : null, name = val(id, 'label');
    const hint = DEV ? `Saved on the device${S.online && S.online.configured ? '; the online records take it soon if this Wi-Fi reaches the internet, else at the next UPLOAD' : ''}.`
      : 'Saved online at once; the device takes it at its next UPLOAD, or soon while its phone page is on.';
    const hist = S.changes.filter(c => c.rec === id).reverse();
    $('#main').innerHTML = `
      <a class="back" href="#/">${I.back}All recordings</a>
      <section class="head">
        <div><h1><span class="id">${esc(id)}</span>${chip(r.result, r.tone)}${sigChip(r)}${val(id, 'reviewed') ? `<span class="chip green">${I.check}REVIEWED</span>` : ''}${r.test ? '<i class="tag">test</i>' : ''}</h1>
          <p class="muted">${name ? `<b class="who">${esc(name)}</b>${demo(id) ? ` (${esc(demo(id))})` : ''} · ` : ''}${esc(when(r))} · ${fmt(r.dur, 0, ' s')}${r.early ? ' (stopped early)' : ''} · ${esc(r.clean ?? '–')} of ${esc(r.total ?? '–')} beats clean${r.online === false ? ' · not online yet' : ''}</p></div>
        <div class="acts"><button class="btn primary" id="open">${I.doc}<span>Open report</span></button>
          <button class="btn" id="pdf">${I.down}<span>PDF</span></button>
          <button class="btn" id="all" title="Report, ECG data, checksums and the details, as one ZIP">${I.down}<span>All files</span></button>
          ${del ? '' : `<button class="btn danger" id="del">${I.trash}<span>Delete</span></button>`}</div>
      </section>
      ${del ? `<div class="banner bad">${I.trash}<div><b>In the bin</b>${dc ? ` since ${esc(stamp(dc.at))}, by ${esc(dc.by || 'someone')} on the ${esc(PLACE[dc.where] || dc.where)}${dc.reason ? `: “${esc(dc.reason)}”` : ''}` : ''}. Hidden from the list; the report and data are kept.</div>
        <button class="btn" id="restore">${I.restore}<span>Restore</span></button></div>` : ''}
      ${S.pending ? '<div class="banner info"><div>New changes came from elsewhere. They show once you save or undo.</div></div>' : ''}
      <form class="card detf" id="df" autocomplete="off">
        <div class="card-h"><h2>Details</h2><span class="muted small">${hist.find(c => c.what !== 'uploaded') ? `Last change ${esc(ago(hist.find(c => c.what !== 'uploaded').at))}` : 'Not filled in yet'}</span></div>
        <label class="f-name"><span>Name or code</span><input id="f-label" maxlength="40" placeholder="Name or code" spellcheck="false"></label>
        <label class="f-age"><span>Age</span><input id="f-age" inputmode="numeric" maxlength="3" placeholder="Years"></label>
        <label class="f-sex"><span>Sex</span><select id="f-sex"><option value="">–</option><option value="F">Female</option><option value="M">Male</option><option value="O">Other</option></select></label>
        <label class="check f-rev"><input type="checkbox" id="f-reviewed"><span>Reviewed by a doctor</span></label>
        <label class="f-note"><span>Note</span><textarea id="f-note" maxlength="200" rows="2" placeholder="Optional"></textarea></label>
        <p class="msg" id="dmsg">${esc(hint)} Downloads are named with the name or code.</p>
        <div class="f-act"><button class="btn" type="button" id="undo" hidden>Undo</button><button class="btn primary" type="submit" id="save" disabled>Save</button></div>
      </form>
      <section class="grid">
        <div>
          <div class="card"><div class="card-h"><h2>ECG</h2><div class="segnav"><button type="button" class="btn sm" id="sp" aria-label="Earlier 10 s">‹</button><select id="ss" aria-label="Which 10 seconds"></select><button type="button" class="btn sm" id="sn" aria-label="Later 10 s">›</button></div></div>
            <div class="paper" id="paper"><canvas id="cv" aria-label="ECG of ${esc(id)}"></canvas><div class="loading" id="ecgl">Loading the ECG${r.files && r.files['ecg_7lead_500hz_mv.csv'] ? ` (${mb(r.files['ecg_7lead_500hz_mv.csv'])})` : ''}…</div></div>
            <p class="cap">Leads I, II and V2 measured; III, aVR, aVL and aVF derived · 0.5–40 Hz · 25 mm/s · 10 mm/mV · the first mark of each lead is 1 mV</p></div>
          <div class="card" id="expl"><h2>Explanation, as on the device</h2><p class="loading">…</p></div>
        </div>
        <div>
          <div class="card" id="ai"><h2>AI result</h2><p class="loading">…</p></div>
          <div class="card" id="meas"><h2>Measurements</h2><p class="loading">…</p></div>
          <div class="card" id="qual"><h2>Signal</h2><p class="loading">…</p></div>
          <div class="card" id="hist"><div class="card-h"><h2>History</h2><a class="small" href="#/activity">All activity</a></div>
            ${hist.length ? `<ul class="hist">${hist.slice(0, 60).map(c => `<li class="${tone(c)}"><div>${say(c)}</div><small>${byline(c)}</small></li>`).join('')}</ul>`
    : '<p class="muted small">No changes yet.</p>'}</div>
        </div>
      </section>`;
    $('#open').onclick = () => openPdf(r);
    $('#pdf').onclick = () => pdfDownload(r);
    $('#all').onclick = () => zipOne(r);
    if ($('#del')) $('#del').onclick = () => askDelete(r);
    if ($('#restore')) $('#restore').onclick = () => edit(r.id, { deleted: false }, '', `${r.id} restored.`);
    detailsForm(r);
    let rep = S.reports[r.folder];
    if (!rep) {
      try { rep = S.reports[r.folder] = JSON.parse(await B.text(r, 'report.json')); } catch (e) { if ($('#ai')) $('#ai').innerHTML = `<h2>AI result</h2><p class="muted">${esc(why(e))}</p>`; }
    }
    if (rep && $('#ai')) cards(r, rep);
    try {
      const E = S.ecgs[r.folder] || (S.ecgs[r.folder] = parseCSV(await B.text(r, 'ecg_7lead_500hz_mv.csv')));
      if ($('#cv')) ecgView(r, rep, E);
    } catch (e) { if ($('#ecgl')) $('#ecgl').textContent = why(e); }
  }
  function detailsForm(r) {
    const F = { label: $('#f-label'), age: $('#f-age'), sex: $('#f-sex'), note: $('#f-note'), reviewed: $('#f-reviewed') };
    const orig = {};
    for (const [f, el] of Object.entries(F)) { orig[f] = val(r.id, f); if (f === 'reviewed') el.checked = orig[f]; else el.value = orig[f]; }
    const cur = () => Object.fromEntries(Object.entries(F).map(([f, el]) => [f, f === 'reviewed' ? el.checked : el.value]));
    const diff = () => { const c = cur(), d = {}; for (const f of Object.keys(F)) if ((f === 'reviewed' ? c[f] : c[f].trim()) !== (f === 'reviewed' ? orig[f] : String(orig[f]).trim())) d[f] = c[f]; return d; };
    const m = $('#dmsg'), save = $('#save'), undo = $('#undo');
    const hint = m.textContent;
    const sync = () => { const n = Object.keys(diff()).length; S.dirty = n > 0; save.disabled = !n; undo.hidden = !n; if (m.className !== 'msg') { m.textContent = hint; m.className = 'msg'; } };
    $('#df').oninput = sync; $('#df').onchange = sync;
    undo.onclick = () => { S.dirty = false; if (S.pending) { S.pending = false; render(true); return; } for (const [f, el] of Object.entries(F)) { if (f === 'reviewed') el.checked = orig[f]; else el.value = orig[f]; } sync(); };
    $('#df').onsubmit = async ev => {
      ev.preventDefault();
      const [clean, bad] = cleanFields(diff());
      if (!clean) { m.textContent = bad; m.className = 'msg bad'; return; }
      if (!Object.keys(clean).length) return;
      if (!(await askName())) return;
      save.disabled = true; m.textContent = 'Saving…'; m.className = 'msg';
      const ok = await edit(r.id, clean, '', null);
      if (!ok) { save.disabled = false; m.textContent = 'Not saved. Try again.'; m.className = 'msg bad'; }
    };
  }
  async function edit(rec, fields, reason, done) {   // -> true once saved (the page is drawn again with it)
    if (!(await askName())) return false;
    S.busy = true;
    try {
      const n = await B.edit(rec, fields, reason);
      S.dirty = false; S.pending = false;
      render(true);
      toast(done || (n ? (DEV ? 'Saved on the device.' : 'Saved online.') : 'Nothing to change.'));
      return true;
    } catch (e) { toast(why(e), true); return false; } finally { S.busy = false; }
  }
  async function askDelete(r) {
    if (!(await askName())) return;
    modal({
      title: `Delete ${r.id}?`, ok: 'Move to the bin', danger: true,
      html: `<p>It goes to the bin on the device, its phone page and the website, and leaves the list. Nothing is erased: the report and data are kept, and it can be restored from the Bin.</p>
        <label><span>Reason, written in the history</span><input id="m-why" list="m-whys" maxlength="120" placeholder="For example: duplicate recording"></label>
        <datalist id="m-whys"><option value="Duplicate recording"><option value="Test or practice recording"><option value="Wrong person or details"><option value="Poor signal, recorded again"></datalist>`,
      onOk: async w => { await edit(r.id, { deleted: true }, $('#m-why', w).value, `${r.id} moved to the bin.`); return true; },
    });
  }

  function cards(r, rep) {
    const v1 = rep.v1 || {}, m = rep.measured || {}, iv = rep.intervals || {}, q = rep.quality || {}, f = rep.findings || {};
    const thr = +v1.threshold || +r.thr || 0.2374, heads = v1.heads || {};
    const pct = x => Math.max(0, Math.min(100, x * 100)).toFixed(1);
    $('#ai').innerHTML = `<h2>AI result</h2>
      <div class="verdict ${esc(r.tone)}"><b>${esc(r.result)}</b><span>score ${fmt(v1.median ?? r.score, 3)} · refers at ≥ ${fmt(thr, 3)}</span></div>
      <div class="heads">${HEADS.map(([k, t]) => {
    const v = +heads[k] || 0;
    return `<div class="hd"><span>${t}</span><span class="v">${fmt(heads[k], 3)}</span><div class="meter"><i class="${v >= thr ? 'over' : ''}" data-w="${pct(v)}"></i><b data-l="${pct(thr)}"></b></div></div>`;
  }).join('')}</div>
      <p class="note">${heads.NORM !== undefined ? `Normal-ECG likeness ${fmt(heads.NORM, 2)} (not used in the decision). ` : ''}The mark is the refer limit. The AI screens for myocardial infarction, ischaemic ST-T change and wide QRS only; it does not exclude other heart disease.</p>`;
    $$('#ai [data-w]').forEach(e => { e.style.width = `${e.dataset.w}%`; });
    $$('#ai [data-l]').forEach(e => { e.style.left = `${e.dataset.l}%`; });
    const regular = m.rr_cv !== undefined && m.rr_cv !== null ? (m.rr_cv < 0.1 ? ', regular' : ', irregular') : '';
    const fx = [];
    const L = a => (a || []).map(x => (typeof x === 'string' ? x : (x.lead || x[0] || ''))).join(', ');
    if ((f.st_elev || []).length) fx.push(`ST elevation: ${L(f.st_elev)}`);
    if ((f.st_dep || []).length) fx.push(`ST depression: ${L(f.st_dep)}`);
    if ((f.t_inv || []).length) fx.push(`T-wave inversion: ${L(f.t_inv)}`);
    if ((f.q_path || []).length) fx.push(`Pathological Q waves: ${L(f.q_path)}`);
    if (f.wide) fx.push('Wide QRS');
    if (f.p_absent) fx.push('P wave not found');
    const st = m.st || {}, st60 = m.st60 || {}, tw = m.t || {};
    $('#meas').innerHTML = `<h2>Measurements</h2>
      <dl class="kv"><dt>Heart rate</dt><dd>${fmt(m.hr, 0, ' /min')}${regular}</dd>
        <dt>PR</dt><dd>${fmt(iv.pr_ms, 0, ' ms')}</dd><dt>QRS</dt><dd>${fmt(iv.qrs_ms ?? m.qrs_ms, 0, ' ms')}</dd>
        <dt>QT</dt><dd>${fmt(iv.qt_ms, 0, ' ms')}</dd><dt>QTc</dt><dd>${fmt(iv.qtc_fridericia_ms, 0, ' ms')} <span class="muted">(Fridericia)</span></dd></dl>
      <table class="st"><thead><tr><th>Lead</th><th>ST at J (mm)</th><th>ST J+60 (mm)</th><th>T (mV)</th></tr></thead><tbody>
      ${['I', 'II', 'III', 'AVR', 'AVL', 'AVF', 'V2'].map(k => `<tr><td>${k.replace('AV', 'aV')}</td><td>${st[k] === undefined ? '–' : (st[k] > 0 ? '+' : '') + fmt(st[k], 1)}</td><td>${st60[k] === undefined ? '–' : (st60[k] > 0 ? '+' : '') + fmt(st60[k], 1)}</td><td>${fmt(tw[k], 2)}</td></tr>`).join('')}
      </tbody></table>
      ${fx.length ? `<ul class="fx">${fx.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="note">No measured ST, T or Q abnormality.</p>'}
      <p class="note">Measured on the clean beats of this recording. The millimetre values assume the device's scale.</p>`;
    const nz = q.noise_index_uv || {};
    $('#qual').innerHTML = `<h2>Signal</h2>
      <dl class="kv"><dt>Quality</dt><dd>${esc((q.grade || '–').toLowerCase())}${(q.noisy_leads || r.noisy || []).length ? ` · noise on ${esc((q.noisy_leads || r.noisy).join(', '))}` : ''}</dd>
        <dt>AI windows</dt><dd>${esc(v1.windows_readable ?? '–')} of ${esc(v1.windows_inside ?? '–')} readable</dd>
        <dt>Beats</dt><dd>${esc(r.clean ?? '–')} of ${esc(r.total ?? '–')} clean</dd>
        <dt>Noise index</dt><dd>${['I', 'II', 'V2'].map(k => `${k} ${fmt(nz[k], 1)}`).join(' · ')} <span class="muted">(fair from 7.5)</span></dd>
        <dt>Electrodes off</dt><dd>${(q.leads_off || []).length ? esc(q.leads_off.join(', ')) : 'none'}</dd></dl>`;
    $('#expl').innerHTML = `<h2>Explanation, as on the device</h2><pre class="lines">${esc((rep.explanation || []).join('\n') || '–')}</pre>`;
  }

  // ------------------------------------------------------------------ the ECG on paper
  function parseCSV(text) {
    const lines = text.split('\n'), head = lines[0].trim().split(','), n = lines.length - 1;
    const cols = head.map(() => new Float32Array(Math.max(0, n)));
    let k = 0;
    for (let i = 1; i < lines.length; i++) {
      const s = lines[i]; if (!s) continue;
      const v = s.split(',');
      for (let j = 0; j < head.length; j++) cols[j][k] = +v[j];
      k++;
    }
    const out = {}; head.forEach((h, j) => { out[h] = cols[j].subarray(0, k); });
    return out;
  }
  function ecgView(r, rep, E) {
    const t = E.t_s || new Float32Array(0), dur = t.length ? t[t.length - 1] : (r.dur || 10);
    const opts = [], p1 = rep && rep.page1;
    if (p1 && p1.t1 > p1.t0) opts.push([p1.t0, 'Clearest 10 s', 'best']);
    for (let s = 0; s + 9.9 <= dur + 0.01; s += 10) opts.push([s, `${s}–${s + 10} s`, `s${s}`]);
    if (!opts.length) opts.push([0, '0–10 s', 's0']);
    let i = Math.max(0, opts.findIndex(o => o[2] === S.seg[r.folder]));
    const sel = $('#ss');
    sel.innerHTML = opts.map(([, l], k) => `<option value="${k}">${l}</option>`).join('');
    const draw = () => {
      sel.value = String(i); S.seg[r.folder] = opts[i] ? opts[i][2] : 0;
      $('#sp').disabled = i <= 0; $('#sn').disabled = i >= opts.length - 1;
      drawECG($('#cv'), E, opts[i] ? opts[i][0] : 0);
    };
    sel.onchange = () => { i = +sel.value; draw(); };
    $('#sp').onclick = () => { if (i > 0) { i--; draw(); } };
    $('#sn').onclick = () => { if (i < opts.length - 1) { i++; draw(); } };
    S.draw = draw;
    if ($('#ecgl')) $('#ecgl').remove();
    draw();
  }
  function drawECG(cv, E, t0) {
    if (!cv) return;
    const W = 262, ROW = 21, H = ROW * LEADS.length + 4;
    const px = Math.max(3, (cv.parentElement.clientWidth - 2) / W), dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * px * dpr); cv.height = Math.round(H * px * dpr);
    cv.style.width = `${W * px}px`; cv.style.height = `${H * px}px`;
    const g = cv.getContext('2d'), css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
    g.setTransform(px * dpr, 0, 0, px * dpr, 0, 0);
    g.fillStyle = col('--paper'); g.fillRect(0, 0, W, H);
    const grid = (step, w, c) => {
      g.beginPath(); g.lineWidth = w / px; g.strokeStyle = c;
      for (let x = 0; x <= W + 0.01; x += step) { g.moveTo(x, 0); g.lineTo(x, H); }
      for (let y = 0; y <= H + 0.01; y += step) { g.moveTo(0, y); g.lineTo(W, y); }
      g.stroke();
    };
    grid(1, 0.8, col('--grid1')); grid(5, 1.3, col('--grid5'));
    const t = E.t_s, fs = t && t.length > 1 ? 1 / (t[1] - t[0]) : 500, s0 = Math.round(t0 * fs), n = Math.round(10 * fs);
    const ink = col('--trace');
    g.font = '600 3.3px system-ui, -apple-system, Segoe UI, sans-serif'; g.lineJoin = 'round'; g.lineCap = 'round';
    LEADS.forEach(([k, label], i) => {
      const y0 = 2 + ROW * i + ROW * 0.62, v = E[k];
      g.beginPath(); g.lineWidth = Math.max(1.5 / px, 0.24); g.strokeStyle = ink;
      g.moveTo(1, y0); g.lineTo(2.5, y0); g.lineTo(2.5, y0 - 10); g.lineTo(7.5, y0 - 10); g.lineTo(7.5, y0); g.lineTo(9.5, y0); g.stroke();
      g.fillStyle = ink; g.fillText(label, 11, 2 + ROW * i + 4.2);
      if (!v) return;
      g.beginPath();
      for (let j = 0; j < n && s0 + j < v.length; j++) {
        const x = 10 + (j / fs) * 25, y = y0 - Math.max(-1.25, Math.min(1.7, v[s0 + j])) * 10;
        if (j) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
    });
  }
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => S.draw && $('#cv') && S.draw(), 150); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => S.draw && $('#cv') && S.draw());

  // ------------------------------------------------------------------ files
  const fileUrl = (r, f, dl) => `/f/${enc(r.folder)}/${enc(f)}${dl ? '?dl=1' : ''}`;
  async function openPdf(r) {
    if (DEV) { window.open(fileUrl(r, 'report.pdf'), '_blank', 'noopener'); return; }
    const w = window.open('', '_blank');
    try {
      const b = new Blob([await B.bytes(r, 'report.pdf')], { type: 'application/pdf' });
      if (w) w.location.href = URL.createObjectURL(b); else saveAs(b, `${base(r)}.pdf`);
    } catch (e) { if (w) w.close(); toast(why(e), true); }
  }
  async function pdfDownload(r) {
    if (DEV) { const a = document.createElement('a'); a.href = fileUrl(r, 'report.pdf', true); a.download = `${base(r)}.pdf`; document.body.appendChild(a); a.click(); a.remove(); return; }
    try { saveAs(new Blob([await B.bytes(r, 'report.pdf')], { type: 'application/pdf' }), `${base(r)}.pdf`); } catch (e) { toast(why(e), true); }
  }
  function detailsText(r) {
    const h = S.changes.filter(c => c.rec === r.id);
    return `Recording: ${r.id}\nFolder: ${r.folder}\nName or code: ${val(r.id, 'label')}\nAge: ${val(r.id, 'age')}\nSex: ${SEX[val(r.id, 'sex')] || ''}\n`
      + `Note: ${val(r.id, 'note')}\nReviewed: ${val(r.id, 'reviewed') ? 'yes' : 'no'}\nIn the bin: ${val(r.id, 'deleted') ? 'yes' : 'no'}\n`
      + `\nHistory (UTC):\n${h.map(c => `${c.at}  ${plain(c)}  (${c.by || '-'}, ${c.where || '-'})`).join('\n') || '-'}\n`;
  }
  async function zipOne(r) {
    const names = Object.keys(r.files || {}).length ? Object.keys(r.files) : ['report.pdf', 'report.json', 'report.txt', 'ecg_7lead_500hz_mv.csv', 'SHA256SUMS'];
    const out = [], b = base(r);
    try {
      for (let i = 0; i < names.length; i++) {
        toast(`Preparing ${r.id}… ${i + 1} of ${names.length} files`);
        out.push({ name: `${b}/${names[i]}`, data: await B.bytes(r, names[i]) });
      }
      out.push({ name: `${b}/details_and_history.txt`, data: new TextEncoder().encode(detailsText(r)) });
      saveAs(zip(out), `${b}.zip`);
      toast(`${r.id}: ${out.length} files downloaded.`);
    } catch (e) { toast(why(e), true); }
  }

  // ------------------------------------------------------------------ activity: every change, newest first
  function viewActivity() {
    document.title = 'Activity – ECG Records';
    $('#main').innerHTML = `
      <section class="head"><div><h1>Activity</h1><p class="muted">Every change to the details, newest first: what, who, where and when. Lines are only ever added.</p></div>
        <div class="acts"><button class="btn" id="acsv">${I.table}<span>Download (CSV)</span></button></div></section>
      <section class="tools"><input id="aq" type="search" placeholder="Search recording, name, change or person" value="${esc(S.aq)}" aria-label="Search the activity"></section>
      <section class="card act" id="alist"></section>`;
    const draw = () => {
      const q = S.aq.trim().toLowerCase();
      const list = [...S.changes].reverse().filter(c => !q || `${c.rec} ${val(c.rec, 'label')} ${plain(c)} ${c.by} ${c.where}`.toLowerCase().includes(q));
      let day = '', h = '';
      for (const c of list.slice(0, 500)) {
        const t = Date.parse(c.at), d = t ? new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : '–';
        if (d !== day) { day = d; h += `<h3 class="day">${esc(d)}</h3>`; }
        h += `<div class="ev ${tone(c)}"><span class="t">${t ? esc(new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })) : ''}</span>
          <a href="#/r/${esc(c.rec)}">${esc(c.rec)}</a><div>${say(c)}${val(c.rec, 'label') ? ` <span class="muted">· ${esc(val(c.rec, 'label'))}</span>` : ''}
          <small>${esc(c.by || (c.where === 'device' ? 'The device' : 'Someone'))} · ${esc(PLACE[c.where] || c.where || '')}</small></div></div>`;
      }
      $('#alist').innerHTML = h || `<div class="empty">${S.changes.length ? 'Nothing matches.' : 'No changes yet.'}</div>`;
      $('#acsv').disabled = !list.length;
    };
    draw();
    $('#aq').oninput = e => { S.aq = e.target.value; draw(); };
    $('#acsv').onclick = () => {
      const rows = [...S.changes].reverse().map(c => [c.at, c.rec, val(c.rec, 'label'), plain(c), typeof c.from === 'boolean' ? (c.from ? 'yes' : 'no') : c.from,
        typeof c.to === 'boolean' ? (c.to ? 'yes' : 'no') : c.to, c.reason || '', c.by || '', c.where || '', c.id]);
      saveAs(csv(['When (UTC)', 'Recording', 'Name or code now', 'Change', 'From', 'To', 'Reason', 'Who', 'Where', 'Change id'], rows), `ECG_activity_${today()}.csv`);
    };
  }

  // ------------------------------------------------------------------ routing, live updates
  function render(soft) {
    const y = window.scrollY;
    const h = location.hash;
    $('#n-list') && $('#n-list').classList.toggle('on', !h.startsWith('#/activity'));
    $('#n-act') && $('#n-act').classList.toggle('on', h.startsWith('#/activity'));
    drawStatus();
    const m = /^#\/r\/(R\d{4,})/.exec(h);
    if (m) viewDetail(m[1]); else if (h.startsWith('#/activity')) viewActivity(); else viewList();
    window.scrollTo(0, soft ? y : 0);
  }
  async function go() {
    if (!DEV && (!S.key || !S.repo)) return viewSignIn();
    S.draw = null; S.dirty = false; S.pending = false;
    if (!$('#main')) shell();
    if (!S.index) {
      $('#main').innerHTML = '<div class="loading">Loading the records…</div>';
      try { await load(); } catch (e) { return fail(e); }
      poll();
    }
    render(false);
  }
  let pollT = 0;
  function poll(delay) {
    clearTimeout(pollT);
    pollT = setTimeout(async () => {
      if (!document.hidden && S.index && !S.busy && (DEV || S.key)) {
        try {
          const v = await B.version();
          if (v !== S.head) {
            const add = await load(true);
            if (S.dirty) { S.pending = true; if (!$('.banner.info') && $('#df')) $('#df').insertAdjacentHTML('beforebegin', '<div class="banner info"><div>New changes came from elsewhere. They show once you save or undo.</div></div>'); drawStatus(); }
            else render(true);
            const ext = add.filter(c => c.what !== 'uploaded');
            if (ext.length === 1) toast(`${ext[0].rec}: ${plain(ext[0])} (${ext[0].by || 'someone'}, ${PLACE[ext[0].where] || ext[0].where}).`);
            else if (ext.length > 1) toast(`${ext.length} new changes from elsewhere.`);
            else if (add.length) toast(`${add.length} recording${add.length === 1 ? '' : 's'} uploaded from the device.`);
          } else drawStatus();
        } catch (e) {
          if (DEV && e.status === 0) { S.gone = true; drawStatus(); }
          else if (DEV && e.status === 403) location.reload();
          else if (!DEV && e.status === 401) fail(e);
        }
      }
      poll();
    }, delay ?? (DEV ? 8000 : 30000));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.index) poll(300); });
  document.addEventListener('click', e => {           // leaving a recording with unsaved details: ask first
    const a = e.target.closest && e.target.closest('a[href^="#/"]');
    if (!a || !S.dirty) return;
    e.preventDefault();
    modal({ title: 'Leave without saving?', ok: 'Leave', danger: true, html: '<p>The details you changed are not saved.</p>',
      onOk: () => { S.dirty = false; location.hash = a.getAttribute('href'); return true; } });
  }, true);
  addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  addEventListener('keydown', e => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '') && ($('#q') || $('#aq'))) { e.preventDefault(); ($('#q') || $('#aq')).focus(); }
  });
  addEventListener('hashchange', () => { if (!DEV && (!S.key || !S.repo)) return viewSignIn(); S.draw = null; S.dirty = false; S.pending = false; if (!$('#main')) return go(); render(false); });
  go();
})();
