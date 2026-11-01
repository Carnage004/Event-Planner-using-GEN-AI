import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Prevent server.mjs from binding a port; these tests exercise its real handler directly.
process.env.VERCEL = '1';
const { default: handler, cleanPlan, fallbackIdeas } = await import('../server.mjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function request(method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method;
  req.url = url;
  req.headers = { host: 'jashn.test', ...headers };
  const response = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, responseHeaders) {
      this.status = status;
      this.headers = responseHeaders;
    },
    end(data = '') { this.body = String(data); },
  };
  await handler(req, response);
  return response;
}

test('health endpoint reports service status without exposing credentials', async () => {
  const response = await request('GET', '/api/health');
  const payload = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.database, 'cloud-firestore');
  assert.ok(['gemini', 'openai', 'built-in'].includes(payload.aiProvider));
  assert.equal(JSON.stringify(payload).includes('AIza'), false);
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
});

test('Firebase config endpoint exposes only public client settings', async () => {
  const response = await request('GET', '/api/config/firebase');
  const payload = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.equal(typeof payload.webConfigured, 'boolean');
  assert.equal(typeof payload.adminConfigured, 'boolean');
  assert.equal(typeof payload.config.projectId, 'string');
  assert.equal('privateKey' in payload.config, false);
  assert.equal('serviceAccount' in payload.config, false);
});

test('signed-out user endpoint returns an empty session', async () => {
  const response = await request('GET', '/api/me');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { user: null });
});

test('plans API rejects requests without a verified account', async () => {
  const response = await request('GET', '/api/plans');
  assert.ok([401, 503].includes(response.status));
  const payload = JSON.parse(response.body);
  assert.equal(typeof payload.error, 'string');
  assert.equal(Array.isArray(payload), false);
});

test('protected endpoints fail closed when server credentials are unavailable', async () => {
  const names = ['FIREBASE_SERVICE_ACCOUNT_JSON', 'GOOGLE_APPLICATION_CREDENTIALS', 'K_SERVICE', 'GAE_ENV'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/path/that/does/not/exist.json';
    delete process.env.K_SERVICE;
    delete process.env.GAE_ENV;
    const protectedRoutes = [
      ['GET', '/api/notifications/status'],
      ['POST', '/api/notifications/device'],
      ['PUT', '/api/profile'],
      ['GET', '/api/plans'],
      ['POST', '/api/plans'],
      ['PUT', '/api/plans/plan-1'],
      ['DELETE', '/api/plans/plan-1'],
      ['POST', '/api/chat'],
    ];
    for (const [method, url] of protectedRoutes) {
      const response = await request(method, url);
      assert.equal(response.status, 503, `${method} ${url} should fail closed without admin credentials`);
    }
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('API rejects malformed JSON with a client error', async () => {
  const response = await request('POST', '/api/ideas', '{invalid json', { 'content-type': 'application/json' });
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.body).error, /valid JSON/i);
});

test('API rejects oversized request bodies', async () => {
  const body = JSON.stringify({ note: 'x'.repeat(50_100) });
  const response = await request('POST', '/api/ideas', body, { 'content-type': 'application/json' });
  assert.equal(response.status, 413);
});

test('request size limit counts UTF-8 bytes, not just characters', async () => {
  const body = JSON.stringify({ note: '🎉'.repeat(13_000) });
  const response = await request('POST', '/api/ideas', body, { 'content-type': 'application/json' });
  assert.equal(response.status, 413);
});

test('unknown API methods fail closed', async () => {
  const response = await request('DELETE', '/api/health');
  assert.equal(response.status, 405);
});

test('unknown API routes return not found', async () => {
  const response = await request('GET', '/api/not-a-route');
  assert.equal(response.status, 404);
});

test('malformed percent encoding is rejected as a client error', async () => {
  const response = await request('GET', '/bad%ZZpath');
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.body).error, /invalid url path/i);
});

test('static HEAD requests return headers without a response body', async () => {
  const response = await request('HEAD', '/');
  assert.equal(response.status, 200);
  assert.equal(response.body, '');
  assert.match(response.headers['Content-Type'], /text\/html/);
  assert.match(response.headers['Cache-Control'], /must-revalidate/);
});

test('logo is served as a compact, cacheable JPEG asset', async () => {
  const response = await request('HEAD', '/jashn-logo-gradient.jpg');
  assert.equal(response.status, 200);
  assert.match(response.headers['Content-Type'], /image\/jpeg/);
  assert.match(response.headers['Cache-Control'], /max-age=86400/);
  assert.equal(response.body, '');
});

test('messaging service worker is served from the site root', async () => {
  const response = await request('GET', '/firebase-messaging-sw.js');
  assert.equal(response.status, 200);
  assert.match(response.headers['Content-Type'], /javascript/);
  assert.match(response.body, /onBackgroundMessage/);
  assert.match(response.body, /notificationclick/);
});

test('idea endpoint returns useful built-in ideas when provider keys are absent', async () => {
  const previousGemini = process.env.GEMINI_API_KEY;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const response = await request('POST', '/api/ideas', JSON.stringify({ type: 'Community gathering' }), { 'content-type': 'application/json' });
    const payload = JSON.parse(response.body);
    assert.equal(response.status, 200);
    assert.equal(payload.source, 'built-in');
    assert.equal(payload.ideas.length, 3);
    assert.match(payload.ideas[0][1], /name tags/i);
  } finally {
    if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGemini;
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
  }
});

