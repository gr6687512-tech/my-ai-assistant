import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import OpenAI from 'openai';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import { OAuth2Client } from 'google-auth-library';
import path from 'path';
import { fileURLToPath } from 'url';

const { PORT = 3000, JWT_SECRET, OPENAI_API_KEY, GOOGLE_CLIENT_ID, ADMIN_EMAIL = '', DB_PATH = './data.db', NODE_ENV } = process.env;
if (!JWT_SECRET || !OPENAI_API_KEY) { console.error('Set JWT_SECRET and OPENAI_API_KEY (see .env.example)'); process.exit(1); }
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const gClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, pass TEXT, role TEXT DEFAULT 'user', lang TEXT DEFAULT 'en', disabled INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT, updated INTEGER);
CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role TEXT, content TEXT, extra TEXT, img TEXT, created INTEGER);
CREATE INDEX IF NOT EXISTS msgs_chat ON msgs(chat_id);
CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, uid INTEGER, kind TEXT, model TEXT, tin INTEGER, tout INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS errors(id INTEGER PRIMARY KEY, uid INTEGER, msg TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);`);

const SYS = `You are My AI Assistant, a helpful and accurate assistant. Reply in the language the user writes in (Hindi, English or Hinglish). Use Markdown; put code in fenced blocks with a language tag and explain it briefly. For math, solve step by step and state the final answer clearly. For translation, give only the translation unless asked otherwise.`;
const now = () => Date.now();
const q = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const cfg = (k, d) => q('SELECT v FROM settings WHERE k=?', k)?.v ?? d;
const model = () => cfg('model', process.env.OPENAI_MODEL || 'gpt-4o-mini');
const logErr = (uid, e) => run('INSERT INTO errors(uid,msg,created) VALUES(?,?,?)', uid ?? null, String(e?.message || e).slice(0, 500), now());
const pub = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, lang: u.lang });
const sign = (res, u) => res.cookie('t', jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '30d' }), { httpOnly: true, sameSite: 'lax', secure: NODE_ENV === 'production', maxAge: 30 * 864e5 });
const mkUser = (email, name, pass) => q('SELECT * FROM users WHERE id=?', run('INSERT INTO users(email,name,pass,role,created) VALUES(?,?,?,?,?)', email, name, pass, ADMIN_EMAIL && email === ADMIN_EMAIL.toLowerCase() ? 'admin' : 'user', now()).lastInsertRowid);
const getChat = (uid, id, title = '') => {
  if (id) return q('SELECT id,title FROM chats WHERE id=? AND uid=?', id, uid);
  const c = { id: crypto.randomUUID(), title: title.slice(0, 60) || 'New chat' };
  run('INSERT INTO chats(id,uid,title,updated) VALUES(?,?,?,?)', c.id, uid, c.title, now());
  return c;
};

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://accounts.google.com'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com'], imgSrc: ["'self'", 'data:', 'blob:'],
  connectSrc: ["'self'", 'https://accounts.google.com'], frameSrc: ['https://accounts.google.com'], upgradeInsecureRequests: null } } }));
app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));
const lim = (limit, ms) => rateLimit({ windowMs: ms, limit, standardHeaders: true, legacyHeaders: false });

// ---------- auth ----------
app.get('/api/config', (req, res) => res.json({ google: GOOGLE_CLIENT_ID || null }));
app.post('/api/auth/register', lim(10, 9e5), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || pw.length < 8) return res.status(400).json({ error: 'Enter a valid email and a password of 8+ characters' });
  if (q('SELECT 1 FROM users WHERE email=?', email)) return res.status(409).json({ error: 'This email is already registered' });
  const u = mkUser(email, String(req.body.name || '').trim().slice(0, 60) || email.split('@')[0], bcrypt.hashSync(pw, 11));
  sign(res, u); res.json(pub(u));
});
app.post('/api/auth/login', lim(20, 9e5), (req, res) => {
  const u = q('SELECT * FROM users WHERE email=?', String(req.body.email || '').trim().toLowerCase());
  if (!u || !u.pass || u.disabled || !bcrypt.compareSync(String(req.body.password || ''), u.pass)) return res.status(401).json({ error: 'Wrong email or password' });
  sign(res, u); res.json(pub(u));
});
app.post('/api/auth/google', lim(20, 9e5), async (req, res) => {
  if (!gClient) return res.status(501).json({ error: 'Google sign-in is not configured' });
  try {
    const p = (await gClient.verifyIdToken({ idToken: req.body.credential, audience: GOOGLE_CLIENT_ID })).getPayload();
    if (!p.email_verified) throw new Error('unverified');
    const email = p.email.toLowerCase();
    const u = q('SELECT * FROM users WHERE email=?', email) || mkUser(email, p.name || email.split('@')[0], null);
    if (u.disabled) return res.status(403).json({ error: 'This account is disabled' });
    sign(res, u); res.json(pub(u));
  } catch { res.status(401).json({ error: 'Google sign-in failed' }); }
});
app.post('/api/auth/logout', (req, res) => { res.clearCookie('t'); res.json({ ok: 1 }); });

app.use('/api', (req, res, next) => {
  try {
    const u = q('SELECT * FROM users WHERE id=?', jwt.verify(req.cookies.t, JWT_SECRET).id);
    if (!u || u.disabled) throw 0;
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Please sign in' }); }
});
const admin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));

app.get('/api/me', (req, res) => res.json(pub(req.user)));
app.patch('/api/me', (req, res) => {
  const { name, lang } = req.body;
  run('UPDATE users SET name=COALESCE(?,name), lang=COALESCE(?,lang) WHERE id=?', name ? String(name).slice(0, 60) : null, ['en', 'hi'].includes(lang) ? lang : null, req.user.id);
  res.json(pub(q('SELECT * FROM users WHERE id=?', req.user.id)));
});

// ---------- chats ----------
app.get('/api/chats', (req, res) => res.json(db.prepare('SELECT id,title,updated FROM chats WHERE uid=? ORDER BY updated DESC LIMIT 200').all(req.user.id)));
app.get('/api/chats/:id', (req, res) => {
  const c = getChat(req.user.id, req.params.id);
  if (!c) return res.status(404).json({ error: 'Chat not found' });
  res.json({ ...c, msgs: db.prepare('SELECT id,role,content,img FROM msgs WHERE chat_id=? ORDER BY id').all(c.id) });
});
app.delete('/api/chats/:id', (req, res) => { run('DELETE FROM chats WHERE id=? AND uid=?', req.params.id, req.user.id); res.json({ ok: 1 }); });
app.delete('/api/chats', (req, res) => { run('DELETE FROM chats WHERE uid=?', req.user.id); res.json({ ok: 1 }); });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/extract', lim(30, 6e4), upload.single('file'), async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'No file received' });
  try {
    const text = f.mimetype === 'application/pdf' || /\.pdf$/i.test(f.originalname) ? (await pdf(f.buffer)).text : f.buffer.toString('utf8');
    if (!text.trim()) throw new Error('No readable text found (scanned PDFs are not supported)');
    res.json({ name: f.originalname.slice(0, 80), text: text.slice(0, 60000) });
  } catch (e) { logErr(req.user.id, e); res.status(422).json({ error: e.message }); }
});

// ---------- AI: streaming chat ----------
app.post('/api/chat', lim(40, 6e4), async (req, res) => {
  const uid = req.user.id, { chatId, from } = req.body, text = String(req.body.text || '').trim(), image = req.body.image || null, search = !!req.body.search;
  const docs = Array.isArray(req.body.docs) ? req.body.docs.slice(0, 3) : [];
  if (image && !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(image)) return res.status(400).json({ error: 'Unsupported image' });
  if (!chatId && !text && !image && !docs.length) return res.status(400).json({ error: 'Message is empty' });
  const chat = getChat(uid, chatId, text || docs[0]?.name || 'Image chat');
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (from) run('DELETE FROM msgs WHERE chat_id=? AND id>=?', chat.id, +from);
  let userId = null;
  if (text || image || docs.length) {
    const extra = docs.map(d => `\n\n[Attached file: ${d.name}]\n${String(d.text).slice(0, 60000)}`).join('');
    const content = text + docs.map(d => `\n\n📎 ${d.name}`).join('');
    userId = run('INSERT INTO msgs(chat_id,role,content,extra,img,created) VALUES(?,?,?,?,?,?)', chat.id, 'user', content, extra, image, now()).lastInsertRowid;
  }
  const rows = db.prepare('SELECT role,content,extra,img FROM msgs WHERE chat_id=? ORDER BY id DESC LIMIT 40').all(chat.id).reverse();
  if (rows.at(-1)?.role !== 'user') return res.status(400).json({ error: 'Nothing to answer' });
  let imgs = 2, budget = 120000; const input = [];
  for (let i = rows.length - 1; i >= 0 && budget > 0; i--) {
    const m = rows[i], body = m.content + (m.extra || ''); budget -= body.length;
    input.unshift(m.role === 'user' && m.img && imgs-- > 0
      ? { role: 'user', content: [{ type: 'input_text', text: body || 'What is in this image?' }, { type: 'input_image', image_url: m.img }] }
      : { role: m.role, content: body || '(image)' });
  }

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
  send({ chat, userId });
  const ac = new AbortController(); res.on('close', () => ac.abort());
  let out = '', usage = null; const mdl = model();
  try {
    const stream = await openai.responses.create({
      model: mdl, input, stream: true,
      instructions: cfg('system', SYS) + (req.user.lang === 'hi' ? '\nThe user prefers Hindi unless they write in another language.' : ''),
      ...(search && { tools: [{ type: 'web_search' }] }),
    }, { signal: ac.signal });
    for await (const ev of stream) {
      if (ev.type === 'response.output_text.delta') { out += ev.delta; send({ d: ev.delta }); }
      else if (ev.type === 'response.completed') usage = ev.response.usage;
      else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error(ev.response?.error?.message || ev.message || 'Model error');
    }
  } catch (e) { if (!ac.signal.aborted) { logErr(uid, e); send({ error: 'The AI service had a problem. Please try again.' }); } }
  const id = out ? run('INSERT INTO msgs(chat_id,role,content,created) VALUES(?,?,?,?)', chat.id, 'assistant', out, now()).lastInsertRowid : null;
  run('UPDATE chats SET updated=? WHERE id=?', now(), chat.id);
  if (usage) run('INSERT INTO usage(uid,kind,model,tin,tout,created) VALUES(?,?,?,?,?,?)', uid, 'chat', mdl, usage.input_tokens, usage.output_tokens, now());
  send({ done: true, id }); res.end();
});

// ---------- AI: image generation ----------
app.post('/api/image', lim(10, 6e4), async (req, res) => {
  const prompt = String(req.body.prompt || '').trim().slice(0, 1000);
  if (!prompt) return res.status(400).json({ error: 'Describe the image you want' });
  const mdl = process.env.IMAGE_MODEL || 'gpt-image-1';
  try {
    const r = await openai.images.generate({ model: mdl, prompt, size: '1024x1024' });
    const img = 'data:image/png;base64,' + r.data[0].b64_json;
    const chat = getChat(req.user.id, req.body.chatId, prompt);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const userId = run('INSERT INTO msgs(chat_id,role,content,created) VALUES(?,?,?,?)', chat.id, 'user', '🎨 ' + prompt, now()).lastInsertRowid;
    const id = run('INSERT INTO msgs(chat_id,role,content,img,created) VALUES(?,?,?,?,?)', chat.id, 'assistant', 'Here is your image.', img, now()).lastInsertRowid;
    run('UPDATE chats SET updated=? WHERE id=?', now(), chat.id);
    run('INSERT INTO usage(uid,kind,model,tin,tout,created) VALUES(?,?,?,?,?,?)', req.user.id, 'image', mdl, r.usage?.input_tokens || 0, r.usage?.output_tokens || 0, now());
    res.json({ chat, userId, id, img });
  } catch (e) { logErr(req.user.id, e); res.status(502).json({ error: `Image generation failed. Check that your OpenAI account can use ${mdl}.` }); }
});

// ---------- admin ----------
app.get('/api/admin/stats', admin, (req, res) => {
  const n = (sql) => q(sql).n;
  res.json({
    users: n('SELECT COUNT(*) n FROM users'), chats: n('SELECT COUNT(*) n FROM chats'), msgs: n('SELECT COUNT(*) n FROM msgs'),
    tokens: n('SELECT COALESCE(SUM(tin+tout),0) n FROM usage'),
    calls24h: n(`SELECT COUNT(*) n FROM usage WHERE created>${now() - 864e5}`), errors24h: n(`SELECT COUNT(*) n FROM errors WHERE created>${now() - 864e5}`),
    daily: db.prepare("SELECT date(created/1000,'unixepoch') d, COUNT(*) calls, COALESCE(SUM(tin+tout),0) tokens FROM usage GROUP BY d ORDER BY d DESC LIMIT 14").all(),
    config: { model: model(), system: cfg('system', SYS) },
  });
});
app.get('/api/admin/users', admin, (req, res) => res.json(db.prepare('SELECT u.id,u.email,u.name,u.role,u.disabled,u.created,(SELECT COALESCE(SUM(tin+tout),0) FROM usage WHERE uid=u.id) tokens FROM users u ORDER BY u.id DESC LIMIT 500').all()));
app.patch('/api/admin/users/:id', admin, (req, res) => {
  if (+req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own account here' });
  const { role, disabled } = req.body;
  run('UPDATE users SET role=COALESCE(?,role), disabled=COALESCE(?,disabled) WHERE id=?', ['user', 'admin'].includes(role) ? role : null, disabled === undefined ? null : +!!disabled, +req.params.id);
  res.json({ ok: 1 });
});
app.put('/api/admin/config', admin, (req, res) => {
  const m = String(req.body.model || '').trim().slice(0, 80), s = String(req.body.system || '').trim().slice(0, 4000);
  if (!m || !s) return res.status(400).json({ error: 'Model and system prompt are required' });
  for (const [k, v] of [['model', m], ['system', s]]) run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v);
  res.json({ ok: 1 });
});
app.get('/api/admin/errors', admin, (req, res) => res.json(db.prepare('SELECT e.id,e.msg,e.created,u.email FROM errors e LEFT JOIN users u ON u.id=e.uid ORDER BY e.id DESC LIMIT 50').all()));

app.use((e, req, res, next) => {
  if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large (10 MB max)' });
  logErr(req.user?.id, e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' });
});
app.listen(PORT, () => console.log(`My AI Assistant running on port ${PORT}`));
