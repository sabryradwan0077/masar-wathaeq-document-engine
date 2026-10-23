import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let server: import('node:http').Server;
let providerServer: Server;
let baseUrl: string;
let providerUrl: string;
let database: typeof import('../app/database.mjs');
let tempDir: string;
const providerRequests: Array<{ url: string; payload: unknown }> = [];

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'masar-app-test-'));
  process.env.MASAR_DATABASE_PATH = path.join(tempDir, 'test.sqlite');
  process.env.AI_API_KEY = '';
  process.env.TAVILY_API_KEY = '';
  process.env.SMTP_URL = '';
  process.env.SMTP_FROM = '';
  database = await import('../app/database.mjs');
  const { createAppServer } = await import('../app/server.mjs');
  server = createAppServer();
  providerServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const payload = request.headers['content-type']?.includes('application/json')
        ? JSON.parse(body.toString('utf8'))
        : body.toString('utf8');
      providerRequests.push({ url: request.url ?? '', payload });
      if (request.url === '/v1/chat/completions') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: 'تم إنجاز الطلب التجريبي.' } }] }));
      } else if (request.url === '/v1/audio/transcriptions') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ text: 'نص مفرغ من التسجيل.' }));
      } else if (request.url === '/v1/audio/speech') {
        response.writeHead(200, { 'content-type': 'audio/mpeg' });
        response.end(Buffer.from('fake-mp3-audio'));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const providerAddress = providerServer.address();
  assert.ok(providerAddress && typeof providerAddress !== 'string');
  providerUrl = `http://127.0.0.1:${providerAddress.port}`;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => providerServer.close((error) => error ? reject(error) : resolve()));
  database.db.close();
  await rm(tempDir, { recursive: true, force: true });
});

async function api(
  route: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.method && options.method !== 'GET' ? { origin: baseUrl } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return {
    response,
    body: response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text(),
  };
}

test('registration creates an authenticated account with isolated conversations', async () => {
  const registration = await api('/api/auth/register', {
    method: 'POST',
    body: { displayName: 'مستخدم أول', email: 'first@example.test', password: 'a-strong-password' },
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.body.user.email, 'first@example.test');
  const firstCookie = registration.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(firstCookie?.startsWith('masar_session='));
  assert.match(registration.response.headers.get('set-cookie') ?? '', /HttpOnly/);

  const session = await api('/api/auth/session', { cookie: firstCookie });
  assert.equal(session.body.user.id, registration.body.user.id);

  const created = await api('/api/conversations', { method: 'POST', cookie: firstCookie, body: {} });
  assert.equal(created.response.status, 201);
  const conversationId = created.body.conversation.id;

  const chat = await api('/api/chat', {
    method: 'POST',
    cookie: firstCookie,
    body: { conversationId, message: 'مرحبا' },
  });
  assert.equal(chat.response.status, 503);
  assert.match(chat.body.error, /مفتاح مزود الذكاء الاصطناعي/);

  const persisted = await api(`/api/conversations/${conversationId}`, { cookie: firstCookie });
  assert.equal(persisted.body.conversation.messages.length, 1);
  assert.equal(persisted.body.conversation.messages[0].content, 'مرحبا');

  const agent = await api('/api/agents', {
    method: 'POST',
    cookie: firstCookie,
    body: { name: 'باحث', instructions: 'ابحث بدقة.', tools: ['web_search'] },
  });
  assert.equal(agent.response.status, 200);
  assert.deepEqual(agent.body.agent.tools, ['web_search']);

  const document = await api('/api/documents', {
    method: 'POST',
    cookie: firstCookie,
    body: { title: 'مسودة محفوظة', content: 'محتوى عربي' },
  });
  assert.equal(document.response.status, 200);
  assert.equal(document.body.document.content, 'محتوى عربي');

  const secondRegistration = await api('/api/auth/register', {
    method: 'POST',
    body: { displayName: 'مستخدم ثانٍ', email: 'second@example.test', password: 'another-strong-password' },
  });
  assert.equal(secondRegistration.response.status, 201);
  const secondCookie = secondRegistration.response.headers.get('set-cookie')?.split(';')[0];
  const privateConversation = await api(`/api/conversations/${conversationId}`, { cookie: secondCookie });
  assert.equal(privateConversation.response.status, 404);
  const privateAgent = await api(`/api/agents/${agent.body.agent.id}/run`, {
    method: 'POST',
    cookie: secondCookie,
    body: { prompt: 'نفذ المهمة.' },
  });
  assert.equal(privateAgent.response.status, 404);
  const privateDocument = await api(`/api/documents/${document.body.document.id}`, { cookie: secondCookie });
  assert.equal(privateDocument.response.status, 404);
});

test('authentication rejects bad passwords and enforces session access', async () => {
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'first@example.test', password: 'incorrect-password' },
  });
  assert.equal(login.response.status, 401);

  const unauthenticated = await api('/api/agents');
  assert.equal(unauthenticated.response.status, 401);

  const duplicate = await api('/api/auth/register', {
    method: 'POST',
    body: { displayName: 'Duplicate', email: 'first@example.test', password: 'a-strong-password' },
  });
  assert.equal(duplicate.response.status, 409);
});

