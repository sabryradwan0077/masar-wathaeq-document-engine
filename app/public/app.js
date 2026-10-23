const conversationList = document.querySelector('#conversation-list');
const messagesElement = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
const chatScroll = document.querySelector('#chat-scroll');
const chatInput = document.querySelector('#chat-input');
const chatForm = document.querySelector('#chat-form');
const sendButton = document.querySelector('#send-button');
const toast = document.querySelector('#toast');
const views = Object.fromEntries(['chat', 'documents', 'agents', 'integrations'].map((name) => [
  name, document.querySelector(`#${name}-view`),
]));

let conversations = [];
let activeConversationId = null;
let activeDocumentId = null;
let currentView = 'chat';
let pendingImage = null;
let recording = false;
let mediaRecorder = null;
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3600);
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'تعذر تنفيذ الطلب.');
  }
  return response.json();
}

async function postJson(url, body) {
  return apiJson(url, { method: 'POST', body: JSON.stringify(body) });
}

function activeConversation() {
  return conversations.find((conversation) => conversation.id === activeConversationId);
}

function selectView(name) {
  currentView = name;
  for (const [viewName, element] of Object.entries(views)) {
    element.classList.toggle('hidden', viewName !== name);
  }
  document.querySelectorAll('.nav-link').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === name);
  });
  const titles = {
    chat: ['مساحة عملك', 'المساعد الذكي'],
    documents: ['مساعدك في كتابة المستندات', 'المستندات'],
    agents: ['وكلاء بمهمات محددة', 'الوكلاء'],
    integrations: ['اتصل بأدوات عملك', 'التكاملات'],
  };
  document.querySelector('#topbar-eyebrow').textContent = titles[name][0];
  document.querySelector('#topbar-title').textContent = titles[name][1];
  if (name === 'agents') void loadAgents();
  if (name === 'integrations') void loadIntegrationStatus();
  if (name === 'documents') void loadDocuments();
}

function renderConversations() {
  conversationList.replaceChildren();
  for (const conversation of conversations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `conversation-item${conversation.id === activeConversationId ? ' selected' : ''}`;
    button.textContent = conversation.title;
    button.title = conversation.title;
    button.addEventListener('click', () => void openConversation(conversation.id));
    conversationList.append(button);
  }
}

function appendMessage(role, content, options = {}) {
  const row = document.createElement('div');
  row.className = `message ${role}${options.pending ? ' pending' : ''}`;
  const avatar = document.createElement('span');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'user' ? 'أ' : '✦';
  avatar.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div');
  body.className = 'message-body';
  const text = document.createElement('div');
  text.textContent = content;
  body.append(text);
  if (options.attachment?.type === 'image') {
    const caption = document.createElement('span');
    caption.className = 'message-attachment';
    caption.textContent = '▧ صورة مرفقة';
    body.append(caption);
  } else if (options.attachment?.type === 'audio') {
    const caption = document.createElement('span');
    caption.className = 'message-attachment';
    caption.textContent = '◉ رسالة صوتية';
    body.append(caption);
  }
  if (role === 'assistant' && !options.pending) {
    const speak = document.createElement('button');
    speak.type = 'button';
    speak.className = 'speak-button';
    speak.textContent = '◖ استمع';
    speak.addEventListener('click', () => void playSpeech(content, speak));
    body.append(speak);
  }
  row.append(avatar, body);
  messagesElement.append(row);
}

