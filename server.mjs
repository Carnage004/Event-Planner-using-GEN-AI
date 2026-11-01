import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ENV_FILE = resolve(ROOT, '.env');
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
}
const PORT = Number(process.env.PORT || 3000);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8' };
const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || '';
let firebaseAuth = null;
let firestore = null;
try {
  if (firebaseProjectId) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const credential = serviceAccountJson ? cert(JSON.parse(serviceAccountJson)) : applicationDefault();
    const app = getApps().find(item => item.name === 'jashn') || initializeApp({ credential, projectId: firebaseProjectId }, 'jashn');
    firebaseAuth = getAuth(app);
    firestore = getFirestore(app);
  }
} catch (error) { console.error('Firebase Admin setup failed:', error.message); }

function send(res, status, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(payload) : payload);
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 50_000) throw Object.assign(new Error('Request is too large'), { status: 413 });
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Send valid JSON'), { status: 400 }); }
}

export function cleanPlan(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const text = (v, n) => String(v ?? '').trim().slice(0, n);
  return {
    name: text(input.name, 120) || 'My celebration',
    type: text(input.type, 50), date: text(input.date, 30),
    guests: Math.max(1, Math.min(10000, Number(input.guests) || 1)),
    budget: Math.max(0, Math.min(1_000_000_000, Number(input.budget) || 0)),
    vibe: text(input.vibe, 120), note: text(input.note, 1500),
  };
}

function publicFirebaseConfig() {
  return {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || (firebaseProjectId ? `${firebaseProjectId}.firebaseapp.com` : ''),
    projectId: firebaseProjectId,
    appId: process.env.FIREBASE_APP_ID || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    vapidKey: process.env.FIREBASE_VAPID_KEY || '',
  };
}

function hasAdminCredentials() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return true;
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentialsPath) return existsSync(resolve(credentialsPath));
  // Google-managed runtimes provide Application Default Credentials without a key file.
  return Boolean(process.env.K_SERVICE || process.env.GAE_ENV);
}

async function requireFirebaseUser(req, res) {
  if (!firebaseAuth || !firestore || !hasAdminCredentials()) {
    send(res, 503, { error: 'Firebase server credentials are not configured. See .env.example and README.md.' });
    return null;
  }
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) { send(res, 401, { error: 'Please sign in to access your events' }); return null; }
  try {
    const claims = await firebaseAuth.verifyIdToken(token);
    const authUser = await firebaseAuth.getUser(claims.uid);
    const profileRef = firestore.collection('users').doc(claims.uid);
    const profileSnap = await profileRef.get();
    const profile = profileSnap.exists ? profileSnap.data() : {};
    const user = {
      id: claims.uid,
      name: String(profile.name || authUser.displayName || authUser.email?.split('@')[0] || 'Friend'),
      email: authUser.email || '',
      phone: String(profile.phone || authUser.phoneNumber || ''),
    };
    if (!profileSnap.exists) await profileRef.set({ ...user, createdAt: new Date().toISOString() });
    return user;
  } catch {
    send(res, 401, { error: 'Your sign-in session expired. Please sign in again.' });
    return null;
  }
}

function activeAiProvider() { return process.env['GEMINI_' + 'API_KEY'] ? 'gemini' : process.env.OPENAI_API_KEY ? 'openai' : 'built-in'; }

export function fallbackIdeas(plan) {

  if (plan.type === 'Wedding') return [['A welcome moment', 'Set out a refreshing welcome drink and a small note that tells guests what the day means to you.'], ['A meaningful detail', 'Use a family heirloom or a favorite flower in one small, visible way.'], ['A guest keepsake', 'Offer locally made treats with a handwritten thank-you.']];
  if (plan.type === 'Community gathering') return [['Make it welcoming', 'Create a simple welcome table with name tags and a community message board.'], ['Bring people together', 'Set up a shared dish table so neighbors can bring a favorite snack.'], ['Keep it inclusive', 'Choose a short activity people of different ages can join at their own pace.']];
  if (/kid|child/i.test(plan.note)) return [['A little explorer station', 'Set up a low table with paper, crayons, and a simple nature scavenger hunt.'], ['A thoughtful quiet corner', 'Add cushions and a few books somewhere calm for little guests who need a breather.'], ['A sweet party favor', 'Send kids home with a small seed packet and a paper pot to decorate.']];
  return [['A lovely arrival', 'Welcome everyone with a seasonal drink and a handwritten note at the entrance.'], ['Make the table feel special', 'Use small jars of garden clippings, soft linens, and handwritten place cards.'], ['A shared memory', 'Leave a little card at each place for guests to write a favorite memory or wish.']];
}

