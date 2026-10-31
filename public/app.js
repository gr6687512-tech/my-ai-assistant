const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#F5A524"/><path d="M9 8h14a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-7l-5 4v-4H9a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4z" fill="#14201F"/><circle cx="12.5" cy="15" r="1.8" fill="#F5A524"/><circle cx="19.5" cy="15" r="1.8" fill="#F5A524"/></svg>';
$$('.logo').forEach(e => e.innerHTML = LOGO);
const T = {
  en: { newChat: 'New chat', ph: 'Message My AI Assistant…', hello: 'How can I help today?', copy: 'Copy', edit: 'Edit', listen: 'Listen', stop: 'Stop', share: 'Share', retry: 'Retry', save: 'Save', cancel: 'Cancel', settings: 'Settings', imgDone: 'Here is your image.', noVoice: 'Voice input is not supported in this browser', copied: 'Copied', s1: 'Explain how UPI works', s2: 'Write a Python function to check prime numbers', s3: 'मुझे एक छोटी कहानी सुनाओ', s4: 'Translate "good morning" into Hindi' },
  hi: { newChat: 'नई चैट', ph: 'My AI Assistant से पूछें…', hello: 'आज मैं आपकी कैसे मदद करूँ?', copy: 'कॉपी', edit: 'बदलें', listen: 'सुनें', stop: 'रोकें', share: 'शेयर', retry: 'फिर से', save: 'सेव', cancel: 'रद्द करें', settings: 'सेटिंग्स', imgDone: 'यह रही आपकी इमेज।', noVoice: 'इस ब्राउज़र में वॉइस इनपुट उपलब्ध नहीं है', copied: 'कॉपी हो गया', s1: 'UPI कैसे काम करता है, समझाओ', s2: 'प्राइम नंबर जाँचने का Python फ़ंक्शन लिखो', s3: 'मुझे एक छोटी कहानी सुनाओ', s4: '"good morning" का हिंदी अनुवाद करो' },
};
let me, chat = null, msgs = [], busy = false, att = { image: null, docs: [] }, imgMode = false, web = false, ctl, speaking = null, mode = 'login';
const ta = $('#ta'), box = $('#msgs');
const t = k => (T[me?.lang] || T.en)[k] ?? T.en[k];
const toast = m => { const e = $('#toast'); e.textContent = m; e.hidden = false; clearTimeout(toast.x); toast.x = setTimeout(() => (e.hidden = true), 3000); };
const api = async (url, method = 'GET', body) => {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/me' && !url.startsWith('/api/auth')) return location.reload();
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
};
const theme = v => {
  localStorage.theme = v;
  const d = v === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : v;
  document.documentElement.dataset.theme = d; $('meta[name=theme-color]').content = d === 'dark' ? '#0E1415' : '#F5F7F6';
};
theme(localStorage.theme || 'system');

