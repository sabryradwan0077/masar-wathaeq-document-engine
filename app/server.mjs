import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSessionToken,
  expiredSessionCookie,
  hashPassword,
  hashToken,
  sessionCookie,
  sessionExpiry,
  SESSION_COOKIE,
  verifyPassword,
} from './auth.mjs';
import {
  createSession,
  createUser,
  deleteAgent,
  deleteConversation,
  deleteDocument,
  deleteSession,
  getDocument,
  getAgent,
  getConversation,
  getActiveSubscription,
  getSessionUser,
  getUserByEmail,
  listAgents,
  listConversations,
  listDocuments,
  listPaymentRequests,
  listPendingPaymentRequests,
  createPaymentRequest,
  saveAgent,
  saveConversation,
  saveDocument,
  reviewPaymentRequest,
  isUniqueConstraintError,
} from './database.mjs';
import { IntegrationError, integrationStatus, sendEmail, webSearch } from './integrations.mjs';

const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
const maxJsonBytes = 20_000_000;
const authAttempts = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxJsonBytes) throw new HttpError(413, 'الطلب أكبر من الحجم المسموح.');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid JSON shape');
    return parsed;
  } catch {
    throw new HttpError(400, 'تعذر قراءة بيانات الطلب.');
  }
}

function requireText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new HttpError(400, `يرجى إدخال ${label} بشكل صحيح.`);
  }
  return value.trim();
}

function requireUuid(value, label) {
  const id = requireText(value, label, 64);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
    throw new HttpError(400, `${label} غير صالح.`);
  }
  return id;
}

function parseMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) {
    throw new HttpError(400, 'أرسل رسالة واحدة على الأقل، وبحد أقصى 40 رسالة.');
  }
  let totalLength = 0;
  const messages = value.map((message) => {
    if (!message || !['user', 'assistant'].includes(message.role)) {
      throw new HttpError(400, 'تنسيق المحادثة غير صالح.');
    }
    const content = requireText(message.content, 'نص الرسالة', 16_000);
    totalLength += content.length;
    if (totalLength > 60_000) throw new HttpError(400, 'المحادثة أطول من الحد المسموح.');
    return { role: message.role, content };
  });
  if (!messages.some((message) => message.role === 'user')) {
    throw new HttpError(400, 'يجب أن تتضمن المحادثة رسالة من المستخدم.');
  }
  return messages;
}

function getRequestToken(request) {
  const cookieHeader = request.headers.cookie ?? '';
  const cookies = cookieHeader.split(';').map((cookie) => cookie.trim());
  const cookie = cookies.find((item) => item.startsWith(`${SESSION_COOKIE}=`));
  return cookie?.slice(SESSION_COOKIE.length + 1) || '';
}

async function getUser(request) {
  const token = getRequestToken(request);
  if (!token) return null;
  return (await getSessionUser(hashToken(token))) ?? null;
}

async function requireUser(request) {
  const user = await getUser(request);
  if (!user) throw new HttpError(401, 'سجّل الدخول للمتابعة.');
  return user;
}

function isBillingAdmin(user) {
  const adminEmail = process.env.BILLING_ADMIN_EMAIL?.trim().toLowerCase();
  return Boolean(adminEmail && user.email.toLowerCase() === adminEmail);
}

function requireBillingAdmin(user, request) {
  if (!isBillingAdmin(user)) throw new HttpError(403, 'هذه الصفحة مخصصة لمسؤول الاشتراكات.');
  const expected = process.env.BILLING_ADMIN_KEY?.trim();
  if (!expected) throw new HttpError(503, 'اضبط BILLING_ADMIN_KEY على الخادم لتفعيل مراجعة الاشتراكات.');
  const supplied = request.headers['x-billing-admin-key'];
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(typeof supplied === 'string' ? supplied : '');
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw new HttpError(403, 'تعذر التحقق من صلاحية مسؤول الاشتراكات.');
  }
}

