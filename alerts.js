// CollectClock alerts: Web Push (background alerts), per-site opt-in, quiet hours, iPhone install hint,
// notification-click focus, and a floating countdown (Document PiP on desktop Chrome, video PiP elsewhere).
// Runs after the inline scripts in index.html and uses their globals (state, save, API, catalog, render, ...).
(function () {
  const EVERY = [5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440];
  const LEADS = [[0, 'Off'], [60, '1 min'], [30, '30 sec']];
  const tzName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
  const everyLabel = m => m < 60 ? `Every ${m} min` : m === 60 ? 'Every hour' : m === 1440 ? 'Every 24 hours' : `Every ${m / 60} hours`;
  const ios = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const iosVer = () => { const m = navigator.userAgent.match(/OS (\d+)_(\d+)/); return m ? Number(m[1]) + Number(m[2]) / 100 : null; };
  const pushCapable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  // ---------- state ----------
  function P() {
    state.push = state.push || {};
    const p = state.push;
    p.prefs = Object.assign({ lead: 60, quiet: { on: false, start: '23:00', end: '08:00' }, sites: {} }, p.prefs || {});
    p.prefs.quiet = Object.assign({ on: false, start: '23:00', end: '08:00' }, p.prefs.quiet || {});
    p.prefs.tz = tzName();
    return p;
  }
  let vapidKey = null, keyTried = false;
  async function loadKey() {
    if (keyTried) return vapidKey; keyTried = true;
    try { const r = await fetch(API + '/push/key'); vapidKey = (await r.json()).publicKey || null; } catch { keyTried = false; }
    return vapidKey;
  }
  const authH = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.session });
  let prefT = null;
  function savePrefs() {
    save();
    if (!state.session) return;
    clearTimeout(prefT);
    prefT = setTimeout(() => fetch(API + '/push/prefs', { method: 'PUT', headers: authH(), body: JSON.stringify({ prefs: P().prefs }) }).catch(() => {}), 800);
  }
  async function pullPrefs() {
    if (!state.session) return;
    try {
      const r = await fetch(API + '/push/prefs', { headers: authH() });
      if (!r.ok) return;
      const d = await r.json();
      // Signed in: the server copy wins, unless it is empty and this device already has picks.
      if (d.prefs && (Object.keys(d.prefs.sites || {}).length || !Object.keys(P().prefs.sites).length)) { P().prefs = Object.assign(P().prefs, d.prefs, { tz: tzName() }); save(); }
    } catch {}
  }
  const b64uToBytes = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };

  // ---------- turning alerts on / off (always from a tap) ----------
  async function turnOn() {
    if (!state.session) { if (confirm('Alerts follow your synced timers, so they need a Discord sign-in. Sign in now?')) discordLogin(); return; }
    // Ask for permission first and directly in the tap handler: Safari drops the request once the tap is "used up".
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { paint(); return; }
    try {
      const key = await loadKey();
      if (!key) { toast('Alerts are not set up on the server yet.'); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
      const r = await fetch(API + '/push/subscribe', { method: 'POST', headers: authH(), body: JSON.stringify({ subscription: sub.toJSON(), prefs: P().prefs }) });
      if (r.status === 401) { signOut(true); alert('Please sign in with Discord again.'); return; }
      if (!r.ok) { const d = await r.json().catch(() => ({})); toast(d.error || 'Could not turn alerts on.'); return; }
      P().on = true; P().endpoint = sub.endpoint; save();
      toast('Alerts are on for this device');
    } catch (e) { toast('Could not turn alerts on here.'); }
    paint();
  }
  async function turnOff() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const ep = (sub && sub.endpoint) || P().endpoint;
      if (sub) await sub.unsubscribe().catch(() => {});
      if (state.session && ep) await fetch(API + '/push/unsubscribe', { method: 'POST', headers: authH(), body: JSON.stringify({ endpoint: ep }) }).catch(() => {});
    } catch {}
    P().on = false; P().endpoint = null; save(); paint();
  }
  async function sendTest() {
    try {
      const r = await fetch(API + '/push/test', { method: 'POST', headers: authH() });
      const d = await r.json().catch(() => ({}));
      toast(d.ok ? 'Test sent. It should show up in a few seconds.' : (d.error || 'The test did not go through.'));
      if (d.removed) { P().on = false; save(); paint(); }
    } catch { toast('The test did not go through.'); }
  }
  // Keep the server's copy of this device's subscription current (browsers can rotate it).
  async function checkSub() {
    if (!P().on || !state.session || !pushCapable() || Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) { P().on = false; save(); return; }
      if (sub.endpoint !== P().endpoint) {
        await fetch(API + '/push/subscribe', { method: 'POST', headers: authH(), body: JSON.stringify({ subscription: sub.toJSON(), prefs: P().prefs }) });
        P().endpoint = sub.endpoint; save();
      }
    } catch {}
  }

  // ---------- styles + dialog ----------
  const css = document.createElement('style');
  css.textContent = `
.al-bell{width:44px;height:44px;border-radius:50%;border:2px solid var(--paper);background:transparent;color:var(--yellow);display:grid;place-items:center;padding:0;flex:none;margin-left:auto;margin-right:8px;font-size:1.15rem}.al-bell.on{background:var(--yellow);color:var(--ink)}
.al{padding:20px;display:grid;gap:14px;max-height:calc(100dvh - 40px);overflow:auto}.al h3{margin:0}.al p{margin:0}
.al-sec{display:grid;gap:8px;border-top:2px dashed var(--ink);padding-top:12px}.al-sec>b{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase}
.al-seg{display:flex;border:2px solid var(--ink);border-radius:999px;overflow:hidden;width:max-content;box-shadow:2px 2px 0 var(--ink)}.al-seg button{border:0;background:var(--paper);padding:7px 14px;font-weight:800;font-size:.85rem}.al-seg button+button{border-left:2px solid var(--ink)}.al-seg button.on{background:var(--ink);color:var(--yellow)}
.al-q{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:.88rem;font-weight:600}.al input[type=time],.al select,.al input[type=text],.al input[type=url],.al input[type=search]{font:inherit;font-size:.88rem;border:2px solid var(--ink);border-radius:10px;padding:6px 8px;background:#fff;color:var(--ink)}
.al-list{display:grid;gap:6px}.al-row{border:2px solid var(--ink);border-radius:12px;padding:8px 10px;background:var(--paper);display:grid;gap:8px}.al-row.on{background:#fff0f6}
.al-top{display:flex;align-items:center;justify-content:space-between;gap:10px;font-weight:700}.al-top span{min-width:0;overflow-wrap:anywhere}
.al-sw{position:relative;width:46px;height:26px;flex:none}.al-sw input{opacity:0;width:100%;height:100%;margin:0;position:absolute;inset:0;cursor:pointer;z-index:1}.al-sw i{position:absolute;inset:0;border:2px solid var(--ink);border-radius:999px;background:#eadfca;transition:background .15s}.al-sw i:after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--ink);transition:transform .15s}.al-sw input:checked+i{background:var(--pink)}.al-sw input:checked+i:after{transform:translateX(20px);background:#fff}.al-sw input:focus-visible+i{outline:3px solid var(--teal)}
.al-more{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:.82rem}.al-more input[type=text]{width:9.5em}
.al-status{display:grid;gap:8px;background:var(--bg);border:2px solid var(--ink);border-radius:12px;padding:10px 12px;font-size:.88rem}.al-status .btns{display:flex;flex-wrap:wrap;gap:8px}
.al-ios{border:2px solid var(--ink);border-radius:12px;background:var(--yellow);padding:10px 12px;font-size:.88rem;display:grid;gap:6px}.al-ios ol{margin:0;padding-left:1.2em;display:grid;gap:3px}.al-ios svg{vertical-align:-3px}
.al-note{font-size:.76rem;color:var(--muted)}
.card-bell{border:0;background:none;color:inherit;font:inherit;font-size:.9rem;padding:2px 4px;margin:-4px 0;border-radius:6px;cursor:pointer;opacity:.55}.card-bell.on{opacity:1}
.card.al-flash{animation:alFlash 1.6s ease-out 2}@keyframes alFlash{0%{box-shadow:0 0 0 6px var(--pink)}100%{box-shadow:5px 5px 0 var(--ink)}}
.fl-btn[hidden]{display:none}`;
  document.head.appendChild(css);

  const SHARE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  const dlg = document.createElement('dialog');
  dlg.id = 'alertsDialog';
  dlg.innerHTML = `<div class="al"><h3 class="display">Alerts</h3>
<p class="muted">A heads-up before a timer ends, even with CollectClock closed. Nothing alerts you until you pick it.</p>
<div id="alIos" class="al-ios" hidden></div>
<div id="alStatus" class="al-status"></div>
<div class="al-sec"><b>Heads-up</b><div class="al-seg" id="alLead">${LEADS.map(([v, l]) => `<button type="button" data-lead="${v}">${l}</button>`).join('')}</div><span class="al-note">"Ready now" always comes when the timer ends. This adds one before it.</span></div>
<div class="al-sec"><b>Quiet hours</b><label class="al-q"><span class="al-sw"><input type="checkbox" id="alQuietOn"><i></i></span>No alerts from <input type="time" id="alQuietA" value="23:00"> to <input type="time" id="alQuietB" value="08:00"></label></div>
<div class="al-sec"><b>Sites</b><span class="al-note">Turn on the ones you want. "When I collect" uses the timer you start by tapping Collect. "Fixed clock" is for site-wide timers that run on the clock, like a giveaway every 30 minutes.</span><input type="search" id="alSearch" placeholder="Find a site…"><div class="al-list" id="alSites"></div></div>
<div class="al-sec"><b>Your own timers</b><span class="al-note">For timers that are not a card here, like one site with several timers.</span><div class="al-list" id="alCustom"></div><button type="button" class="btn small" id="alAddCustom" style="justify-self:start">+ Add a repeating alert</button></div>
<div class="rp-actions"><button type="button" class="btn collect" id="alDone">Done</button></div></div>`;
  document.body.appendChild(dlg);
  const $ = s => dlg.querySelector(s);

  function statusHtml() {
    const p = P();
    if (ios() && !installed()) return { html: `<span>On iPhone, alerts work only from the Home Screen app.</span>`, ios: true };
    if (!pushCapable()) return { html: `<span>This browser can't show alerts while CollectClock is closed.</span>` };
    if (keyTried && !vapidKey) return { html: `<span>Alerts are not switched on for the server yet. Your picks below are saved for when they are.</span>` };
    if (Notification.permission === 'denied') return { html: `<span>Notifications are blocked for CollectClock. ${ios() ? 'Turn them on in Settings › Notifications › CollectClock' : 'Allow them in this site’s settings'}, then come back.</span>` };
    if (!state.session) return { html: `<span>Alerts follow your synced timers, so sign in with Discord first.</span><div class="btns"><button type="button" class="btn small" data-al="login">Sign in with Discord</button></div>` };
    if (p.on && Notification.permission === 'granted') return { html: `<span><b>On for this device.</b> Turn on sites below.</span><div class="btns"><button type="button" class="btn small" data-al="test">Send a test</button><button type="button" class="btn small" data-al="off">Turn off on this device</button></div>` };
    return { html: `<span>Off on this device.</span><div class="btns"><button type="button" class="btn collect" data-al="on">Turn on alerts</button></div>` };
  }
  function iosHint() {
    const v = iosVer();
    const old = v && v < 16.4;
    return `<b>Add CollectClock to your Home Screen first</b>${old ? '<span>This needs iOS 16.4 or newer. Update iOS in Settings › General › Software Update.</span>' : ''}<ol><li>Tap ${SHARE_SVG} <b>Share</b> in Safari.</li><li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open CollectClock from your Home Screen and come back here to turn alerts on.</li></ol>`;
  }
  const siteList = () => (typeof catalog !== 'undefined' ? catalog : []).filter(x => !x.sponsored && !isVisit(x));
  function modeHtml(rule) {
    const fixed = !!rule.every;
    return `<select data-k="mode" aria-label="Timer type"><option value="">When I collect</option>${EVERY.map(m => `<option value="${m}"${rule.every === m ? ' selected' : ''}>Fixed clock: ${everyLabel(m).toLowerCase()}</option>`).join('')}</select>
<span data-k="fixed" style="display:${fixed ? 'contents' : 'none'}">from <input type="time" data-k="anchor" value="${esc(rule.anchor || '00:00')}" aria-label="Lined up with"> <input type="text" data-k="label" maxlength="24" placeholder="what (e.g. giveaway)" value="${esc(rule.label || '')}" aria-label="What happens"></span>`;
  }
  function paintSites() {
    const sites = P().prefs.sites, q = $('#alSearch').value.trim().toLowerCase();
    const list = siteList().filter(x => !q || x.brand.toLowerCase().includes(q));
    list.sort((a, b) => (!!(sites[b.brand] && sites[b.brand].on)) - (!!(sites[a.brand] && sites[a.brand].on)));
    $('#alSites').innerHTML = list.map(x => { const r = sites[x.brand] || {}; return `<div class="al-row${r.on ? ' on' : ''}" data-site="${esc(x.brand)}"><div class="al-top"><span>${esc(x.brand)}</span><label class="al-sw"><input type="checkbox" data-k="on" ${r.on ? 'checked' : ''} aria-label="Alerts for ${esc(x.brand)}"><i></i></label></div>${r.on ? `<div class="al-more">${modeHtml(r)}</div>` : ''}</div>`; }).join('') || '<span class="al-note">No sites match.</span>';
    const custom = Object.entries(sites).filter(([, r]) => r.custom);
    $('#alCustom').innerHTML = custom.map(([name, r]) => `<div class="al-row on" data-site="${esc(name)}" data-custom="1"><div class="al-top"><span>${esc(name)}</span><button type="button" class="btn small" data-k="remove">Remove</button></div><div class="al-more">${modeHtml(r).replace('<option value="">When I collect</option>', '')}<input type="url" data-k="url" placeholder="link (optional)" value="${esc(r.url || '')}" aria-label="Link"></div></div>`).join('');
  }
  function paint() {
    const p = P(), st = statusHtml();
    $('#alStatus').innerHTML = st.html; $('#alStatus').hidden = !!st.ios;
    const ih = $('#alIos'); ih.hidden = !st.ios; if (st.ios) ih.innerHTML = iosHint();
    dlg.querySelectorAll('[data-lead]').forEach(b => b.classList.toggle('on', Number(b.dataset.lead) === p.prefs.lead));
    $('#alQuietOn').checked = !!p.prefs.quiet.on; $('#alQuietA').value = p.prefs.quiet.start; $('#alQuietB').value = p.prefs.quiet.end;
    paintSites();
    paintBell();
  }
  function paintBell() { const b = document.querySelector('#alertsBtn'); if (b) b.classList.toggle('on', !!P().on); }

  dlg.addEventListener('click', e => {
    const a = e.target.closest('[data-al]');
    if (a) { const k = a.dataset.al; if (k === 'on') turnOn(); else if (k === 'off') turnOff(); else if (k === 'test') sendTest(); else if (k === 'login') { dlg.close(); discordLogin(); } return; }
    const l = e.target.closest('[data-lead]');
    if (l) { P().prefs.lead = Number(l.dataset.lead); savePrefs(); paint(); return; }
    const rm = e.target.closest('[data-k="remove"]');
    if (rm) { const name = rm.closest('[data-site]').dataset.site; delete P().prefs.sites[name]; savePrefs(); paintSites(); }
  });
  dlg.addEventListener('change', e => {
    const t = e.target, p = P();
    if (t.id === 'alQuietOn' || t.id === 'alQuietA' || t.id === 'alQuietB') { p.prefs.quiet = { on: $('#alQuietOn').checked, start: $('#alQuietA').value || '23:00', end: $('#alQuietB').value || '08:00' }; savePrefs(); return; }
    const row = t.closest('[data-site]'); if (!row) return;
    const name = row.dataset.site, k = t.dataset.k;
    const r = p.prefs.sites[name] || (p.prefs.sites[name] = {});
    if (k === 'on') { if (t.checked) r.on = true; else delete p.prefs.sites[name]; savePrefs(); paintSites(); render(); return; }
    if (k === 'mode') { const m = Number(t.value); if (m) { r.every = m; r.anchor = r.anchor || '00:00'; } else { delete r.every; delete r.anchor; delete r.label; } savePrefs(); paintSites(); return; }
    if (k === 'anchor') r.anchor = t.value || '00:00';
    if (k === 'label') r.label = t.value.trim().slice(0, 24);
    if (k === 'url') r.url = /^https?:\/\/\S+\.\S+/.test(t.value.trim()) ? t.value.trim() : '';
    savePrefs();
  });
  $('#alSearch').addEventListener('input', paintSites);
  $('#alAddCustom').onclick = () => {
    const name = (prompt('Name it (e.g. Bink.bet wheel)') || '').trim().slice(0, 60);
    if (!name) return;
    P().prefs.sites[name] = { on: true, custom: true, every: 60, anchor: '00:00' };
    savePrefs(); paintSites();
  };
  $('#alDone').onclick = () => dlg.close();
  function openAlerts(site) {
    paint(); dlg.showModal();
    loadKey().then(paint); pullPrefs().then(paint);
    if (site) { $('#alSearch').value = site; paintSites(); }
  }
  window.openAlerts = openAlerts;

  // header bell
  const bell = document.createElement('button');
  bell.type = 'button'; bell.id = 'alertsBtn'; bell.className = 'al-bell'; bell.setAttribute('aria-label', 'Alerts'); bell.title = 'Alerts'; bell.textContent = '🔔';
  bell.onclick = () => openAlerts();
  const login = document.querySelector('#loginBtn'); if (login) login.before(bell);

  // a bell on each timed card opens alerts for that site
  function decorate() {
    const sites = P().prefs.sites;
    document.querySelectorAll('#grid .card').forEach(c => {
      const a = c.querySelector('[data-brand]'); if (!a) return;
      const name = a.dataset.brand; const x = catalog.find(i => i.brand === name); if (!x || isVisit(x)) return; const top = c.querySelector('.ticket-top > span:last-child');
      if (!top || top.querySelector('.card-bell')) return;
      const on = !!(sites[name] && sites[name].on);
      top.insertAdjacentHTML('afterbegin', `<button type="button" class="card-bell${on ? ' on' : ''}" data-alerts="${esc(name)}" aria-label="Alerts for ${esc(name)}${on ? ' (on)' : ''}" title="Alerts">${on ? '🔔' : '🔕'}</button> `);
    });
  }
  document.addEventListener('click', e => { const b = e.target.closest('[data-alerts]'); if (b) { e.preventDefault(); openAlerts(b.dataset.alerts); } });
  const baseRender = render;
  render = function () { baseRender.apply(this, arguments); decorate(); }; // eslint-disable-line no-global-assign

  // ---------- notification click: focus the site's card with its collect link ----------
  function focusSite(site) {
    if (!site) return;
    const go = (tries) => {
      const c = [...document.querySelectorAll('#grid .card')].find(el => { const a = el.querySelector('[data-brand]'); return a && a.dataset.brand === site; });
      if (!c && tries > 0) return setTimeout(() => go(tries - 1), 400);
      if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.classList.add('al-flash'); setTimeout(() => c.classList.remove('al-flash'), 3400); }
      const x = siteList().find(i => i.brand === site), r = P().prefs.sites[site] || {};
      const link = x ? claimUrl(x) : r.url;
      document.querySelector('#installSheet')?.remove();
      const d = document.createElement('div'); d.id = 'installSheet'; d.className = 'install-sheet'; d.setAttribute('role', 'dialog');
      d.innerHTML = `<img src="assets/icon-180.png" alt="" class="is-icon"><div class="is-txt"><strong>${esc(site)}</strong><span>${x && !r.every ? 'Your timer is up.' : 'From your alert.'}</span></div><div class="is-btns">${link ? `<button class="btn collect" id="alGo">${x && !r.every ? 'Collect' : 'Open'}</button>` : ''}<button class="btn small" id="alNo">Close</button></div>`;
      document.body.appendChild(d);
      d.querySelector('#alNo').onclick = () => d.remove();
      const g = d.querySelector('#alGo');
      if (g) g.onclick = () => { d.remove(); if (x && !r.every && isReady(x)) claim(site, link); else window.open(link, '_blank', 'noopener'); };
    };
    go(10);
  }
  function fromHash() {
    const m = location.hash.match(/cc_site=([^&]+)/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    focusSite(decodeURIComponent(m[1]));
  }
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'cc-focus') focusSite(e.data.site); });
  window.addEventListener('hashchange', fromHash);
  setTimeout(fromHash, 600);

  // ---------- floating countdown ----------
  const mod = (a, n) => ((a % n) + n) % n;
  function nextFixed(rule, now) {
    const [h, m] = rule.anchor.split(':').map(Number), A = h * 60 + m;
    const t = new Date(Math.ceil(now / 60000) * 60000);
    const lm = t.getHours() * 60 + t.getMinutes();
    return t.getTime() + mod(A - lm, rule.every) * 60000;
  }
  function upcoming(now = Date.now()) {
    const out = [];
    for (const [name, t] of Object.entries(state.timers || {})) if (t && t.endsAt > now && !(state.hidden || []).includes(name)) out.push({ name, at: t.endsAt });
    for (const [name, r] of Object.entries(P().prefs.sites)) if (r.on && r.every) out.push({ name: r.label ? `${name} ${r.label}` : name, at: nextFixed(r, now) });
    return out.sort((a, b) => a.at - b.at).slice(0, 2);
  }
  const mmss = ms => { let s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600); s %= 3600; const m = Math.floor(s / 60); s %= 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };

  const docPip = 'documentPictureInPicture' in window;
  const canvasStream = !!HTMLCanvasElement.prototype.captureStream;
  const videoPip = canvasStream && (document.pictureInPictureEnabled || (HTMLVideoElement.prototype.webkitSupportsPresentationMode !== undefined));
  let pipWin = null, pipTimer = null, vid = null, cv = null, vidTimer = null;

  async function popOutDoc() {
    if (pipWin) { pipWin.close(); return; }
    pipWin = await documentPictureInPicture.requestWindow({ width: 300, height: 150 });
    const d = pipWin.document;
    d.head.innerHTML = `<style>body{margin:0;font-family:"Space Grotesk",system-ui,sans-serif;background:#161616;color:#fffaf0;display:grid;gap:6px;padding:10px}.r{display:flex;justify-content:space-between;align-items:center;gap:10px;border:2px solid #fffaf0;border-radius:10px;padding:6px 10px}.r b{font-size:.95rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.r span{font:400 1.5rem/1 Bungee,Impact,sans-serif;font-variant-numeric:tabular-nums;color:#ffd23f}.r.hot{background:#ff3d8b;border-color:#ff3d8b}.r.hot span{color:#fff}.e{opacity:.7;font-size:.9rem;padding:8px}</style>`;
    const draw = () => { const now = Date.now(), u = upcoming(now); d.body.innerHTML = u.length ? u.map(x => `<div class="r${x.at - now <= 30000 ? ' hot' : ''}"><b>${esc(x.name)}</b><span>${mmss(x.at - now)}</span></div>`).join('') : '<div class="e">No timers running. Collect something or set a fixed-clock alert.</div>'; };
    draw(); pipTimer = setInterval(draw, 250);
    pipWin.addEventListener('pagehide', () => { clearInterval(pipTimer); pipWin = null; });
  }
  function drawCanvas() {
    const g = cv.getContext('2d'), now = Date.now(), u = upcoming(now), W = cv.width, H = cv.height;
    g.fillStyle = '#161616'; g.fillRect(0, 0, W, H);
    if (!u.length) { g.fillStyle = '#fffaf0'; g.font = '600 26px system-ui,sans-serif'; g.fillText('No timers running', 24, H / 2 + 8); return; }
    const rowH = H / 2;
    u.forEach((x, i) => {
      const y = i * rowH, hot = x.at - now <= 30000;
      g.fillStyle = hot ? '#ff3d8b' : '#161616'; g.fillRect(0, y, W, rowH);
      g.fillStyle = '#fffaf0'; g.font = '600 26px system-ui,sans-serif';
      let n = x.name; while (g.measureText(n).width > W * 0.5 && n.length > 3) n = n.slice(0, -2); if (n !== x.name) n += '…';
      g.fillText(n, 20, y + rowH / 2 + 9);
      g.fillStyle = hot ? '#fff' : '#ffd23f'; g.font = '700 46px ui-monospace,Menlo,monospace'; g.textAlign = 'right';
      g.fillText(mmss(x.at - now), W - 20, y + rowH / 2 + 16); g.textAlign = 'left';
    });
  }
  async function popOutVideo() {
    if (!vid) {
      cv = document.createElement('canvas'); cv.width = 480; cv.height = 200;
      vid = document.createElement('video'); vid.muted = true; vid.playsInline = true; vid.setAttribute('playsinline', ''); vid.autoplay = true;
      vid.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
      document.body.appendChild(vid);
      drawCanvas(); vid.srcObject = cv.captureStream(4);
      vidTimer = setInterval(drawCanvas, 250);
    }
    try {
      await vid.play();
      if (document.pictureInPictureElement === vid) { await document.exitPictureInPicture(); return; }
      if (vid.requestPictureInPicture && document.pictureInPictureEnabled) await vid.requestPictureInPicture();
      else if (vid.webkitSupportsPresentationMode && vid.webkitSupportsPresentationMode('picture-in-picture')) vid.webkitSetPresentationMode('picture-in-picture');
      else throw new Error('no pip');
    } catch (e) {
      if (e && e.name === 'NotAllowedError') toast('Tap Float timer once more to start it.');
      else { toast('Floating timer is not supported here.'); flBtn.hidden = true; }
    }
  }
  const flBtn = document.createElement('button');
  flBtn.type = 'button'; flBtn.className = 'btn small fl-btn'; flBtn.id = 'floatBtn';
  flBtn.textContent = docPip ? '⏱ Pop out timer' : '⏱ Float timer';
  flBtn.hidden = !(docPip || videoPip);
  flBtn.onclick = () => (docPip ? popOutDoc() : popOutVideo()).catch(() => toast('Could not open the floating timer.'));
  const actions = document.querySelector('.toolbar .actions'); if (actions) actions.prepend(flBtn);

  // ---------- boot ----------
  P();
  paintBell();
  try { render(); } catch {}
  checkSub();
  window.ccAlerts = { upcoming, nextFixed, focusSite, paint, openAlerts };
})();
