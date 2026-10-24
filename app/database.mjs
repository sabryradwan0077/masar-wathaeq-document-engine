import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const transactionContext = new AsyncLocalStorage();
const databaseUrl = process.env.DATABASE_URL?.trim();
if (process.env.NODE_ENV === 'production' && !databaseUrl) {
  throw new Error('DATABASE_URL is required in production to keep account and subscription data persistent.');
}
const postgres = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const sqlitePath = path.resolve(process.env.MASAR_DATABASE_PATH ?? 'data/masar.sqlite');
let sqlite = null;
let sqliteQueue = Promise.resolve();

if (!postgres) {
  mkdirSync(path.dirname(sqlitePath), { recursive: true });
  sqlite = new Database(sqlitePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
}

function serializeSqlite(operation) {
  const previous = sqliteQueue;
  let release;
  sqliteQueue = new Promise((resolve) => { release = resolve; });
  return previous.then(operation).finally(release);
}

function postgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function get(sql, params = []) {
  if (postgres) {
    const client = transactionContext.getStore() ?? postgres;
    const result = await client.query(postgresSql(sql), params);
    return result.rows[0];
  }
  const execute = () => sqlite.prepare(sql).get(...params);
  return transactionContext.getStore() ? execute() : serializeSqlite(execute);
}

async function all(sql, params = []) {
  if (postgres) {
    const client = transactionContext.getStore() ?? postgres;
    const result = await client.query(postgresSql(sql), params);
    return result.rows;
  }
  const execute = () => sqlite.prepare(sql).all(...params);
  return transactionContext.getStore() ? execute() : serializeSqlite(execute);
}

async function run(sql, params = []) {
  if (postgres) {
    const client = transactionContext.getStore() ?? postgres;
    const result = await client.query(postgresSql(sql), params);
    return { changes: result.rowCount };
  }
  const execute = () => sqlite.prepare(sql).run(...params);
  return transactionContext.getStore() ? execute() : serializeSqlite(execute);
}

async function transaction(operation) {
  if (postgres) {
    const client = await postgres.connect();
    try {
      await client.query('BEGIN');
      const result = await transactionContext.run(client, operation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return serializeSqlite(async () => {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = await transactionContext.run({ sqlite: true }, operation);
      sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  });
}

const sqliteSchema = `
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
    ordinal INTEGER NOT NULL DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS payment_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_egp INTEGER NOT NULL CHECK(amount_egp > 0),
    transfer_reference TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
    reviewed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS payment_requests_user_idx ON payment_requests(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS payment_requests_status_idx ON payment_requests(status, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS payment_requests_one_pending_per_user
    ON payment_requests(user_id) WHERE status = 'pending';
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payment_request_id TEXT NOT NULL UNIQUE REFERENCES payment_requests(id),
    starts_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS subscriptions_user_expiry_idx ON subscriptions(user_id, expires_at DESC);
`;

const postgresSchema = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email));
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
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
    ordinal INTEGER NOT NULL DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS payment_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_egp INTEGER NOT NULL CHECK(amount_egp > 0),
    transfer_reference TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
    reviewed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS payment_requests_user_idx ON payment_requests(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS payment_requests_status_idx ON payment_requests(status, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS payment_requests_one_pending_per_user
    ON payment_requests(user_id) WHERE status = 'pending';
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payment_request_id TEXT NOT NULL UNIQUE REFERENCES payment_requests(id),
    starts_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS subscriptions_user_expiry_idx ON subscriptions(user_id, expires_at DESC);
`;

if (postgres) {
  await postgres.query(postgresSchema);
} else {
  sqlite.exec(sqliteSchema);
  const messageColumns = sqlite.prepare('PRAGMA table_info(messages)').all();
  if (!messageColumns.some((column) => column.name === 'ordinal')) {
    sqlite.exec('ALTER TABLE messages ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0');
  }
}

const now = () => new Date().toISOString();

export function isUniqueConstraintError(error) {
  return error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || error?.code === '23505';
}

export async function createUser({ id, email, displayName, passwordHash }) {
  const createdAt = now();
  await run(
    'INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, email, displayName, passwordHash, createdAt],
  );
  return { id, email, displayName, createdAt };
}

export async function getUserByEmail(email) {
  return get(
    'SELECT id, email, display_name AS displayName, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE LOWER(email) = LOWER(?)',
    [email],
  );
}

export async function getUserById(id) {
  return get(
    'SELECT id, email, display_name AS displayName, created_at AS createdAt FROM users WHERE id = ?',
    [id],
  );
}

export async function createSession({ tokenHash, userId, expiresAt }) {
  await run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
  await run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', [
    tokenHash, userId, expiresAt, now(),
  ]);
}

export async function getSessionUser(tokenHash) {
  return get(
    'SELECT users.id, users.email, users.display_name AS displayName, users.created_at AS createdAt FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?',
    [tokenHash, Date.now()],
  );
}

export async function deleteSession(tokenHash) {
  await run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
}

export async function listConversations(userId) {
  return all(
    'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50',
    [userId],
  );
}

export async function getConversation(userId, conversationId) {
  const conversation = await get(
    'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE id = ? AND user_id = ?',
    [conversationId, userId],
  );
  if (!conversation) return null;
  const messages = await all(
    'SELECT id, role, content, attachment_json AS attachmentJson, created_at AS createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at, ordinal',
    [conversationId],
  );
  return {
    ...conversation,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      attachment: message.attachmentJson ? JSON.parse(message.attachmentJson) : null,
      createdAt: message.createdAt,
    })),
  };
}

export async function saveConversation(userId, conversationId, messages) {
  const timestamp = now();
  const title = messages.find((message) => message.role === 'user')?.content.slice(0, 100) || 'محادثة جديدة';
  await transaction(async () => {
    await run(
      'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at WHERE conversations.user_id = excluded.user_id',
      [conversationId, userId, title, timestamp, timestamp],
    );
    const owner = await get('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?', [conversationId, userId]);
    if (!owner) throw new Error('Conversation ownership check failed');
    await run('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
    for (const [ordinal, message] of messages.entries()) {
      await run(
        'INSERT INTO messages (id, conversation_id, role, content, attachment_json, ordinal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          message.id, conversationId, message.role, message.content,
          message.attachment ? JSON.stringify(message.attachment) : null,
          ordinal, message.createdAt ?? timestamp,
        ],
      );
    }
  });
}

export async function deleteConversation(userId, conversationId) {
  return (await run('DELETE FROM conversations WHERE id = ? AND user_id = ?', [conversationId, userId])).changes > 0;
}

export async function listAgents(userId) {
  const agents = await all(
    'SELECT id, name, instructions, tools_json AS toolsJson, created_at AS createdAt, updated_at AS updatedAt FROM agents WHERE user_id = ? ORDER BY updated_at DESC',
    [userId],
  );
  return agents.map((agent) => ({ ...agent, tools: JSON.parse(agent.toolsJson), toolsJson: undefined }));
}

export async function getAgent(userId, agentId) {
  const agent = await get(
    'SELECT id, name, instructions, tools_json AS toolsJson, created_at AS createdAt, updated_at AS updatedAt FROM agents WHERE id = ? AND user_id = ?',
    [agentId, userId],
  );
  if (!agent) return null;
  return { ...agent, tools: JSON.parse(agent.toolsJson), toolsJson: undefined };
}

export async function saveAgent(userId, { id, name, instructions, tools }) {
  const timestamp = now();
  await run(
    'INSERT INTO agents (id, user_id, name, instructions, tools_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, instructions = excluded.instructions, tools_json = excluded.tools_json, updated_at = excluded.updated_at WHERE agents.user_id = excluded.user_id',
    [id, userId, name, instructions, JSON.stringify(tools), timestamp, timestamp],
  );
  const agent = await getAgent(userId, id);
  if (!agent) throw new Error('Agent ownership check failed');
  return agent;
}

export async function deleteAgent(userId, agentId) {
  return (await run('DELETE FROM agents WHERE id = ? AND user_id = ?', [agentId, userId])).changes > 0;
}

export async function listDocuments(userId) {
  return all(
    'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM documents WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50',
    [userId],
  );
}

export async function getDocument(userId, documentId) {
  return get(
    'SELECT id, title, content, created_at AS createdAt, updated_at AS updatedAt FROM documents WHERE id = ? AND user_id = ?',
    [documentId, userId],
  );
}

export async function saveDocument(userId, { id, title, content }) {
  const timestamp = now();
  await run(
    'INSERT INTO documents (id, user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, updated_at = excluded.updated_at WHERE documents.user_id = excluded.user_id',
    [id, userId, title, content, timestamp, timestamp],
  );
  const document = await getDocument(userId, id);
  if (!document) throw new Error('Document ownership check failed');
  return document;
}

export async function deleteDocument(userId, documentId) {
  return (await run('DELETE FROM documents WHERE id = ? AND user_id = ?', [documentId, userId])).changes > 0;
}

export async function getActiveSubscription(userId) {
  return (await get(
    'SELECT id, starts_at AS startsAt, expires_at AS expiresAt FROM subscriptions WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1',
    [userId, now()],
  )) ?? null;
}

export async function listPaymentRequests(userId) {
  return all(
    'SELECT id, amount_egp AS amountEgp, transfer_reference AS transferReference, status, created_at AS createdAt, reviewed_at AS reviewedAt FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
    [userId],
  );
}

export async function createPaymentRequest({ id, userId, amountEgp, transferReference }) {
  const createdAt = now();
  await run(
    'INSERT INTO payment_requests (id, user_id, amount_egp, transfer_reference, status, created_at) VALUES (?, ?, ?, ?, \'pending\', ?)',
    [id, userId, amountEgp, transferReference, createdAt],
  );
  return get(
    'SELECT id, amount_egp AS amountEgp, transfer_reference AS transferReference, status, created_at AS createdAt FROM payment_requests WHERE id = ?',
    [id],
  );
}

export async function listPendingPaymentRequests() {
  return all(
    'SELECT payment_requests.id, payment_requests.amount_egp AS amountEgp, payment_requests.transfer_reference AS transferReference, payment_requests.created_at AS createdAt, users.email, users.display_name AS displayName FROM payment_requests JOIN users ON users.id = payment_requests.user_id WHERE payment_requests.status = \'pending\' ORDER BY payment_requests.created_at',
  );
}

export async function reviewPaymentRequest({ id, adminUserId, approve }) {
  const timestamp = now();
  return transaction(async () => {
    const payment = await get('SELECT id, user_id AS userId, status FROM payment_requests WHERE id = ?', [id]);
    if (!payment) return 'not_found';
    if (payment.status !== 'pending') return 'already_reviewed';

    const updated = await run(
      'UPDATE payment_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = \'pending\'',
      [approve ? 'approved' : 'rejected', adminUserId, timestamp, id],
    );
    if (updated.changes !== 1) return 'already_reviewed';

    if (approve) {
      const active = await get(
        'SELECT expires_at AS expiresAt FROM subscriptions WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1',
        [payment.userId, timestamp],
      );
      const startsAt = active ? active.expiresAt : timestamp;
      const startDate = new Date(startsAt);
      const desiredMonth = startDate.getUTCMonth() + 1;
      const year = startDate.getUTCFullYear() + Math.floor(desiredMonth / 12);
      const month = desiredMonth % 12;
      const day = startDate.getUTCDate();
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      startDate.setUTCDate(1);
      startDate.setUTCFullYear(year, month, Math.min(day, lastDay));
      await run(
        'INSERT INTO subscriptions (id, user_id, payment_request_id, starts_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [randomUUID(), payment.userId, id, startsAt, startDate.toISOString(), timestamp],
      );
    }
    return 'reviewed';
  });
}

export async function closeDatabase() {
  if (postgres) await postgres.end();
  else await serializeSqlite(() => sqlite.close());
}