function billingConfig() {
  const price = Number.parseInt(process.env.MONTHLY_PRICE_EGP ?? '200', 10);
  if (!Number.isSafeInteger(price) || price < 1) throw new HttpError(500, 'إعداد سعر الاشتراك غير صالح.');
  return {
    monthlyPriceEgp: price,
    paymentNumber: process.env.VODAFONE_CASH_NUMBER?.trim() || '+201015707603',
    adminConfigured: Boolean(process.env.BILLING_ADMIN_EMAIL?.trim()),
  };
}

async function requireActiveSubscription(user) {
  if (!(await getActiveSubscription(user.id))) {
    throw new HttpError(402, 'فعّل اشتراكك الشهري أولًا لاستخدام ميزات الذكاء الاصطناعي.');
  }
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, 'مصدر الطلب غير مسموح.');
  }
  if (parsed.host !== request.headers.host) throw new HttpError(403, 'مصدر الطلب غير مسموح.');
}

function secureCookie(request) {
  return request.headers['x-forwarded-proto'] === 'https';
}

function checkAuthRateLimit(request) {
  const key = request.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const bucket = authAttempts.get(key);
  if (bucket && now - bucket.startedAt < 15 * 60_000 && bucket.count >= 10) {
    throw new HttpError(429, 'محاولات كثيرة. انتظر قليلًا ثم حاول مجددًا.');
  }
  if (!bucket || now - bucket.startedAt >= 15 * 60_000) {
    authAttempts.set(key, { count: 1, startedAt: now });
  } else {
    bucket.count += 1;
  }
}

function validateImage(image) {
  if (!image || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(image.mimeType)) {
    throw new HttpError(400, 'صيغة الصورة غير مدعومة.');
  }
  if (typeof image.dataBase64 !== 'string' || image.dataBase64.length === 0 || image.dataBase64.length > 8_000_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.dataBase64)) {
    throw new HttpError(400, 'حجم الصورة أو بياناتها غير صالحة (الحد الأقصى 6 ميغابايت).');
  }
  return image;
}

async function readProviderResponse(response) {
  let result;
  try {
    result = await response.json();
  } catch {
    throw new HttpError(502, 'أعاد مزود الذكاء الاصطناعي استجابة غير مفهومة.');
  }
  if (!response.ok) {
    console.error(`AI provider returned HTTP ${response.status}`);
    throw new HttpError(502, 'تعذر إكمال الطلب لدى مزود الذكاء الاصطناعي. تحقق من إعدادات المزود.');
  }
  return result;
}

function getAiConfig() {
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!apiKey) throw new HttpError(503, 'أضف مفتاح مزود الذكاء الاصطناعي إلى ملف .env أولًا.');
  const baseUrl = (process.env.AI_API_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  return { apiKey, baseUrl };
}