function renderMessages() {
  const conversation = activeConversation();
  messagesElement.replaceChildren();
  welcome.classList.toggle('hidden', Boolean(conversation?.messages.length));
  if (conversation) {
    for (const message of conversation.messages) {
      appendMessage(message.role, message.content, { attachment: message.attachment });
    }
  }
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

async function refreshConversations(preferredId) {
  const result = await apiJson('/api/conversations');
  conversations = result.conversations;
  if (preferredId && conversations.some((conversation) => conversation.id === preferredId)) {
    activeConversationId = preferredId;
  } else if (!conversations.some((conversation) => conversation.id === activeConversationId)) {
    activeConversationId = conversations[0]?.id ?? null;
  }
  renderConversations();
  if (activeConversationId) await openConversation(activeConversationId);
  else renderMessages();
}

async function openConversation(id) {
  const { conversation } = await apiJson(`/api/conversations/${encodeURIComponent(id)}`);
  const index = conversations.findIndex((item) => item.id === id);
  if (index >= 0) conversations[index] = { ...conversations[index], ...conversation };
  activeConversationId = id;
  renderConversations();
  renderMessages();
  selectView('chat');
}

async function createConversation() {
  try {
    const { conversation } = await postJson('/api/conversations', {});
    conversations.unshift(conversation);
    activeConversationId = conversation.id;
    renderConversations();
    renderMessages();
    selectView('chat');
    chatInput.focus();
  } catch (error) {
    showToast(error.message);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result).split(',')[1] ?? ''));
    reader.addEventListener('error', () => reject(new Error('تعذرت قراءة الملف.')));
    reader.readAsDataURL(file);
  });
}