test('Gemini idea generation parses model output and reports its source', async () => {
  const previousGemini = process.env.GEMINI_API_KEY;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  try {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.OPENAI_API_KEY;
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /generativelanguage\.googleapis\.com/);
      assert.equal(options.headers['x-goog-api-key'], 'test-key');
      return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"ideas":[["A welcome table","Offer a seasonal drink."],["A memory wall","Invite guests to share a note."],["A quiet corner","Set aside a calm seating area."] ]}' }] }] }), { status: 200 });
    };
    const response = await request('POST', '/api/ideas', JSON.stringify({ type: 'Birthday' }), { 'content-type': 'application/json' });
    const payload = JSON.parse(response.body);
    assert.equal(response.status, 200);
    assert.equal(payload.source, 'gemini');
    assert.equal(payload.ideas.length, 3);
    assert.equal(payload.ideas[0][0], 'A welcome table');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGemini;
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
  }
});

test('AI provider failures fall back to built-in ideas instead of failing the request', async () => {
  const previousGemini = process.env.GEMINI_API_KEY;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  try {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.OPENAI_API_KEY;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'temporary test failure' } }), { status: 503 });
    const response = await request('POST', '/api/ideas', JSON.stringify({ type: 'Wedding' }), { 'content-type': 'application/json' });
    const payload = JSON.parse(response.body);
    assert.equal(response.status, 200);
    assert.equal(payload.source, 'built-in');
    assert.match(payload.ideas[0][0], /welcome/i);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGemini;
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
  }
});

test('OpenAI idea generation validates and returns structured ideas', async () => {
  const previousGemini = process.env.GEMINI_API_KEY;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  try {
    delete process.env.GEMINI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    globalThis.fetch = async (_url, options) => {
      assert.match(options.headers.Authorization, /^Bearer test-openai-key$/);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ideas":[["Shared playlist","Ask guests for favorite songs."]]}' } }] }), { status: 200 });
    };
    const response = await request('POST', '/api/ideas', JSON.stringify({ type: 'Birthday' }), { 'content-type': 'application/json' });
    const payload = JSON.parse(response.body);
    assert.equal(response.status, 200);
    assert.equal(payload.source, 'openai');
    assert.equal(payload.ideas[0][0], 'Shared playlist');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGemini;
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
  }
});

test('plan input is normalized, bounded, and safe for unexpected JSON shapes', () => {
  const normalized = cleanPlan({ name: '  Maya birthday  ', type: 'Birthday', guests: -5, budget: -20, note: 'n'.repeat(1700) });
  assert.equal(normalized.name, 'Maya birthday');
  assert.equal(normalized.guests, 1);
  assert.equal(normalized.budget, 0);
  assert.equal(normalized.note.length, 1500);

  const bounded = cleanPlan({ name: 'x'.repeat(200), guests: 20_000, budget: 2_000_000_000 });
  assert.equal(bounded.name.length, 120);
  assert.equal(bounded.guests, 10_000);
  assert.equal(bounded.budget, 1_000_000_000);
  assert.equal(cleanPlan(null).name, 'My celebration');
  assert.equal(cleanPlan([]).name, 'My celebration');
});

test('built-in idea suggestions adapt to the selected celebration type', () => {
  const weddingIdeas = fallbackIdeas({ type: 'Wedding' });
  const communityIdeas = fallbackIdeas({ type: 'Community gathering' });
  assert.equal(weddingIdeas.length, 3);
  assert.equal(communityIdeas.length, 3);
  assert.match(weddingIdeas[0][0], /welcome/i);
  assert.match(communityIdeas[0][1], /name tags/i);
});

test('static site serves a mobile viewport and responsive navigation', async () => {
  const response = await request('GET', '/');
  assert.equal(response.status, 200);
  assert.match(response.body, /name="viewport" content="width=device-width,initial-scale=1"/);
  assert.match(response.body, /side-nav-backdrop/);
  assert.match(response.body, /@media\s*\(max-width:\s*760px\)/);
});

test('interactive controls expose labels, current navigation, and keyboard focus styling', async () => {
  const response = await request('GET', '/');
  const html = response.body;
  for (const id of ['authEmail', 'authPassword', 'eventName', 'eventType', 'eventDate', 'eventTime', 'eventVenue', 'eventGuests', 'eventBudget', 'eventVibe', 'eventNote', 'ideaNote', 'budgetTotalInput']) {
    assert.match(html, new RegExp(`<label for="${id}">`), `Missing associated label for ${id}`);
  }
  assert.match(html, /id="chatInput" aria-label="Ask a planning question"/);
  assert.match(html, /aria-controls="chatPanel" aria-expanded="false"/);
  assert.match(html, /:focus-visible/);
});

test('static file handler blocks encoded path traversal', async () => {
  const response = await request('GET', '/..%2f.env');
  assert.equal(response.status, 403);
  assert.doesNotMatch(response.body, /FIREBASE_API_KEY|GEMINI_API_KEY/);
});

test('static file handler never exposes environment files, server code, or project configuration', async () => {
  for (const path of ['/.env', '/.env.example', '/server.mjs', '/package.json', '/firestore.rules', '/api/[...path].mjs']) {
    const response = await request('GET', path);
    assert.equal(response.status, 404, `${path} must not be publicly served`);
    assert.doesNotMatch(response.body, /FIREBASE_API_KEY|GEMINI_API_KEY|private_key/i);
  }
});

test('planner and required public assets remain available after static route restriction', async () => {
  for (const path of ['/planner.html', '/manifest.webmanifest', '/jashn-logo-gradient.jpg', '/jashn-logo-transparent.png']) {
    const response = await request('HEAD', path);
    assert.equal(response.status, 200, `${path} should remain available`);
    assert.equal(response.body, '');
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  }
});
