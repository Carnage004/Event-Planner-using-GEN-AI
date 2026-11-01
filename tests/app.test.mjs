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

test('unknown API methods fail closed', async () => {
  const response = await request('DELETE', '/api/health');
  assert.equal(response.status, 405);
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