async function sendMessage(text) {
  if (!activeConversationId) await createConversation();
  const conversation = activeConversation();
  if (!conversation) return;
  const message = text.trim() || (pendingImage ? 'حلل هذه الصورة من فضلك.' : '');
  if (!message) return;
  const image = pendingImage;
  const currentUserMessage = {
    role: 'user',
    content: message,
    attachment: image ? { type: 'image', mimeType: image.type } : null,
  };
  conversation.messages.push(currentUserMessage);
  renderMessages();
  sendButton.disabled = true;
  chatInput.disabled = true;
  appendMessage('assistant', 'أفكر في طلبك...', { pending: true });
  chatScroll.scrollTop = chatScroll.scrollHeight;

  try {
    const payload = {
      conversationId: conversation.id,
      message,
      image: image ? { mimeType: image.type, dataBase64: await fileToBase64(image) } : undefined,
    };
    const result = await postJson('/api/chat', payload);
    const index = conversations.findIndex((item) => item.id === result.conversation.id);
    if (index >= 0) conversations[index] = result.conversation;
    pendingImage = null;
    document.querySelector('#image-input').value = '';
    updateAttachmentPreview();
    renderConversations();
  } catch (error) {
    try {
      const { conversation: saved } = await apiJson(`/api/conversations/${encodeURIComponent(conversation.id)}`);
      const index = conversations.findIndex((item) => item.id === saved.id);
      if (index >= 0) conversations[index] = saved;
    } catch {
      const index = conversations.findIndex((item) => item.id === conversation.id);
      if (index >= 0) conversations[index].messages.pop();
    }
    showToast(error.message);
  } finally {
    sendButton.disabled = false;
    chatInput.disabled = false;
    renderConversations();
    renderMessages();
    chatInput.focus();
  }
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (sendButton.disabled) return;
  const content = chatInput.value;
  if (!content.trim() && !pendingImage) return;
  chatInput.value = '';
  chatInput.style.height = 'auto';
  void sendMessage(content);
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 180)}px`;
});

chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

function updateAttachmentPreview() {
  const preview = document.querySelector('#attachment-preview');
  if (!pendingImage) {
    preview.classList.add('hidden');
    preview.textContent = '';
    return;
  }
  preview.classList.remove('hidden');
  preview.textContent = `▧ ${pendingImage.name}`;
}

document.querySelector('#attach-image').addEventListener('click', () => document.querySelector('#image-input').click());
document.querySelector('#image-input').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 6 * 1024 * 1024) {
    event.target.value = '';
    showToast('الحد الأقصى لحجم الصورة 6 ميغابايت.');
    return;
  }
  pendingImage = file;
  updateAttachmentPreview();
});

document.querySelector('#record-audio').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (recording) {
    mediaRecorder.stop();
    recording = false;
    button.classList.remove('recording');
    button.title = 'تسجيل رسالة صوتية';
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showToast('تسجيل الصوت غير مدعوم في هذا المتصفح.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks = [];
    mediaRecorder.addEventListener('dataavailable', (recordingEvent) => {
      if (recordingEvent.data.size) chunks.push(recordingEvent.data);
    });
    mediaRecorder.addEventListener('stop', async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
      if (blob.size > 15 * 1024 * 1024) {
        showToast('التسجيل أطول من الحجم المسموح.');
        return;
      }
      try {
        const mime = blob.type.split(';')[0];
        const { text } = await postJson('/api/audio/transcribe', {
          mimeType: mime,
          dataBase64: await fileToBase64(new File([blob], 'recording', { type: mime })),
        });
        chatInput.value = `${chatInput.value}${chatInput.value ? ' ' : ''}${text}`.trim();
        chatInput.dispatchEvent(new Event('input'));
        chatInput.focus();
      } catch (error) {
        showToast(error.message);
      }
    }, { once: true });
    recording = true;
    button.classList.add('recording');
    button.title = 'إيقاف التسجيل';
    mediaRecorder.start();
    setTimeout(() => {
      if (recording) {
        mediaRecorder.stop();
        recording = false;
        button.classList.remove('recording');
      }
    }, 60_000);
  } catch {
    showToast('اسمح باستخدام الميكروفون لتسجيل رسالة صوتية.');
  }
});

async function playSpeech(text, button) {
  button.disabled = true;
  try {
    const response = await fetch('/api/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'تعذر إنشاء الصوت.');
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    const audio = new Audio(objectUrl);
    audio.addEventListener('ended', () => URL.revokeObjectURL(objectUrl), { once: true });
    await audio.play();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

document.querySelector('#search-web').addEventListener('click', () => {
  selectView('integrations');
  document.querySelector('#search-query').focus();
});
document.querySelector('#new-chat').addEventListener('click', () => void createConversation());
document.querySelectorAll('.nav-link').forEach((button) => {
  button.addEventListener('click', () => selectView(button.dataset.view));
});
document.querySelectorAll('.suggestion-card').forEach((button) => {
  button.addEventListener('click', () => {
    chatInput.value = button.dataset.prompt;
    chatInput.focus();
    chatInput.dispatchEvent(new Event('input'));
  });
});

document.querySelector('#document-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = document.querySelector('#document-title').value.trim();
  const prompt = document.querySelector('#document-prompt').value.trim();
  const button = document.querySelector('#generate-document');
  if (!title || !prompt) return;
  button.disabled = true;
  button.textContent = 'جارٍ إنشاء المسودة...';
  try {
    const result = await postJson('/api/documents/generate', { title, prompt });
    activeDocumentId = result.document.id;
    document.querySelector('#preview-title').textContent = title;
    document.querySelector('#document-content').value = result.document.content;
    document.querySelector('#document-content').classList.remove('hidden');
    document.querySelector('.paper-empty').classList.add('hidden');
    document.querySelector('#export-actions').classList.remove('hidden');
    void loadDocuments();
    showToast('تم إنشاء المسودة. راجعها وعدّلها قبل التنزيل.');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = '<span aria-hidden="true">✦</span> إنشاء مسودة';
  }
});

async function loadDocuments() {
  try {
    const { documents } = await apiJson('/api/documents');
    const container = document.querySelector('#saved-documents');
    container.replaceChildren();
    for (const documentInfo of documents) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'saved-document';
      button.textContent = documentInfo.title;
      button.title = documentInfo.title;
      button.addEventListener('click', () => void openDocument(documentInfo.id));
      container.append(button);
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function openDocument(id) {
  try {
    const { document: saved } = await apiJson(`/api/documents/${encodeURIComponent(id)}`);
    activeDocumentId = saved.id;
    document.querySelector('#preview-title').textContent = saved.title;
    document.querySelector('#document-content').value = saved.content;
    document.querySelector('#document-content').classList.remove('hidden');
    document.querySelector('.paper-empty').classList.add('hidden');
    document.querySelector('#export-actions').classList.remove('hidden');
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector('#save-document').addEventListener('click', async () => {
  const button = document.querySelector('#save-document');
  button.disabled = true;
  try {
    const { document: saved } = await postJson('/api/documents', {
      id: activeDocumentId,
      title: document.querySelector('#preview-title').textContent,
      content: document.querySelector('#document-content').value,
    });
    activeDocumentId = saved.id;
    await loadDocuments();
    showToast('تم حفظ المستند.');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll('[data-export]').forEach((button) => {
  button.addEventListener('click', async () => {
    const title = document.querySelector('#preview-title').textContent;
    const content = document.querySelector('#document-content').value.trim();
    const format = button.dataset.export;
    button.disabled = true;
    try {
      const response = await fetch('/api/documents/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, content, format }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'تعذر تصدير المستند.');
      }
      const href = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = href;
      link.download = `${title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'document'}.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });
});