// ---------- auth ----------
function authUI() {
  $('#auth').hidden = false; $('#app').hidden = true;
  $('#name').hidden = mode === 'login';
  $('#authBtn').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('#swap').textContent = mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in';
  $('#pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
}
$('#swap').onclick = () => { mode = mode === 'login' ? 'register' : 'login'; authUI(); };
$('#authForm').onsubmit = async e => {
  e.preventDefault(); $('#err').textContent = '';
  try { me = await api('/api/auth/' + mode, 'POST', { email: $('#email').value, password: $('#pass').value, name: $('#name').value }); start(); }
  catch (x) { $('#err').textContent = x.message; }
};
async function initGoogle() {
  const { google: cid } = await api('/api/config'); if (!cid) return;
  const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => {
    window.google.accounts.id.initialize({ client_id: cid, callback: async r => { try { me = await api('/api/auth/google', 'POST', { credential: r.credential }); start(); } catch (x) { $('#err').textContent = x.message; } } });
    window.google.accounts.id.renderButton($('#gbtn'), { theme: 'outline', size: 'large', width: 300 });
  };
  document.head.append(s);
}
function applyLang() {
  document.documentElement.lang = me.lang;
  $$('[data-i]').forEach(e => (e.textContent = t(e.dataset.i)));
  ta.placeholder = imgMode ? 'Describe the image to create…' : t('ph');
  if (!chat) { $('#title').textContent = t('newChat'); draw(); }
}
function start() {
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#av').textContent = (me.name || '?')[0].toUpperCase(); $('#uname').textContent = me.name;
  $('#adminBtn').hidden = me.role !== 'admin';
  applyLang(); loadChats();
}

// ---------- chat list ----------
const side = o => { $('#side').classList.toggle('open', o); $('#scrim').classList.toggle('show', o); };
async function loadChats() {
  const rows = await api('/api/chats'), l = $('#list'); l.innerHTML = '';
  rows.forEach(c => {
    const d = document.createElement('div'), s = document.createElement('span'), x = document.createElement('button');
    d.className = 'ci' + (chat?.id === c.id ? ' on' : ''); s.textContent = c.title; s.onclick = () => openChat(c.id);
    x.textContent = '✕'; x.setAttribute('aria-label', 'Delete chat');
    x.onclick = async () => { await api('/api/chats/' + c.id, 'DELETE'); if (chat?.id === c.id) newChat(); loadChats(); };
    d.append(s, x); l.append(d);
  });
}
async function openChat(id) {
  try { const c = await api('/api/chats/' + id); chat = { id: c.id, title: c.title }; msgs = c.msgs; $('#title').textContent = c.title; draw(); side(false); loadChats(); }
  catch (e) { toast(e.message); }
}
function newChat() { chat = null; msgs = []; $('#title').textContent = t('newChat'); draw(); side(false); loadChats(); }
async function sync() { if (!chat || busy) return; try { msgs = (await api('/api/chats/' + chat.id)).msgs; draw(); } catch {} }
$('#newBtn').onclick = newChat; $('#menu').onclick = () => side(true); $('#scrim').onclick = () => side(false);

// ---------- rendering ----------
function mdEl(b, s) {
  b.innerHTML = DOMPurify.sanitize(marked.parse(s, { breaks: true }));
  b.querySelectorAll('pre').forEach(p => {
    const c = p.querySelector('code'), h = document.createElement('div'), x = document.createElement('button');
    h.className = 'ch'; h.innerHTML = '<span>' + ((c?.className.match(/language-(\w+)/) || [])[1] || 'code') + '</span>';
    x.type = 'button'; x.textContent = t('copy');
    x.onclick = () => { navigator.clipboard.writeText(c.textContent); x.textContent = '✓'; setTimeout(() => (x.textContent = t('copy')), 1200); };
    h.append(x); p.prepend(h);
  });
  b.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
}
function draw() {
  box.innerHTML = '';
  if (!msgs.length) {
    box.innerHTML = `<div class="hero">${LOGO}<h1>${t('hello')}</h1><div class="sugg"></div></div>`;
    ['s1', 's2', 's3', 's4'].forEach(k => { const b = document.createElement('button'); b.textContent = t(k); b.onclick = () => send(t(k)); $('.sugg').append(b); });
    return;
  }
  msgs.forEach((m, i) => box.append(el(m, i)));
  box.scrollTop = box.scrollHeight;
}
function el(m, i) {
  const d = document.createElement('div'), u = m.role === 'user', b = document.createElement('div'), bar = document.createElement('div');
  d.className = 'm ' + (u ? 'u' : 'a'); b.className = 'b' + (u ? '' : ' md'); bar.className = 'bar';
  if (u) b.textContent = m.content; else mdEl(b, m.content);
  if (m.img) { const im = new Image(); im.src = m.img; im.className = 'pic'; im.alt = ''; im.onclick = () => { $('#pvImg').src = m.img; $('#pv').showModal(); }; b.prepend(im); }
  const add = (k, fn) => { const x = document.createElement('button'); x.type = 'button'; x.textContent = t(k); x.onclick = () => fn(x); bar.append(x); };
  if (m.content && !(busy && i === msgs.length - 1)) {
    add('copy', () => { navigator.clipboard.writeText(m.content); toast(t('copied')); });
    if (u) add('edit', () => edit(i, b));
    else { add('listen', x => speak(m.content, x)); add('share', () => share(m.content)); if (i === msgs.length - 1 && !m.img) add('retry', () => regen(i)); }
  }
  if (m.img) add('save', () => dl(m.img));
  d.append(b, bar); return d;
}
const dl = src => { const a = document.createElement('a'); a.href = src; a.download = 'my-ai-assistant.' + (src.startsWith('data:image/jpeg') ? 'jpg' : 'png'); a.click(); };
const share = s => (navigator.share ? navigator.share({ text: s }).catch(() => {}) : (navigator.clipboard.writeText(s), toast(t('copied'))));
$('#pvSave').onclick = () => dl($('#pvImg').src); $('#pvClose').onclick = () => $('#pv').close();

function edit(i, b) {
  const m = msgs[i]; if (!m.id) return sync().then(() => toast('Please try again'));
  const x = document.createElement('textarea'), go = document.createElement('button'), no = document.createElement('button');
  x.className = 'ed'; x.value = m.content.replace(/\n\n📎 .*/g, '');
  go.type = no.type = 'button'; go.className = 'btn'; no.className = 'ghost'; go.textContent = t('save'); no.textContent = t('cancel');
  go.onclick = () => { const v = x.value.trim(); if (v) { msgs.splice(i); send(v, { from: m.id, image: m.img }); } };
  no.onclick = () => draw();
  b.replaceChildren(x, go, ' ', no); x.focus();
}
function regen(i) { const m = msgs[i]; if (!m.id) return sync().then(() => toast('Please try again')); msgs.pop(); send('', { from: m.id, regen: true }); }

// ---------- sending / streaming ----------
async function send(text, o = {}) {
  if (busy) return;
  const image = o.from ? o.image ?? null : att.image, docs = o.from ? [] : att.docs;
  if (!o.regen && !text.trim() && !image && !docs.length) return;
  busy = true; $('#send').textContent = '■'; $('#send').setAttribute('aria-label', 'Stop');
  const mine = { role: 'user', content: text + docs.map(d => `\n\n📎 ${d.name}`).join(''), img: image }, ai = { role: 'assistant', content: '' };
  if (!o.regen) msgs.push(mine);
  msgs.push(ai);
  const gen = imgMode; imgMode = false; $('#imgBtn').classList.remove('on'); ta.placeholder = t('ph');
  if (!o.from) att = { image: null, docs: [] };
  chips(); draw();
  const node = box.lastChild.querySelector('.b'); ctl = new AbortController();
  try {
    if (gen) {
      const j = await api('/api/image', 'POST', { chatId: chat?.id, prompt: text });
      chat = j.chat; mine.id = j.userId; mine.content = '🎨 ' + text; ai.id = j.id; ai.img = j.img; ai.content = t('imgDone');
      $('#title').textContent = chat.title;
    } else {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal, body: JSON.stringify({ chatId: chat?.id, text, image, docs, search: web, from: o.from }) });
      if (r.status === 401) return location.reload();
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Request failed');
      const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '', raf = 0;
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let k; (k = buf.indexOf('\n\n')) >= 0;) {
          const ev = JSON.parse(buf.slice(6, k)); buf = buf.slice(k + 2);
          if (ev.chat) { chat = ev.chat; mine.id = ev.userId ?? mine.id; $('#title').textContent = chat.title; }
          if (ev.d) {
            ai.content += ev.d;
            if (!raf) raf = requestAnimationFrame(() => { raf = 0; mdEl(node, ai.content); if (box.scrollHeight - box.scrollTop - box.clientHeight < 150) box.scrollTop = box.scrollHeight; });
          }
          if (ev.error) toast(ev.error);
          if (ev.done) ai.id = ev.id;
        }
      }
      cancelAnimationFrame(raf);
    }
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
  busy = false; $('#send').textContent = '➤'; $('#send').setAttribute('aria-label', 'Send');
  if (!ai.content && !ai.img) { msgs.pop(); if (!o.regen && !o.from) ta.value = text; }
  draw(); loadChats();
  if (chat && (!ai.id || !mine.id)) setTimeout(sync, 700);
  if (ai.content && localStorage.av === '1') speak(ai.content, {});
}
const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; };
const submit = () => { const v = ta.value; ta.value = ''; grow(); send(v); };
ta.oninput = grow;
ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); submit(); } };
$('#composer').onsubmit = e => { e.preventDefault(); busy ? ctl?.abort() : submit(); };

