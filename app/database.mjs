import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const databasePath = path.resolve(process.env.MASAR_DATABASE_PATH ?? 'data/masar.sqlite');
mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    attachment_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL,
    tools_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agents_user_idx ON agents(user_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS documents_user_idx ON documents(user_id, updated_at DESC);
`);

const now = () => new Date().toISOString();

export function createUser({ id, email, displayName, passwordHash }) {
  const createdAt = now();
  db.prepare(
    'INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, email, displayName, passwordHash, createdAt);
  return { id, email, displayName, createdAt };
}

export function getUserByEmail(email) {
  return db.prepare(
    'SELECT id, email, display_name AS displayName, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE email = ? COLLATE NOCASE',
  ).get(email);
}

export function getUserById(id) {
  return db.prepare(
    'SELECT id, email, display_name AS displayName, created_at AS createdAt FROM users WHERE id = ?',
  ).get(id);
}

export function createSession({ tokenHash, userId, expiresAt }) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    tokenHash, userId, expiresAt, now(),
  );
}

export function getSessionUser(tokenHash) {
  const session = db.prepare(
    'SELECT users.id, users.email, users.display_name AS displayName, users.created_at AS createdAt FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?',
  ).get(tokenHash, Date.now());
  return session;
}

export function deleteSession(tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function listConversations(userId) {
  return db.prepare(
    'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50',
  ).all(userId);
}

export function getConversation(userId, conversationId) {
  const conversation = db.prepare(
    'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE id = ? AND user_id = ?',
  ).get(conversationId, userId);
  if (!conversation) return null;
  const messages = db.prepare(
    'SELECT id, role, content, attachment_json AS attachmentJson, created_at AS createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
  ).all(conversationId).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    attachment: message.attachmentJson ? JSON.parse(message.attachmentJson) : null,
    createdAt: message.createdAt,
  }));
  return { ...conversation, messages };
}

export function saveConversation(userId, conversationId, messages) {
  const timestamp = now();
  const title = messages.find((message) => message.role === 'user')?.content.slice(0, 100) || 'محادثة جديدة';
  const transaction = db.transaction(() => {
    db.prepare(
      'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at WHERE conversations.user_id = excluded.user_id',
    ).run(conversationId, userId, title, timestamp, timestamp);
    const owner = db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
    if (!owner) throw new Error('Conversation ownership check failed');
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    const insert = db.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, attachment_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const message of messages) {
      insert.run(message.id, conversationId, message.role, message.content, message.attachment ? JSON.stringify(message.attachment) : null, message.createdAt ?? timestamp);
    }
  });
  transaction();
}

export function deleteConversation(userId, conversationId) {
  return db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(conversationId, userId).changes > 0;
}

export function listAgents(userId) {
  return db.prepare(
    'SELECT id, name, instructions, tools_json AS toolsJson, created_at AS createdAt, updated_at AS updatedAt FROM agents WHERE user_id = ? ORDER BY updated_at DESC',
  ).all(userId).map((agent) => ({ ...agent, tools: JSON.parse(agent.toolsJson), toolsJson: undefined }));
}

export function getAgent(userId, agentId) {
  const agent = db.prepare(
    'SELECT id, name, instructions, tools_json AS toolsJson, created_at AS createdAt, updated_at AS updatedAt FROM agents WHERE id = ? AND user_id = ?',
  ).get(agentId, userId);
  if (!agent) return null;
  return { ...agent, tools: JSON.parse(agent.toolsJson), toolsJson: undefined };
}

export function saveAgent(userId, { id, name, instructions, tools }) {
  const timestamp = now();
  db.prepare(
    'INSERT INTO agents (id, user_id, name, instructions, tools_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, instructions = excluded.instructions, tools_json = excluded.tools_json, updated_at = excluded.updated_at WHERE agents.user_id = excluded.user_id',
  ).run(id, userId, name, instructions, JSON.stringify(tools), timestamp, timestamp);
  const agent = getAgent(userId, id);
  if (!agent) throw new Error('Agent ownership check failed');
  return agent;
}

export function deleteAgent(userId, agentId) {
  return db.prepare('DELETE FROM agents WHERE id = ? AND user_id = ?').run(agentId, userId).changes > 0;
}

export function listDocuments(userId) {
  return db.prepare(
    'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM documents WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50',
  ).all(userId);
}

export function getDocument(userId, documentId) {
  return db.prepare(
    'SELECT id, title, content, created_at AS createdAt, updated_at AS updatedAt FROM documents WHERE id = ? AND user_id = ?',
  ).get(documentId, userId);
}

export function saveDocument(userId, { id, title, content }) {
  const timestamp = now();
  db.prepare(
    'INSERT INTO documents (id, user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, updated_at = excluded.updated_at WHERE documents.user_id = excluded.user_id',
  ).run(id, userId, title, content, timestamp, timestamp);
  const document = getDocument(userId, id);
  if (!document) throw new Error('Document ownership check failed');
  return document;
}

export function deleteDocument(userId, documentId) {
  return db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(documentId, userId).changes > 0;
}