document.querySelector('#auth-toggle').addEventListener('click', () => {
  const registering = document.querySelector('#auth-name').classList.contains('hidden');
  document.querySelectorAll('.auth-name').forEach((element) => element.classList.toggle('hidden', !registering));
  document.querySelector('#auth-title').textContent = registering ? 'إنشاء حساب جديد' : 'مرحبًا بعودتك';
  document.querySelector('#auth-description').textContent = registering ? 'أنشئ حسابًا خاصًا بك للبدء.' : 'سجّل الدخول للمتابعة إلى مساحة عملك.';
  document.querySelector('#auth-submit').textContent = registering ? 'إنشاء حساب' : 'تسجيل الدخول';
  document.querySelector('#auth-toggle').textContent = registering ? 'لديك حساب؟ سجّل الدخول' : 'إنشاء حساب جديد';
  document.querySelector('#auth-password').autocomplete = registering ? 'new-password' : 'current-password';
  document.querySelector('#auth-password').minLength = registering ? 10 : 1;
});

function showWorkspace(user) {
  document.querySelector('#auth-screen').classList.add('hidden');
  document.querySelector('#app-shell').classList.remove('hidden');
  document.querySelector('#profile-name').textContent = user.displayName;
  document.querySelector('#profile-email').textContent = user.email;
  void refreshConversations().catch((error) => showToast(error.message));
  void loadConfig();
}

document.querySelector('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const registering = !document.querySelector('#auth-name').classList.contains('hidden');
  const button = document.querySelector('#auth-submit');
  button.disabled = true;
  try {
    const { user } = await postJson(registering ? '/api/auth/register' : '/api/auth/login', {
      email: document.querySelector('#auth-email').value,
      password: document.querySelector('#auth-password').value,
      displayName: document.querySelector('#auth-name').value,
    });
    showWorkspace(user);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await postJson('/api/auth/logout', {});
    conversations = [];
    activeConversationId = null;
    document.querySelector('#app-shell').classList.add('hidden');
    document.querySelector('#auth-screen').classList.remove('hidden');
  } catch (error) {
    showToast(error.message);
  }
});

async function loadConfig() {
  const indicator = document.querySelector('#connection-indicator');
  const label = document.querySelector('#connection-label');
  try {
    const config = await apiJson('/api/config');
    document.querySelector('#model-name').textContent = config.model;
    indicator.classList.toggle('connected', config.configured);
    label.textContent = config.configured ? 'الذكاء الاصطناعي جاهز' : 'أضف مفتاح AI في .env';
    document.querySelector('#integration-status').textContent =
      `بحث Tavily: ${config.integrations.tavily ? 'جاهز' : 'غير مضبوط'} · SMTP: ${config.integrations.email ? 'جاهز' : 'غير مضبوط'}`;
  } catch {
    label.textContent = 'تعذر الاتصال بالخادم';
  }
}