// ---------- attachments ----------
function chips() {
  const c = $('#chips'); c.innerHTML = '';
  const add = (n, rm) => { const d = document.createElement('div'), x = document.createElement('button'); d.className = 'chip'; x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'Remove'); x.onclick = rm; d.append(n, x); c.append(d); };
  if (att.image) { const im = new Image(); im.src = att.image; im.alt = ''; add(im, () => { att.image = null; chips(); }); }
  att.docs.forEach((f, i) => { const s = document.createElement('span'); s.textContent = '📎 ' + f.name; add(s, () => { att.docs.splice(i, 1); chips(); }); });
}
const shrink = f => new Promise((ok, no) => {
  const im = new Image();
  im.onload = () => {
    const s = Math.min(1, 1600 / Math.max(im.width, im.height)), c = document.createElement('canvas');
    c.width = im.width * s; c.height = im.height * s; c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    URL.revokeObjectURL(im.src); ok(c.toDataURL('image/jpeg', 0.85));
  };
  im.onerror = () => no(new Error('Could not read this image')); im.src = URL.createObjectURL(f);
});
async function addFile(f) {
  if (!f) return;
  try {
    if (f.type.startsWith('image/')) att.image = await shrink(f);
    else {
      toast('Reading ' + f.name + '…'); const fd = new FormData(); fd.append('file', f);
      const r = await fetch('/api/extract', { method: 'POST', body: fd }), j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not read file'); att.docs.push(j);
    }
    chips();
  } catch (e) { toast(e.message); }
}
$('#fileBtn').onclick = () => $('#fileIn').click(); $('#picBtn').onclick = () => $('#picIn').click();
$('#fileIn').onchange = $('#picIn').onchange = e => { addFile(e.target.files[0]); e.target.value = ''; };
$('#imgBtn').onclick = e => { imgMode = !imgMode; e.currentTarget.classList.toggle('on', imgMode); ta.placeholder = imgMode ? 'Describe the image to create…' : t('ph'); ta.focus(); };
$('#webBtn').onclick = e => { web = !web; e.currentTarget.classList.toggle('on', web); toast(web ? 'Web search on' : 'Web search off'); };

