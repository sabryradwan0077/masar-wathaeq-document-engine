import { createTransport } from 'nodemailer';

class IntegrationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export { IntegrationError };

export function integrationStatus() {
  return {
    tavily: Boolean(process.env.TAVILY_API_KEY?.trim()),
    email: Boolean(process.env.SMTP_URL?.trim() && process.env.SMTP_FROM?.trim()),
  };
}

export async function webSearch(query) {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) throw new IntegrationError(503, 'أضف TAVILY_API_KEY إلى ملف .env لتفعيل بحث الويب.');
  let response;
  try {
    response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: 'basic', include_answer: true }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new IntegrationError(502, 'تعذر الاتصال بخدمة البحث.');
  }
  if (!response.ok) {
    console.error(`Tavily returned HTTP ${response.status}`);
    throw new IntegrationError(502, 'فشل البحث على الويب. تحقق من إعدادات Tavily.');
  }
  const result = await response.json();
  return {
    answer: typeof result.answer === 'string' ? result.answer : '',
    results: Array.isArray(result.results) ? result.results.slice(0, 5).map((item) => ({
      title: String(item.title ?? '').slice(0, 300),
      url: String(item.url ?? '').slice(0, 2000),
      content: String(item.content ?? '').slice(0, 3000),
    })) : [],
  };
}

export async function sendEmail({ to, subject, text }) {
  const smtpUrl = process.env.SMTP_URL?.trim();
  const from = process.env.SMTP_FROM?.trim();
  if (!smtpUrl || !from) throw new IntegrationError(503, 'أضف SMTP_URL وSMTP_FROM إلى ملف .env لتفعيل البريد.');
  const transport = createTransport(smtpUrl);
  try {
    return await transport.sendMail({ from, to, subject, text });
  } catch (error) {
    console.error('SMTP delivery failed:', error?.code ?? 'unknown error');
    throw new IntegrationError(502, 'تعذر إرسال البريد. تحقق من إعدادات SMTP.');
  } finally {
    transport.close();
  }
}