async function loadIntegrationStatus() {
  try {
    const integrations = await apiJson('/api/integrations/status');
    document.querySelector('#integration-status').textContent =
      `بحث Tavily: ${integrations.tavily ? 'جاهز' : 'غير مضبوط'} · SMTP: ${integrations.email ? 'جاهز' : 'غير مضبوط'}`;
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector('#search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#search-submit');
  button.disabled = true;
  try {
    const result = await postJson('/api/search', { query: document.querySelector('#search-query').value.trim() });
    const container = document.querySelector('#search-results');
    container.replaceChildren();
    if (result.answer) {
      const answer = document.createElement('p');
      answer.className = 'search-answer';
      answer.textContent = result.answer;
      container.append(answer);
    }
    for (const item of result.results) {
      const card = document.createElement('article');
      card.className = 'search-result';
      const link = document.createElement('a');
      link.textContent = item.title || item.url;
      try {
        const url = new URL(item.url);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } catch {
        continue;
      }
      const summary = document.createElement('p');
      summary.textContent = item.content;
      card.append(link, summary);
      container.append(card);
    }
    container.classList.remove('hidden');
    if (!result.results.length) showToast('لم يعثر البحث على نتائج.');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

let agents = [];
async function loadAgents() {
  try {
    const result = await apiJson('/api/agents');
    agents = result.agents;
    renderAgents();
  } catch (error) {
    showToast(error.message);
  }
}

function renderAgents() {
  const list = document.querySelector('#agent-list');
  const select = document.querySelector('#agent-select');
  list.replaceChildren();
  select.replaceChildren(new Option('اختر وكيلًا', ''));
  for (const agent of agents) {
    const option = new Option(agent.name, agent.id);
    select.append(option);
    const item = document.createElement('div');
    item.className = 'agent-item';
    const name = document.createElement('strong');
    name.textContent = agent.name;
    const tools = document.createElement('small');
    tools.textContent = agent.tools.length ? agent.tools.join(' · ') : 'بدون أدوات إضافية';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary-button';
    remove.textContent = 'حذف';
    remove.addEventListener('click', () => void removeAgent(agent.id));
    item.append(name, tools, remove);
    list.append(item);
  }
}

document.querySelector('#agent-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#save-agent');
  button.disabled = true;
  try {
    const tools = [...document.querySelectorAll('input[name="agent-tool"]:checked')].map((input) => input.value);
    const { agent } = await postJson('/api/agents', {
      name: document.querySelector('#agent-name').value.trim(),
      instructions: document.querySelector('#agent-instructions').value.trim(),
      tools,
    });
    agents.unshift(agent);
    renderAgents();
    event.currentTarget.reset();
    showToast('تم حفظ الوكيل.');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

async function removeAgent(id) {
  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'تعذر حذف الوكيل.');
    agents = agents.filter((agent) => agent.id !== id);
    renderAgents();
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector('#agent-run-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const agentId = document.querySelector('#agent-select').value;
  const button = document.querySelector('#run-agent');
  const output = document.querySelector('#agent-output');
  if (!agentId) return;
  button.disabled = true;
  output.classList.remove('hidden');
  output.textContent = 'جارٍ تنفيذ المهمة...';
  try {
    const result = await postJson(`/api/agents/${encodeURIComponent(agentId)}/run`, {
      prompt: document.querySelector('#agent-prompt').value.trim(),
    });
    output.replaceChildren();
    const content = document.createElement('p');
    content.textContent = result.content;
    output.append(content);
    for (const toolResult of result.toolResults) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'نتيجة أداة الوكيل';
      const pre = document.createElement('pre');
      pre.textContent = toolResult;
      details.append(summary, pre);
      output.append(details);
    }
  } catch (error) {
    output.textContent = '';
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#email-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!window.confirm('هل راجعت عنوان المستلم والموضوع ومحتوى الرسالة؟ سيتم إرسال البريد فورًا.')) return;
  const button = document.querySelector('#email-send');
  button.disabled = true;
  try {
    await postJson('/api/integrations/email/send', {
      to: document.querySelector('#email-to').value.trim(),
      subject: document.querySelector('#email-subject').value.trim(),
      text: document.querySelector('#email-text').value.trim(),
      confirmed: true,
    });
    showToast('تم إرسال البريد الإلكتروني.');
    event.currentTarget.reset();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll('.suggestion-card').forEach((button) => {
  button.addEventListener('click', () => {
    chatInput.value = button.dataset.prompt;
    chatInput.focus();
    chatInput.dispatchEvent(new Event('input'));
  });
});

async function start() {
  try {
    const { user } = await apiJson('/api/auth/session');
    if (user) showWorkspace(user);
  } catch {
    showToast('تعذر الاتصال بالخادم.');
  }
}

void start();