test('multimodal chat, speech, and generated document use the configured provider', async () => {
  process.env.AI_API_KEY = 'test-provider-key';
  process.env.AI_API_BASE_URL = `${providerUrl}/v1`;
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'first@example.test', password: 'a-strong-password' },
  });
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const created = await api('/api/conversations', { method: 'POST', cookie, body: {} });
  const conversationId = created.body.conversation.id;

  const imageChat = await api('/api/chat', {
    method: 'POST',
    cookie,
    body: {
      conversationId,
      message: 'ما الذي يظهر في الصورة؟',
      image: { mimeType: 'image/png', dataBase64: 'aGVsbG8=' },
    },
  });
  assert.equal(imageChat.response.status, 200);
  const chatRequest = providerRequests.find((entry) => entry.url === '/v1/chat/completions');
  assert.ok(chatRequest);
  assert.match(JSON.stringify(chatRequest.payload), /data:image\/png;base64,aGVsbG8=/);
  assert.doesNotMatch(JSON.stringify(imageChat.body.conversation), /aGVsbG8=/);

  const transcription = await api('/api/audio/transcribe', {
    method: 'POST', cookie, body: { mimeType: 'audio/webm', dataBase64: 'AA==' },
  });
  assert.equal(transcription.body.text, 'نص مفرغ من التسجيل.');
  const speechResponse = await fetch(`${baseUrl}/api/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl, cookie: cookie! },
    body: JSON.stringify({ text: 'مرحبًا' }),
  });
  assert.equal(speechResponse.status, 200);
  assert.match(speechResponse.headers.get('content-type') ?? '', /audio\/mpeg/);
  assert.equal(Buffer.from(await speechResponse.arrayBuffer()).toString(), 'fake-mp3-audio');

  const generated = await api('/api/documents/generate', {
    method: 'POST', cookie, body: { title: 'خطاب تجريبي', prompt: 'اكتب خطابًا رسميًا.' },
  });
  assert.equal(generated.response.status, 200);
  const saved = await api(`/api/documents/${generated.body.document.id}`, { cookie });
  assert.equal(saved.body.document.content, 'تم إنجاز الطلب التجريبي.');
});

test('integration routes report configuration errors instead of faking success', async () => {
  const account = database.db.prepare('SELECT id FROM users WHERE email = ?').get('first@example.test') as { id: string } | undefined;
  assert.ok(account);
  const token = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'first@example.test', password: 'a-strong-password' },
  });
  const cookie = token.response.headers.get('set-cookie')?.split(';')[0];
  const search = await api('/api/search', {
    method: 'POST', cookie, body: { query: 'بحث تجريبي' },
  });
  assert.equal(search.response.status, 503);
  const unconfirmed = await api('/api/integrations/email/send', {
    method: 'POST', cookie, body: { to: 'person@example.test', subject: 'مرحبًا', text: 'نص', confirmed: false },
  });
  assert.equal(unconfirmed.response.status, 400);
});