async function requestAi(messages, systemPrompt, image) {
  const { apiKey, baseUrl } = getAiConfig();
  const requestMessages = [{ role: 'system', content: systemPrompt }, ...messages];
  if (image) {
    const lastUserIndex = requestMessages.findLastIndex((message) => message.role === 'user');
    const message = requestMessages[lastUserIndex];
    requestMessages[lastUserIndex] = {
      role: 'user',
      content: [
        { type: 'text', text: message.content },
        { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` } },
      ],
    };
  }

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: image ? (process.env.AI_VISION_MODEL?.trim() || process.env.AI_MODEL?.trim() || 'gpt-4o-mini') : (process.env.AI_MODEL?.trim() || 'gpt-4o-mini'),
        messages: requestMessages,
        temperature: 0.5,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new HttpError(504, 'استغرق مزود الذكاء الاصطناعي وقتًا أطول من المتوقع.');
    throw new HttpError(502, 'تعذر الاتصال بمزود الذكاء الاصطناعي.');
  }
  const result = await readProviderResponse(response);
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(502, 'لم يُرجع مزود الذكاء الاصطناعي نصًا صالحًا.');
  return content.trim();
}

async function transcribeAudio(input) {
  const { apiKey, baseUrl } = getAiConfig();
  const allowedTypes = new Map([
    ['audio/webm', 'recording.webm'], ['audio/mp4', 'recording.mp4'], ['audio/mpeg', 'recording.mp3'],
    ['audio/wav', 'recording.wav'], ['audio/ogg', 'recording.ogg'], ['audio/x-m4a', 'recording.m4a'],
  ]);
  const filename = allowedTypes.get(input.mimeType);
  if (!filename || typeof input.dataBase64 !== 'string' || input.dataBase64.length === 0 || input.dataBase64.length > 20_000_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64)) {
    throw new HttpError(400, 'صيغة التسجيل أو حجمه غير صالح.');
  }
  const form = new FormData();
  form.set('file', new Blob([Buffer.from(input.dataBase64, 'base64')], { type: input.mimeType }), filename);
  form.set('model', process.env.AI_TRANSCRIPTION_MODEL?.trim() || 'whisper-1');
  let response;
  try {
    response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new HttpError(502, 'تعذر الاتصال بخدمة تحويل الصوت إلى نص.');
  }
  const result = await readProviderResponse(response);
  if (typeof result.text !== 'string') throw new HttpError(502, 'لم يُرجع مزود الذكاء الاصطناعي نصًا صالحًا.');
  return result.text;
}

async function synthesizeSpeech(input, response) {
  const text = requireText(input.text, 'نص الرد الصوتي', 4_000);
  const { apiKey, baseUrl } = getAiConfig();
  let result;
  try {
    result = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.AI_SPEECH_MODEL?.trim() || 'tts-1',
        voice: process.env.AI_SPEECH_VOICE?.trim() || 'alloy',
        input: text,
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new HttpError(502, 'تعذر الاتصال بخدمة تحويل النص إلى صوت.');
  }
  if (!result.ok) {
    console.error(`AI speech provider returned HTTP ${result.status}`);
    throw new HttpError(502, 'تعذر إنشاء الرد الصوتي. تحقق من إعدادات المزود.');
  }
  const audio = Buffer.from(await result.arrayBuffer());
  if (audio.length > 15_000_000) throw new HttpError(502, 'تجاوز الرد الصوتي الحجم المسموح.');
  response.writeHead(200, {
    'content-type': result.headers.get('content-type') || 'audio/mpeg',
    'content-length': audio.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(audio);
}

function validatedAgentTools(value) {
  const allowed = new Set(['web_search', 'draft_document', 'draft_email']);
  if (!Array.isArray(value) || value.length > allowed.size || value.some((tool) => !allowed.has(tool)) ||
      new Set(value).size !== value.length) {
    throw new HttpError(400, 'اختر أدوات الوكيل المتاحة فقط.');
  }
  return value;
}

async function runAgent(user, agent, prompt) {
  const toolResults = [];
  for (const tool of agent.tools) {
    if (tool === 'web_search') {
      toolResults.push(`نتائج البحث:\n${JSON.stringify(await webSearch(prompt), null, 2)}`);
    } else if (tool === 'draft_document') {
      toolResults.push(`مسودة مستند:\n${await requestAi(
        [{ role: 'user', content: `اكتب مسودة مستند بناءً على هذا الطلب: ${prompt}` }],
        'أنشئ مستندًا عربيًا واضحًا. استخدم أقواسًا مربعة للبيانات الناقصة، ولا تختلق حقائق.',
      )}`);
    } else if (tool === 'draft_email') {
      toolResults.push(`مسودة بريد:\n${await requestAi(
        [{ role: 'user', content: `اكتب مسودة بريد إلكتروني مناسبة للطلب التالي، تتضمن سطر الموضوع ثم نص الرسالة: ${prompt}` }],
        'أنت مساعد بريد مهني. أنشئ مسودة فقط ولا ترسل رسائل.',
      )}`);
    }
  }
  const userContext = toolResults.length
    ? `طلب المستخدم:\n${prompt}\n\nنتائج الأدوات المحددة:\n${toolResults.join('\n\n')}`
    : prompt;
  const content = await requestAi(
    [{ role: 'user', content: userContext }],
    `${agent.instructions}\n\nأنت وكيل مخصص أنشأه المستخدم "${user.displayName}". استخدم النتائج المقدمة فقط، واذكر بوضوح عند تعذر إجراء خارجي. لا ترسل بريدًا إلكترونيًا.`,
  );
  return { content, toolResults };
}

async function exportDocument(input, response) {
  const title = requireText(input.title, 'عنوان المستند', 200);
  const contentAr = requireText(input.content, 'محتوى المستند', 50_000);
  if (!['docx', 'html'].includes(input.format)) throw new HttpError(400, 'صيغة التصدير غير مدعومة.');
  const { renderDocxBuffer, renderHtml, safeExportFilename } = await import('../dist/index.js');
  const documentInput = { title, contentAr, issueDate: new Date().toISOString().slice(0, 10) };
  const filename = safeExportFilename(title, input.format);
  if (input.format === 'html') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    });
    response.end(renderHtml(documentInput));
    return;
  }
  const buffer = await renderDocxBuffer(documentInput);
  response.writeHead(200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
  response.end(buffer);
}

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'طريقة الطلب غير مدعومة.');
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'المسار غير صالح.');
  }
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const filePath = path.resolve(publicRoot, relativePath);
  const relativeToRoot = path.relative(publicRoot, filePath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) throw new HttpError(403, 'المسار غير مسموح.');
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch {
    throw new HttpError(404, 'الصفحة المطلوبة غير موجودة.');
  }
  if (!fileInfo.isFile()) throw new HttpError(404, 'الصفحة المطلوبة غير موجودة.');
  const contentTypes = {
    '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  };
  response.writeHead(200, {
    'content-type': contentTypes[path.extname(filePath)] ?? 'application/octet-stream',
    'content-length': fileInfo.size,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-cache',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) assertSameOrigin(request);

  if (url.pathname === '/api/config' && request.method === 'GET') {
    sendJson(response, 200, {
      configured: Boolean(process.env.AI_API_KEY?.trim()),
      model: process.env.AI_MODEL?.trim() || 'gpt-4o-mini',
      integrations: integrationStatus(),
    });
    return;
  }

  if (url.pathname === '/api/auth/session' && request.method === 'GET') {
    sendJson(response, 200, { user: await getUser(request) });
    return;
  }

  if ((url.pathname === '/api/auth/register' || url.pathname === '/api/auth/login') && request.method === 'POST') {
    checkAuthRateLimit(request);
    const input = await readJson(request);
    const email = requireText(input.email, 'البريد الإلكتروني', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'البريد الإلكتروني غير صالح.');
    if (typeof input.password !== 'string' || input.password.length === 0 || input.password.length > 128) {
      throw new HttpError(400, 'يرجى إدخال كلمة المرور بشكل صحيح.');
    }
    const password = input.password;
    let user;
    if (url.pathname === '/api/auth/register') {
      if (password.length < 10) throw new HttpError(400, 'يجب أن تتكون كلمة المرور من 10 أحرف على الأقل.');
      const displayName = requireText(input.displayName, 'الاسم', 80);
      if (await getUserByEmail(email)) throw new HttpError(409, 'يوجد حساب مسجل بهذا البريد الإلكتروني.');
      try {
        user = await createUser({ id: randomUUID(), email, displayName, passwordHash: await hashPassword(password) });
      } catch (error) {
        if (isUniqueConstraintError(error)) throw new HttpError(409, 'يوجد حساب مسجل بهذا البريد الإلكتروني.');
        throw error;
      }
    } else {
      const account = await getUserByEmail(email);
      if (!account || !(await verifyPassword(password, account.passwordHash))) {
        throw new HttpError(401, 'البريد الإلكتروني أو كلمة المرور غير صحيحة.');
      }
      user = { id: account.id, email: account.email, displayName: account.displayName, createdAt: account.createdAt };
    }
    const token = createSessionToken();
    await createSession({ tokenHash: hashToken(token), userId: user.id, expiresAt: sessionExpiry() });
    response.setHeader('set-cookie', sessionCookie(token, secureCookie(request)));
    sendJson(response, 201, { user });
    return;
  }

  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = getRequestToken(request);
    if (token) await deleteSession(hashToken(token));
    response.setHeader('set-cookie', expiredSessionCookie(secureCookie(request)));
    sendJson(response, 200, { loggedOut: true });
    return;
  }

  const billingUser = url.pathname.startsWith('/api/billing') ? await requireUser(request) : null;
  if (url.pathname === '/api/billing' && request.method === 'GET') {
    const config = billingConfig();
    sendJson(response, 200, {
      ...config,
      isAdmin: isBillingAdmin(billingUser),
      subscription: await getActiveSubscription(billingUser.id),
      paymentRequests: await listPaymentRequests(billingUser.id),
    });
    return;
  }
  if (url.pathname === '/api/billing/requests' && request.method === 'POST') {
    const config = billingConfig();
    if (!config.adminConfigured) throw new HttpError(503, 'لم يُضبط بريد مسؤول الاشتراكات بعد.');
    const input = await readJson(request);
    const transferReference = requireText(input.transferReference, 'رقم مرجع التحويل', 120);
    if (/[\r\n]/.test(transferReference)) throw new HttpError(400, 'رقم مرجع التحويل غير صالح.');
    try {
      const paymentRequest = await createPaymentRequest({
        id: randomUUID(),
        userId: billingUser.id,
        amountEgp: config.monthlyPriceEgp,
        transferReference,
      });
      sendJson(response, 201, { paymentRequest });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new HttpError(409, 'لديك طلب دفع قيد المراجعة بالفعل.');
      }
      throw error;
    }
    return;
  }
  if (url.pathname === '/api/billing/admin/requests' && request.method === 'GET') {
    requireBillingAdmin(billingUser, request);
    sendJson(response, 200, { requests: await listPendingPaymentRequests() });
    return;
  }
  const billingReviewMatch = url.pathname.match(/^\/api\/billing\/admin\/requests\/([a-f0-9-]{36})$/i);
  if (billingReviewMatch && request.method === 'POST') {
    requireBillingAdmin(billingUser, request);
    const input = await readJson(request);
    if (!['approve', 'reject'].includes(input.action)) throw new HttpError(400, 'إجراء المراجعة غير صالح.');
    const result = await reviewPaymentRequest({
      id: billingReviewMatch[1],
      adminUserId: billingUser.id,
      approve: input.action === 'approve',
    });
    if (result === 'not_found') throw new HttpError(404, 'طلب الدفع غير موجود.');
    if (result === 'already_reviewed') throw new HttpError(409, 'تمت مراجعة طلب الدفع بالفعل.');
    sendJson(response, 200, { reviewed: true, status: input.action === 'approve' ? 'approved' : 'rejected' });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const user = await requireUser(request);

    if (url.pathname === '/api/conversations' && request.method === 'GET') {
      sendJson(response, 200, { conversations: await listConversations(user.id) });
      return;
    }
    if (url.pathname === '/api/conversations' && request.method === 'POST') {
      const id = randomUUID();
      await saveConversation(user.id, id, []);
      sendJson(response, 201, { conversation: await getConversation(user.id, id) });
      return;
    }
    const conversationMatch = url.pathname.match(/^\/api\/conversations\/([a-f0-9-]{36})$/i);
    if (conversationMatch && request.method === 'GET') {
      const conversation = await getConversation(user.id, conversationMatch[1]);
      if (!conversation) throw new HttpError(404, 'المحادثة غير موجودة.');
      sendJson(response, 200, { conversation });
      return;
    }
    if (conversationMatch && request.method === 'DELETE') {
      if (!(await deleteConversation(user.id, conversationMatch[1]))) throw new HttpError(404, 'المحادثة غير موجودة.');
      sendJson(response, 200, { deleted: true });
      return;
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      const input = await readJson(request);
      const conversationId = requireText(input.conversationId, 'معرّف المحادثة', 64);
      const current = await getConversation(user.id, conversationId);
      if (!current) throw new HttpError(404, 'المحادثة غير موجودة.');
      await requireActiveSubscription(user);
      const message = requireText(input.message, 'نص الرسالة', 16_000);
      const image = input.image ? validateImage(input.image) : null;
      const messages = [
        ...current.messages.map(({ role, content }) => ({ role, content })),
        { role: 'user', content: image ? `${message}\n[صورة مرفقة]` : message },
      ];
      parseMessages(messages);
      const userMessage = {
        id: randomUUID(), role: 'user', content: message,
        attachment: image ? { type: 'image', mimeType: image.mimeType } : null,
        createdAt: new Date().toISOString(),
      };
      const savedMessages = [...current.messages, userMessage];
      await saveConversation(user.id, conversationId, savedMessages);
      const content = await requestAi(messages, 'أنت مساعد ذكي عربي ودود ودقيق. أجب بلغة المستخدم، ونظّم الإجابة بوضوح، ولا تدّعِ تنفيذ إجراءات لم تنفذها.', image);
      savedMessages.push({ id: randomUUID(), role: 'assistant', content, createdAt: new Date().toISOString() });
      await saveConversation(user.id, conversationId, savedMessages);
      sendJson(response, 200, { content, conversation: await getConversation(user.id, conversationId) });
      return;
    }

    if (url.pathname === '/api/documents/generate' && request.method === 'POST') {
      await requireActiveSubscription(user);
      const input = await readJson(request);
      const title = requireText(input.title, 'عنوان المستند', 200);
      const prompt = requireText(input.prompt, 'وصف المستند', 8_000);
      const content = await requestAi(
        [{ role: 'user', content: `أنشئ مسودة مستند عربي احترافي بعنوان "${title}" وفق المتطلبات التالية. أعد نص المستند فقط دون مقدمات أو تنسيق Markdown:\n\n${prompt}` }],
        'أنت محرر مستندات أعمال باللغة العربية. اكتب مستندًا واضحًا ومهنيًا، واستخدم حقولًا فارغة بين أقواس مربعة عند غياب بيانات واقعية. لا تختلق أسماء أو أرقامًا أو حقائق.',
      );
      const document = await saveDocument(user.id, { id: randomUUID(), title, content });
      sendJson(response, 200, { document });
      return;
    }
    if (url.pathname === '/api/documents' && request.method === 'GET') {
      sendJson(response, 200, { documents: await listDocuments(user.id) });
      return;
    }
    if (url.pathname === '/api/documents' && request.method === 'POST') {
      const input = await readJson(request);
      const id = input.id ? requireUuid(input.id, 'معرّف المستند') : randomUUID();
      const document = await saveDocument(user.id, {
        id,
        title: requireText(input.title, 'عنوان المستند', 200),
        content: requireText(input.content, 'محتوى المستند', 50_000),
      });
      sendJson(response, 200, { document });
      return;
    }
    const documentMatch = url.pathname.match(/^\/api\/documents\/([a-f0-9-]{36})$/i);
    if (documentMatch && request.method === 'GET') {
      const document = await getDocument(user.id, documentMatch[1]);
      if (!document) throw new HttpError(404, 'المستند غير موجود.');
      sendJson(response, 200, { document });
      return;
    }
    if (documentMatch && request.method === 'DELETE') {
      if (!(await deleteDocument(user.id, documentMatch[1]))) throw new HttpError(404, 'المستند غير موجود.');
      sendJson(response, 200, { deleted: true });
      return;
    }
    if (url.pathname === '/api/documents/export' && request.method === 'POST') {
      await exportDocument(await readJson(request), response);
      return;
    }

    if (url.pathname === '/api/audio/transcribe' && request.method === 'POST') {
      await requireActiveSubscription(user);
      sendJson(response, 200, { text: await transcribeAudio(await readJson(request)) });
      return;
    }
    if (url.pathname === '/api/audio/speech' && request.method === 'POST') {
      await requireActiveSubscription(user);
      await synthesizeSpeech(await readJson(request), response);
      return;
    }

    if (url.pathname === '/api/search' && request.method === 'POST') {
      await requireActiveSubscription(user);
      const input = await readJson(request);
      const query = requireText(input.query, 'عبارة البحث', 500);
      sendJson(response, 200, await webSearch(query));
      return;
    }

    if (url.pathname === '/api/integrations/status' && request.method === 'GET') {
      sendJson(response, 200, integrationStatus());
      return;
    }
    if (url.pathname === '/api/integrations/email/send' && request.method === 'POST') {
      await requireActiveSubscription(user);
      const input = await readJson(request);
      if (input.confirmed !== true) throw new HttpError(400, 'أكد الإرسال صراحةً قبل إرسال البريد.');
      const to = requireText(input.to, 'عنوان البريد المستلم', 254);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || /[\r\n]/.test(to)) throw new HttpError(400, 'عنوان المستلم غير صالح.');
      const subject = requireText(input.subject, 'موضوع البريد', 200);
      if (/[\r\n]/.test(subject)) throw new HttpError(400, 'موضوع البريد غير صالح.');
      const text = requireText(input.text, 'نص البريد', 20_000);
      const result = await sendEmail({ to, subject, text });
      sendJson(response, 200, { sent: true, messageId: result.messageId });
      return;
    }

    if (url.pathname === '/api/agents' && request.method === 'GET') {
      sendJson(response, 200, { agents: await listAgents(user.id) });
      return;
    }
    if (url.pathname === '/api/agents' && request.method === 'POST') {
      const input = await readJson(request);
      const id = input.id ? requireUuid(input.id, 'معرّف الوكيل') : randomUUID();
      const agent = await saveAgent(user.id, {
        id,
        name: requireText(input.name, 'اسم الوكيل', 80),
        instructions: requireText(input.instructions, 'تعليمات الوكيل', 8_000),
        tools: validatedAgentTools(input.tools ?? []),
      });
      sendJson(response, 200, { agent });
      return;
    }
    const agentMatch = url.pathname.match(/^\/api\/agents\/([a-f0-9-]{36})$/i);
    if (agentMatch && request.method === 'DELETE') {
      if (!(await deleteAgent(user.id, agentMatch[1]))) throw new HttpError(404, 'الوكيل غير موجود.');
      sendJson(response, 200, { deleted: true });
      return;
    }
    const agentRunMatch = url.pathname.match(/^\/api\/agents\/([a-f0-9-]{36})\/run$/i);
    if (agentRunMatch && request.method === 'POST') {
      const agent = await getAgent(user.id, agentRunMatch[1]);
      if (!agent) throw new HttpError(404, 'الوكيل غير موجود.');
      await requireActiveSubscription(user);
      const input = await readJson(request);
      const prompt = requireText(input.prompt, 'طلب الوكيل', 8_000);
      sendJson(response, 200, await runAgent(user, agent, prompt));
      return;
    }
    throw new HttpError(404, 'المسار المطلوب غير موجود.');
  }
  await serveStatic(request, response, url.pathname);
}

export function createAppServer() {
  return createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof HttpError || error instanceof IntegrationError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error('Request failed:', error);
      sendJson(response, 500, { error: 'حدث خطأ غير متوقع أثناء معالجة الطلب.' });
    });
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? '4173', 10);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createAppServer();
  server.listen(port, host, () => {
    console.log(`Masar AI is running at http://${host}:${server.address().port}`);
  });
}
