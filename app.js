/* ECG Records -- the website of the ECG device's online records.
 * No server of its own: it reads the private records repository (<organisation>/ecg-records) straight from the GitHub
 * API with the viewer's access key, which stays in this browser. The device writes the records (SHARE -> UPLOAD):
 * recordings/<folder>/..., index.json (the list) and labels.json (names and notes, edited here or on the device). */
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
  const ORG = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : '';
  const S = {
    api: keep.get('ecg.api') || 'https://api.github.com',
    repo: keep.get('ecg.repo') || (ORG ? `${ORG}/ecg-records` : ''),
    key: keep.get('ecg.key') || '',
    index: null, labels: {}, reports: {}, ecgs: {}, filter: 'all', q: '', draw: null,
  };
  (() => {                                   // a sign-in link (#key=...&repo=...): sign in, then a clean address bar
    const f = new URLSearchParams(location.hash.slice(1));
    if (!f.get('key')) return;
    S.key = f.get('key');
    keep.set('ecg.key', S.key, true);
    if (f.get('repo')) { S.repo = f.get('repo'); keep.set('ecg.repo', S.repo, true); }
    history.replaceState(null, '', location.pathname + '#/');
  })();

  const I = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/></svg>',
    redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  };
  const LOGO = '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8"/><path d="M4 17h6l2.2-5 3 11 3.2-15 2.8 9H28"/></svg>';
  const HEADS = [['MI_ANY', 'Myocardial infarction (any)'], ['MI_ACUTE', 'Acute MI'], ['MI_OLD', 'Old MI'],
    ['ISCH_STT', 'Ischaemic ST-T change'], ['CD_WIDE', 'Wide QRS (conduction)'], ['MI_CD', 'MI with conduction delay']];
  const LEADS = [['I', 'I'], ['II', 'II'], ['III', 'III'], ['aVR', 'aVR'], ['aVL', 'aVL'], ['aVF', 'aVF'], ['V2', 'V2']];
  const FILTERS = [['all', 'All'], ['REFER', 'Refer'], ['NOT NORMAL', 'Not normal'], ['NO REFER', 'No refer'], ['NO AI RESULT', 'No result']];

  // ------------------------------------------------------------------ GitHub
  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  async function gh(path, { method = 'GET', body, raw = false } = {}) {
    let r;
    try {
      r = await fetch(`${S.api}/repos/${S.repo}${path}`, {
        method, cache: 'no-store', body: body ? JSON.stringify(body) : undefined,
        headers: { Authorization: `Bearer ${S.key}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      });
    } catch (e) { const x = new Error('No connection. Check the internet, then try again.'); x.status = 0; throw x; }
    if (!r.ok) {
      const x = new Error(`GitHub answered ${r.status}.`); x.status = r.status;
      try { x.detail = (await r.json()).message; } catch (e) { /* */ }
      throw x;
    }
    return raw ? r : r.json();
  }
  const getText = async p => (await gh(`/contents/${enc(p)}`, { raw: true })).text();
  const getBytes = async p => new Uint8Array(await (await gh(`/contents/${enc(p)}`, { raw: true })).arrayBuffer());
  const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));
  const b64enc = s => { const b = new TextEncoder().encode(s); let x = ''; for (let i = 0; i < b.length; i += 0x8000) x += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(x); };
  const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const why = e => e.status === 401 ? 'This key is not valid (mistyped, revoked or expired). Sign in again.'
    : e.status === 404 ? `This key cannot open ${S.repo}. Check the records name and the key's repository access.`
      : e.status === 403 ? 'GitHub refused this: the key may only read, or the hourly limit was reached.'
        : e.status === 409 || e.status === 422 ? 'The records changed meanwhile. Try again.' : (e.message || 'Something went wrong.');

  async function load(force) {
    if (S.index && !force) return;
    const [idx, lab] = await Promise.all([
      getText('index.json').then(t => JSON.parse(t)).catch(e => { if (e.status === 404) return { recordings: [] }; throw e; }),
      gh('/contents/labels.json').catch(e => { if (e.status === 404) return null; throw e; }),
    ]);
    S.index = idx;
    S.labels = lab ? JSON.parse(b64dec(lab.content)) : {};
  }
  const nameOf = id => (S.labels[id] || {}).label || '';
  const noteOf = id => (S.labels[id] || {}).note || '';

  async function saveLabel(id, label, note) {   // the newer edit wins on the device too (it merges at its next UPLOAD)
    for (let i = 0; i < 4; i++) {
      let cur = null;
      try { cur = await gh('/contents/labels.json'); } catch (e) { if (e.status !== 404) throw e; }
      const all = cur ? JSON.parse(b64dec(cur.content)) : {};
      all[id] = { at: nowIso(), label, note };
      const sorted = Object.fromEntries(Object.keys(all).sort().map(k => [k, all[k]]));
      try {
        await gh('/contents/labels.json', { method: 'PUT', body: { message: `${label ? 'Name' : 'Name cleared'} for ${id} on the website`,
          content: b64enc(JSON.stringify(sorted, null, 1) + '\n'), ...(cur ? { sha: cur.sha } : {}) } });
        S.labels = sorted;
        return;
      } catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }
    }
    throw new Error('The records were busy. Try again.');
  }

  // ------------------------------------------------------------------ small helpers
  const num = id => parseInt(String(id).slice(1), 10) || 0;
  const chip = (t, tone) => `<span class="chip ${tone}">${esc(t)}</span>`;
  const sigChip = r => {
    const noisy = r.noisy || [];
    if (r.grade !== 'FAIR' && r.grade !== 'POOR' && !noisy.length) return '';
    return chip(`SIGNAL ${r.grade}${noisy.length ? ' · NOISE ' + noisy.join(' ') : ''}`, r.grade === 'POOR' ? 'red' : 'amber');
  };
  const when = r => { const m = /^(\d{1,2} \w{3} \d{4}) (\d{2}:\d{2})/.exec(r.when || ''); return m ? `${m[1]}, ${m[2]}` : (r.clock_ok === false ? 'Time not verified' : (r.when || '–')); };
  const ago = iso => {
    const t = Date.parse(iso || ''); if (!t) return 'Not yet';
    const s = (Date.now() - t) / 1000;
    if (s < 90) return 'Just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 172800) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const fmt = (v, d = 0, unit = '') => (v === null || v === undefined || Number.isNaN(+v)) ? '–' : `${(+v).toFixed(d)}${unit}`;
  const safe = s => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const base = r => (safe(nameOf(r.id)) ? `${r.id}_${safe(nameOf(r.id))}` : r.id);
  function toast(msg, bad) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.className = bad ? 'show bad' : 'show';
    clearTimeout(t.h); t.h = setTimeout(() => { t.className = ''; }, bad ? 6000 : 4200);
  }
  function saveAs(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
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

  // ------------------------------------------------------------------ the frame
  function shell(inner) {
    const org = S.repo.split('/')[0] || '';
    $('#app').innerHTML = `
      <header class="top"><div class="wrap bar">
        <a class="brand" href="#/">${LOGO}<span><b>ECG Records</b><small>${esc(org)}</small></span></a>
        <div class="grow"></div>
        <button class="btn ghost" id="reload" title="Load the latest records">${I.redo}<span>Refresh</span></button>
        <div class="menu"><button class="btn ghost" id="me" aria-haspopup="true" aria-expanded="false" title="Account">${I.user}</button>
          <div class="pop" id="pop" hidden><p class="muted small">Records: <b>${esc(S.repo)}</b></p>
            <button id="copy">Copy a sign-in link</button><button id="out">Sign out on this device</button></div></div>
      </div></header>
      <main class="wrap" id="main">${inner}</main>
      <footer class="wrap foot">For clinical assistance only – not a diagnostic device; a doctor confirms every result. The records are private and open only with a key.</footer>`;
    $('#reload').onclick = async () => { S.index = null; S.reports = {}; S.ecgs = {}; route(); };
    const pop = $('#pop'), me = $('#me');
    me.onclick = e => { e.stopPropagation(); pop.hidden = !pop.hidden; me.setAttribute('aria-expanded', String(!pop.hidden)); };
    document.onclick = () => { pop.hidden = true; me.setAttribute('aria-expanded', 'false'); };
    $('#copy').onclick = async () => {
      const link = `${location.origin}${location.pathname}#key=${encodeURIComponent(S.key)}&repo=${encodeURIComponent(S.repo)}`;
      try { await navigator.clipboard.writeText(link); toast('Sign-in link copied. Anyone with it can open the records: send it only to the doctors you choose.'); }
      catch (e) { toast('The browser did not allow copying here.', true); }
    };
    $('#out').onclick = () => { keep.del('ecg.key'); S.key = ''; S.index = null; route(); };
  }
  function fail(e) {
    if (e.status === 401) { keep.del('ecg.key'); S.key = ''; return viewSignIn(why(e)); }
    $('#main').innerHTML = `<div class="empty">${esc(why(e))}<br><button class="btn" id="again">Try again</button></div>`;
    $('#again').onclick = () => { S.index = null; route(); };
  }

  // ------------------------------------------------------------------ sign in
  function viewSignIn(err) {
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
      const go = $('#go');
      S.key = $('#k').value.trim(); S.repo = $('#rp').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
      go.disabled = true; go.textContent = 'Checking…'; $('#err').textContent = '';
      try {
        await gh('');
        keep.set('ecg.key', S.key, $('#long').checked); keep.set('ecg.repo', S.repo, true);
        S.index = null; route();
      } catch (e) { $('#err').textContent = why(e); go.disabled = false; go.textContent = 'Sign in'; }
    };
  }

  // ------------------------------------------------------------------ the list
  async function viewList() {
    shell('<div class="loading">Loading the records…</div>');
    try { await load(); } catch (e) { return fail(e); }
    const recs = [...(S.index.recordings || [])].sort((a, b) => num(b.id) - num(a.id));
    const count = t => recs.filter(r => r.result === t).length;
    $('#main').innerHTML = `
      <section class="tiles">
        <div class="tile"><span>Recordings</span><b>${recs.length}</b></div>
        <div class="tile red"><span>Refer</span><b>${count('REFER')}</b></div>
        <div class="tile amber"><span>Not normal</span><b>${count('NOT NORMAL')}</b></div>
        <div class="tile"><span>Last upload</span><b class="sm">${esc(ago(S.index.uploaded))}</b></div>
      </section>
      <section class="tools">
        <input id="q" type="search" placeholder="Search name, number, result or date" value="${esc(S.q)}" aria-label="Search">
        <div class="seg">${FILTERS.map(([k, t]) => `<button type="button" data-f="${esc(k)}" class="${S.filter === k ? 'on' : ''}">${t}</button>`).join('')}</div>
        <div class="grow"></div>
        <button class="btn" id="pdfs" ${recs.length ? '' : 'disabled'}>${I.down}<span>Reports (PDF)</span></button>
      </section>
      <section class="list" id="list"></section>`;
    const draw = () => {
      const q = S.q.trim().toLowerCase();
      const shown = recs.filter(r => (S.filter === 'all' || r.result === S.filter)
        && (!q || `${r.id} ${nameOf(r.id)} ${noteOf(r.id)} ${r.result} ${when(r)}`.toLowerCase().includes(q)));
      S.shown = shown;
      $('#list').innerHTML = shown.length
        ? '<div class="thead"><span>Recording</span><span>Name or code</span><span>Recorded</span><span>AI result</span><span>Heart rate</span></div>'
          + shown.map(r => `<a class="row" href="#/r/${esc(r.id)}">
            <span class="id">${esc(r.id)}${r.test ? '<i class="tag">test</i>' : ''}</span>
            <span class="nm">${nameOf(r.id) ? esc(nameOf(r.id)) : '<span class="muted">–</span>'}</span>
            <span class="dt">${esc(when(r))}</span>
            <span class="rs">${chip(r.result, r.tone)} ${sigChip(r)}</span>
            <span class="hr">${r.hr ? `${Math.round(r.hr)} /min` : '–'}</span></a>`).join('')
        : `<div class="empty">${recs.length ? 'Nothing matches the search.' : 'No recordings online yet. On the device: SHARE, then UPLOAD.'}</div>`;
    };
    draw();
    $('#q').oninput = e => { S.q = e.target.value; draw(); };
    $$('.seg button').forEach(b => { b.onclick = () => { S.filter = b.dataset.f; $$('.seg button').forEach(x => x.classList.toggle('on', x === b)); draw(); }; });
    $('#pdfs').onclick = () => zipReports(S.shown || recs);
  }

  async function zipReports(recs) {
    if (!recs.length) return;
    const out = [];
    try {
      for (let i = 0; i < recs.length; i++) {
        toast(`Preparing the reports… ${i + 1} of ${recs.length}`);
        out.push({ name: `${base(recs[i])}.pdf`, data: await getBytes(`recordings/${recs[i].folder}/report.pdf`) });
      }
      saveAs(zip(out), `ECG_reports_${new Date().toISOString().slice(0, 10)}.zip`);
      toast(`${out.length} report${out.length === 1 ? '' : 's'} downloaded.`);
    } catch (e) { toast(why(e), true); }
  }

  // ------------------------------------------------------------------ one recording
  async function viewDetail(id) {
    shell(`<div class="loading">Loading ${esc(id)}…</div>`);
    try { await load(); } catch (e) { return fail(e); }
    const r = (S.index.recordings || []).find(x => x.id === id);
    if (!r) { $('#main').innerHTML = `<a class="back" href="#/">${I.back}All recordings</a><div class="empty">${esc(id)} is not in the records.</div>`; return; }
    const dir = `recordings/${r.folder}/`;
    $('#main').innerHTML = `
      <a class="back" href="#/">${I.back}All recordings</a>
      <section class="head">
        <div><h1><span class="id">${esc(r.id)}</span>${chip(r.result, r.tone)}${sigChip(r)}${r.test ? '<i class="tag">test</i>' : ''}</h1>
          <p class="muted">${esc(when(r))} · ${fmt(r.dur, 0, ' s')}${r.early ? ' (stopped early)' : ''} · ${esc(r.clean ?? '–')} of ${esc(r.total ?? '–')} beats clean</p></div>
        <div class="acts"><button class="btn primary" id="open">${I.doc}<span>Open report</span></button>
          <button class="btn" id="pdf">${I.down}<span>PDF</span></button>
          <button class="btn" id="all" title="Report, ECG data and checksums as one ZIP">${I.down}<span>All files</span></button></div>
      </section>
      <form class="card namef" id="nf" autocomplete="off">
        <label><span>Name or code</span><input id="nm" maxlength="40" value="${esc(nameOf(r.id))}" placeholder="Name or code" spellcheck="false"></label>
        <label><span>Note</span><input id="nt" maxlength="120" value="${esc(noteOf(r.id))}" placeholder="Optional"></label>
        <button class="btn primary" type="submit" id="save">Save</button>
        <p class="msg" id="nmsg">Saved online at once; the device takes it at its next UPLOAD. Downloads are named with it.</p>
      </form>
      <section class="grid">
        <div>
          <div class="card"><div class="card-h"><h2>ECG</h2><div class="seg" id="segs"></div></div>
            <div class="paper" id="paper"><canvas id="cv" aria-label="ECG of ${esc(r.id)}"></canvas><div class="loading" id="ecgl">Loading the ECG…</div></div>
            <p class="cap">Leads I, II and V2 measured; III, aVR, aVL and aVF derived · 0.5–40 Hz · 25 mm/s · 10 mm/mV · the first mark of each lead is 1 mV</p></div>
          <div class="card" id="expl"><h2>Explanation, as on the device</h2><p class="loading">…</p></div>
        </div>
        <div>
          <div class="card" id="ai"><h2>AI result</h2><p class="loading">…</p></div>
          <div class="card" id="meas"><h2>Measurements</h2><p class="loading">…</p></div>
          <div class="card" id="qual"><h2>Signal</h2><p class="loading">…</p></div>
        </div>
      </section>`;
    $('#open').onclick = () => openPdf(r);
    $('#pdf').onclick = () => pdfDownload(r);
    $('#all').onclick = () => zipOne(r);
    $('#nf').onsubmit = async ev => {
      ev.preventDefault();
      const m = $('#nmsg'), b = $('#save'), label = $('#nm').value.replace(/\s+/g, ' ').trim(), note = $('#nt').value.replace(/\s+/g, ' ').trim();
      if (/[<>"\\/{}]/.test(label) || (label && !/[A-Za-z0-9]/.test(label))) { m.textContent = 'A name or code: up to 40 characters, without < > " / \\ { }.'; m.className = 'msg bad'; return; }
      b.disabled = true; m.textContent = 'Saving…'; m.className = 'msg';
      try { await saveLabel(r.id, label, note); m.textContent = 'Saved. The device takes it at its next UPLOAD.'; m.className = 'msg ok'; }
      catch (e) { m.textContent = why(e); m.className = 'msg bad'; }
      b.disabled = false;
    };
    let rep;
    try { rep = S.reports[r.folder] || (S.reports[r.folder] = JSON.parse(await getText(dir + 'report.json'))); }
    catch (e) { $('#ai').innerHTML = `<h2>AI result</h2><p class="muted">${esc(why(e))}</p>`; rep = null; }
    if (rep) cards(r, rep);
    try {
      const E = S.ecgs[r.folder] || (S.ecgs[r.folder] = parseCSV(await getText(dir + 'ecg_7lead_500hz_mv.csv')));
      ecgView(r, rep, E);
    } catch (e) { $('#ecgl').textContent = why(e); }
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
    const cols = head.map(() => new Float32Array(n));
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
    const opts = [];
    const p1 = rep && rep.page1;
    if (p1 && p1.t1 > p1.t0) opts.push([p1.t0, 'Clearest 10 s']);
    for (let s = 0; s + 9.9 <= dur + 0.01; s += 10) opts.push([s, `${s}–${s + 10} s`]);
    let cur = opts.length ? opts[0][0] : 0;
    $('#segs').innerHTML = opts.map(([s, l], i) => `<button type="button" data-t="${s}" class="${i ? '' : 'on'}">${l}</button>`).join('');
    $$('#segs button').forEach(b => { b.onclick = () => { cur = +b.dataset.t; $$('#segs button').forEach(x => x.classList.toggle('on', x === b)); draw(); }; });
    const draw = () => drawECG($('#cv'), E, cur);
    S.draw = draw;
    $('#ecgl').remove();
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
  async function pdfBlob(r) { return new Blob([await getBytes(`recordings/${r.folder}/report.pdf`)], { type: 'application/pdf' }); }
  async function openPdf(r) {
    const w = window.open('', '_blank');
    try {
      const b = await pdfBlob(r);
      if (w) w.location.href = URL.createObjectURL(b); else saveAs(b, `${base(r)}.pdf`);
    } catch (e) { if (w) w.close(); toast(why(e), true); }
  }
  async function pdfDownload(r) {
    try { saveAs(await pdfBlob(r), `${base(r)}.pdf`); } catch (e) { toast(why(e), true); }
  }
  async function zipOne(r) {
    const names = Object.keys(r.files || {}).length ? Object.keys(r.files) : ['report.pdf', 'report.json', 'report.txt', 'ecg_7lead_500hz_mv.csv', 'SHA256SUMS'];
    const out = [], b = base(r);
    try {
      for (let i = 0; i < names.length; i++) {
        toast(`Preparing ${r.id}… ${i + 1} of ${names.length} files`);
        out.push({ name: `${b}/${names[i]}`, data: await getBytes(`recordings/${r.folder}/${names[i]}`) });
      }
      if (nameOf(r.id) || noteOf(r.id)) out.push({ name: `${b}/name_and_note.txt`, data: new TextEncoder().encode(`Recording: ${r.id}\nName or code: ${nameOf(r.id)}\nNote: ${noteOf(r.id)}\n`) });
      saveAs(zip(out), `${b}.zip`);
      toast(`${r.id}: ${out.length} files downloaded.`);
    } catch (e) { toast(why(e), true); }
  }

  // ------------------------------------------------------------------ routing
  function route() {
    if (!S.key || !S.repo) return viewSignIn();
    S.draw = null;
    const m = /^#\/r\/(R\d{4,})/.exec(location.hash);
    if (m) viewDetail(m[1]); else viewList();
    window.scrollTo(0, 0);
  }
  addEventListener('hashchange', route);
  route();
})();