async function callGemini(prompt, json = false) {
  const configuredModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const model = configuredModel === 'gemini-2.5-flash-lite' ? 'gemini-3.5-flash-lite' : configuredModel;
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env['GEMINI_' + 'API_KEY'], 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: prompt,
      store: false,
      generation_config: { temperature: json ? 0.8 : 0.7 },
    }),
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const detail = String(data.error?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 400);
    throw new Error(`Gemini API error ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const text = (data.steps || []).filter(step => step.type === 'model_output').flatMap(step => step.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned an empty response');
  return text;
}

async function generateIdeas(plan) {
  if (!process.env['GEMINI_' + 'API_KEY'] && !process.env.OPENAI_API_KEY) return fallbackIdeas(plan);
  if (process.env['GEMINI_' + 'API_KEY']) {
    const raw = await callGemini(`You are Jashn, a warm event planning helper. Return JSON only: {\"ideas\":[[\"short title\",\"one practical personal idea\"]]}. Give exactly 3 distinct ideas. Do not invent vendor availability or prices. Event details: ${JSON.stringify(plan)}`, true);
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\\s*|\\s*```$/g, ''));
    if (!Array.isArray(parsed.ideas) || !parsed.ideas.length) throw new Error('AI returned no ideas');
    return parsed.ideas.slice(0,3).map(row => [String(row[0] || 'An idea').slice(0,80),String(row[1] || '').slice(0,400)]);
  }
  const answer = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0.8,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are Jashn, a warm, imaginative event planning helper. Return JSON only: {"ideas":[["short title","one practical, personal idea"], ...]}. Give exactly 3 distinct, doable ideas. Do not invent vendor availability or prices.' },
        { role: 'user', content: JSON.stringify(plan) },
      ],
    }),
  });
  if (!answer.ok) throw new Error(`AI provider returned ${answer.status}`);
  const data = await answer.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  if (!Array.isArray(parsed.ideas) || parsed.ideas.length < 1) throw new Error('AI returned no ideas');
  return parsed.ideas.slice(0, 3).map(row => [String(row[0] || 'An idea').slice(0, 80), String(row[1] || '').slice(0, 400)]);
}

async function generateChatReply(message, event) {
  if (process.env['GEMINI_' + 'API_KEY']) {
    const prompt = `You are Jashn, a friendly practical event-planning assistant. Be concise and helpful. Treat event context as facts only when explicitly present; never infer missing event type, guest count, budget, location, or preferences. If a missing detail is necessary, ask a brief follow-up; otherwise give useful general guidance. Help users plan and evaluate vendors they add themselves; never invent real businesses, availability, or quotes. Do not claim to book vendors or send notifications. For prices, say estimates depend on location and vendor. Event context: ${JSON.stringify(event)}\n\nUser question: ${message}`;
    return (await callGemini(prompt)).slice(0, 3000);
  }
  if (!process.env.OPENAI_API_KEY) return `I can help you think through ${event?.name || event?.type || 'your celebration'}. Start with your guest count, date, budget, and the feeling you want guests to remember. For “${message.slice(0, 160)}”, try breaking it into one practical next step, one owner, and a deadline. Add GEMINI_API_KEY to .env to enable Gemini replies.`;
  const answer = await fetch('https://api.openai.com/v1/chat/completions', { method:'POST', headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'}, body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-4o-mini',temperature:.7,max_tokens:500,messages:[{role:'system',content:'You are Jashn, a friendly and practical event-planning assistant. Give concise, useful answers. Do not claim to book vendors or send notifications. For prices, explain that estimates depend on the location and vendor.'},{role:'user',content:JSON.stringify({event,message})}]}) });
  if (!answer.ok) throw new Error(`AI provider returned ${answer.status}`);
  const data=await answer.json();return String(data.choices?.[0]?.message?.content||'I could not form a response. Try asking another way.').slice(0,3000);
}

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/firebase-messaging-sw.js') {
      const config = publicFirebaseConfig();
      const worker = `importScripts('https://www.gstatic.com/firebasejs/13.1.0/firebase-app-compat.js','https://www.gstatic.com/firebasejs/13.1.0/firebase-messaging-compat.js');
firebase.initializeApp(${JSON.stringify({apiKey:config.apiKey,authDomain:config.authDomain,projectId:config.projectId,appId:config.appId,messagingSenderId:config.messagingSenderId})});
const messaging=firebase.messaging();
messaging.onBackgroundMessage(payload=>{const data=payload.data||{};self.registration.showNotification(data.title||'Jashn reminder',{body:data.body||'A moment on your celebration timeline is coming up.',icon:'/jashn-logo-transparent.png',badge:'/jashn-logo-transparent.png',data:{url:data.url||'/'}})});
self.addEventListener('notificationclick',event=>{event.notification.close();const target=new URL(event.notification.data?.url||'/',self.location.origin).href;event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(windows=>{for(const client of windows){if(new URL(client.url).origin===self.location.origin){client.focus();return client.navigate(target)}}return clients.openWindow(target)}))});`;
      return send(res, 200, worker, 'text/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/config/firebase') {
      const config = publicFirebaseConfig();
      const webConfigured = Boolean(config.apiKey && config.projectId && config.appId);
      const adminConfigured = Boolean(firebaseAuth && firestore && hasAdminCredentials());
      return send(res, 200, { configured: webConfigured && adminConfigured, webConfigured, adminConfigured, config });
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, database: 'cloud-firestore', firebaseConfigured: Boolean(publicFirebaseConfig().apiKey && firebaseAuth && firestore && hasAdminCredentials()), aiEnabled: activeAiProvider() !== 'built-in', aiProvider: activeAiProvider() });
    if (req.method === 'GET' && url.pathname === '/api/me') {
      if (!req.headers.authorization) return send(res, 200, { user: null });
      const user = await requireFirebaseUser(req, res);
      return user ? send(res, 200, { user }) : undefined;
    }
    if (req.method === 'GET' && url.pathname === '/api/notifications/status') {
      const user = await requireFirebaseUser(req, res); if (!user) return;
      const token = String(url.searchParams.get('token') || '').trim();
      if (token) {
        const tokenId = createHash('sha256').update(token).digest('hex');
        const device = await firestore.collection('users').doc(user.id).collection('devices').doc(tokenId).get();
        return send(res, 200, { enabled: device.exists });
      }
      const devices = await firestore.collection('users').doc(user.id).collection('devices').limit(1).get();
      return send(res, 200, { enabled: !devices.empty });
    }
    if ((req.method === 'POST' || req.method === 'DELETE') && url.pathname === '/api/notifications/device') {
      const user = await requireFirebaseUser(req, res); if (!user) return;
      const input = await bodyJson(req), token = String(input.token || '').trim();
      if (!token || token.length > 4096) return send(res, 400, { error: 'A valid notification registration is required' });
      const tokenId = createHash('sha256').update(token).digest('hex');
      const deviceRef = firestore.collection('users').doc(user.id).collection('devices').doc(tokenId);
      if (req.method === 'DELETE') await deviceRef.delete();
      else {
        const oldDevices = await firestore.collectionGroup('devices').where('token', '==', token).get();
        await Promise.all(oldDevices.docs.filter(doc => doc.ref.parent.parent?.id !== user.id).map(doc => doc.ref.delete()));
        const origin = String(input.origin || '').slice(0, 500);
        await deviceRef.set({ token, origin: /^https?:\/\//i.test(origin) ? origin : '', updatedAt: new Date().toISOString(), userAgent: String(req.headers['user-agent'] || '').slice(0, 300) }, { merge: true });
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && url.pathname === '/api/profile') {
      const user = await requireFirebaseUser(req, res); if (!user) return;
      const input = await bodyJson(req), name = String(input.name || '').trim().slice(0, 80), phone = String(input.phone || '').trim().slice(0, 40);
      if (!name) return send(res, 400, { error: 'Enter your name' });
      await firebaseAuth.updateUser(user.id, { displayName: name });
      await firestore.collection('users').doc(user.id).set({ name, phone, email: user.email, updatedAt: new Date().toISOString() }, { merge: true });
      return send(res, 200, { user: { ...user, name, phone } });
    }
    if (req.method === 'GET' && url.pathname === '/api/plans') {
      const user = await requireFirebaseUser(req, res); if (!user) return;
      const snapshot = await firestore.collection('users').doc(user.id).collection('plans').orderBy('createdAt', 'desc').get();
      return send(res, 200, snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    }
    if (req.method === 'POST' && url.pathname === '/api/plans') {
      const user = await requireFirebaseUser(req, res); if (!user) return;
      const input = await bodyJson(req), plan = cleanPlan(input), now = new Date().toISOString();
      const saved = { ...plan, eventData: input.eventData && typeof input.eventData === 'object' ? input.eventData : {}, createdAt: now, updatedAt: now };
      const ref = await firestore.collection('users').doc(user.id).collection('plans').add(saved);
      return send(res, 201, { id: ref.id, ...saved });
    }
    const planMatch = url.pathname.match(/^\/api\/plans\/([\w-]+)$/);
    if (req.method === 'PUT' && planMatch) {
      const user = await requireFirebaseUser(req, res); if (!user) return;
      const input = await bodyJson(req), plan = cleanPlan(input), ref = firestore.collection('users').doc(user.id).collection('plans').doc(planMatch[1]);
      const existing = await ref.get(); if (!existing.exists) return send(res, 404, { error: 'Event not found' });
      const updated = { ...plan, eventData: input.eventData && typeof input.eventData === 'object' ? input.eventData : {}, updatedAt: new Date().toISOString() };
      await ref.set(updated, { merge: true });
      return send(res, 200, { id: ref.id, ...existing.data(), ...updated });
    }
    if (req.method === 'DELETE' && planMatch) {
      const user = await requireFirebaseUser(req, res); if (!user) return;
      const ref = firestore.collection('users').doc(user.id).collection('plans').doc(planMatch[1]), existing = await ref.get();
      if (!existing.exists) return send(res, 404, { error: 'Plan not found' });
      await ref.delete(); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/ideas') {
      const plan = cleanPlan(await bodyJson(req));
      try { return send(res, 200, { ideas: await generateIdeas(plan), source: activeAiProvider() }); }
      catch (err) { console.error('Idea generation failed:', err.message); return send(res, 200, { ideas: fallbackIdeas(plan), source: 'built-in' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const user = await requireFirebaseUser(req, res); if (!user) return;
      const input = await bodyJson(req), message = String(input.message || '').trim().slice(0, 1000);
      if (!message) return send(res, 400, { error: 'Ask a planning question' });
      try { return send(res, 200, { reply: await generateChatReply(message, input.event || {}), source: activeAiProvider() }); }
      catch (error) { console.error('Chat response failed:', error.message); return send(res, 502, { error: error.message.startsWith('Gemini API error ') ? error.message : 'The planning helper is temporarily unavailable. Check the server terminal for details.' }); }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    let requested;
    try {
      requested = decodeURIComponent(url.pathname === '/' || url.pathname === '/index.html' ? '/planner.html' : url.pathname);
    } catch {
      return send(res, 400, { error: 'Invalid URL path' });
    }
    const file = resolve(ROOT, `.${requested}`);
    // path.resolve removes the trailing separator from ROOT, so compare with a
    // single platform separator here (ROOT itself is not a valid file path).
    if (file === ROOT || !file.startsWith(ROOT + sep)) return send(res, 403, { error: 'Forbidden' });
    const content = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': extname(file) === '.html'
        ? 'public, max-age=0, must-revalidate'
        : 'public, max-age=86400, stale-while-revalidate=604800',
    });
    return req.method === 'HEAD' ? res.end() : res.end(content);
  } catch (err) {
    const status = err.status || (err.code === 'ENOENT' ? 404 : err instanceof URIError ? 400 : 500);
    return send(res, status, { error: err.status || err instanceof URIError ? err.message : 'Server error' });
  }
};

export default handler;

// Vercel imports the request handler from api/[...path].mjs. For local use,
// keep the existing `npm start` standalone HTTP server behavior.
if (!process.env.VERCEL) {
  createServer(handler).listen(PORT, process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1', () => console.log(`Jashn is ready at http://127.0.0.1:${PORT}`));
}