// ---------- voice ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition; let rec;
$('#mic').onclick = () => {
  if (!SR) return toast(t('noVoice'));
  if (rec) return rec.stop();
  rec = new SR(); rec.lang = me.lang === 'hi' ? 'hi-IN' : 'en-IN'; rec.interimResults = true;
  const base = ta.value;
  rec.onresult = e => { ta.value = (base + ' ' + [...e.results].map(r => r[0].transcript).join('')).trim(); grow(); };
  rec.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Microphone error: ' + e.error); };
  rec.onend = () => { rec = null; $('#mic').classList.remove('on'); if (localStorage.av === '1' && ta.value.trim()) submit(); };
  rec.start(); $('#mic').classList.add('on');
};
function speak(text, btn) {
  const syn = window.speechSynthesis; if (!syn) return toast('Speech is not supported in this browser');
  const prev = speaking; syn.cancel(); speaking = null;
  if (prev) prev.textContent = t('listen');
  if (prev === btn) return;
  const clean = text.replace(/```[\s\S]*?```|[#*_`>~|]/g, ' '), u = new SpeechSynthesisUtterance(clean);
  u.lang = /[\u0900-\u097F]/.test(clean) ? 'hi-IN' : 'en-IN';
  u.onend = u.onerror = () => { if (speaking === btn) { speaking = null; btn.textContent = t('listen'); } };
  speaking = btn; btn.textContent = t('stop'); syn.speak(u);
}

// ---------- settings ----------
$('#me').onclick = () => {
  $('#nmIn').value = me.name; $('#mail').textContent = me.email; $('#thSel').value = localStorage.theme || 'system';
  $('#lgSel').value = me.lang; $('#avCk').checked = localStorage.av === '1'; $('#set').showModal();
};
$('#thSel').onchange = e => theme(e.target.value);
$('#avCk').onchange = e => (localStorage.av = e.target.checked ? '1' : '0');
$('#lgSel').onchange = async e => { try { me = await api('/api/me', 'PATCH', { lang: e.target.value }); applyLang(); } catch (x) { toast(x.message); } };
$('#nmIn').onchange = async e => { try { me = await api('/api/me', 'PATCH', { name: e.target.value }); $('#uname').textContent = me.name; $('#av').textContent = me.name[0].toUpperCase(); } catch (x) { toast(x.message); } };
$('#setClose').onclick = () => $('#set').close();
$('#clrAll').onclick = async () => { if (confirm('Delete all your chats? This cannot be undone.')) { await api('/api/chats', 'DELETE'); newChat(); toast('Chats cleared'); } };
$('#logout').onclick = async () => { await api('/api/auth/logout', 'POST'); location.reload(); };

// ---------- admin ----------
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
async function admin(tab = 0) {
  const tb = $('#tabs'), body = $('#admBody'); tb.innerHTML = '';
  ['Overview', 'Users', 'AI model', 'Errors'].forEach((n, i) => { const b = document.createElement('button'); b.textContent = n; b.className = i === tab ? 'btn' : 'ghost'; b.onclick = () => admin(i); tb.append(b); });
  body.textContent = 'Loading…'; if (!$('#adm').open) $('#adm').showModal();
  try {
    if (tab === 0) {
      const s = await api('/api/admin/stats');
      body.innerHTML = '<div class="stats">' + [['Users', s.users], ['Chats', s.chats], ['Messages', s.msgs], ['Tokens used', s.tokens], ['AI calls (24h)', s.calls24h], ['Errors (24h)', s.errors24h]].map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('') + '</div><table><tr><th>Day</th><th>Calls</th><th>Tokens</th></tr>' + s.daily.map(d => `<tr><td>${d.d}</td><td>${d.calls}</td><td>${d.tokens}</td></tr>`).join('') + '</table>';
    } else if (tab === 1) {
      const u = await api('/api/admin/users');
      body.innerHTML = '<table>' + u.map(x => `<tr><td>${esc(x.email)}<br><small>${esc(x.name)} · ${x.tokens} tokens${x.disabled ? ' · disabled' : ''}</small></td><td><button class="ghost" data-id="${x.id}" data-r="${x.role === 'admin' ? 'user' : 'admin'}">${x.role === 'admin' ? 'Remove admin' : 'Make admin'}</button> <button class="ghost" data-id="${x.id}" data-d="${x.disabled ? 0 : 1}">${x.disabled ? 'Enable' : 'Disable'}</button></td></tr>`).join('') + '</table>';
      body.querySelectorAll('button').forEach(b => (b.onclick = async () => { try { await api('/api/admin/users/' + b.dataset.id, 'PATCH', b.dataset.r ? { role: b.dataset.r } : { disabled: !!+b.dataset.d }); admin(1); } catch (e) { toast(e.message); } }));
    } else if (tab === 2) {
      const s = await api('/api/admin/stats');
      body.innerHTML = `<label>Model <input id="cfgModel" value="${esc(s.config.model)}"></label><label>System prompt <textarea id="cfgSys" rows="8">${esc(s.config.system)}</textarea></label><button class="btn" id="cfgSave">Save</button>`;
      $('#cfgSave').onclick = async () => { try { await api('/api/admin/config', 'PUT', { model: $('#cfgModel').value, system: $('#cfgSys').value }); toast('Saved'); } catch (e) { toast(e.message); } };
    } else {
      const er = await api('/api/admin/errors');
      body.innerHTML = er.length ? '<table>' + er.map(x => `<tr><td><small>${new Date(x.created).toLocaleString()} · ${esc(x.email || 'system')}</small><br>${esc(x.msg)}</td></tr>`).join('') + '</table>' : 'No errors logged.';
    }
  } catch (e) { body.textContent = e.message; }
}
$('#adminBtn').onclick = () => { $('#set').close(); admin(0); }; $('#admClose').onclick = () => $('#adm').close();

(async () => { try { me = await api('/api/me'); start(); } catch { authUI(); initGoogle(); } })();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
