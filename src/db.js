// src/db.js — SQLite data layer with a portable driver adapter.
//
// Driver selection (automatic):
//   1. better-sqlite3   — preferred in production (fast, synchronous, widely used)
//   2. node:sqlite      — Node 22+ built-in fallback (no native build needed)
// Both expose the same tiny interface used below, so the rest of the app
// is identical regardless of which driver is active.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'portfolio.db');

let db;       // normalized handle with .exec() and .prepare()
let driver;

async function initDriver() {
  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default;
    const real = new Database(dbFile);
    real.pragma('journal_mode = WAL');
    driver = 'better-sqlite3';
    db = {
      exec: (sql) => real.exec(sql),
      prepare: (sql) => real.prepare(sql),
    };
  } catch {
    // Fallback: Node's built-in SQLite.
    const { DatabaseSync } = await import('node:sqlite');
    const real = new DatabaseSync(dbFile);
    real.exec('PRAGMA journal_mode = WAL;');
    driver = 'node:sqlite';
    db = {
      exec: (sql) => real.exec(sql),
      prepare: (sql) => {
        const stmt = real.prepare(sql);
        // Normalize the lastInsertRowid field name across drivers.
        return {
          run: (...args) => {
            const r = stmt.run(...args);
            return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
          },
          get: (...args) => stmt.get(...args),
          all: (...args) => stmt.all(...args),
        };
      },
    };
  }
}

await initDriver();
export const dbDriver = driver;

db.exec(`
  CREATE TABLE IF NOT EXISTS PortfolioAccess (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fullName     TEXT    NOT NULL,
    companyName  TEXT    NOT NULL,
    email        TEXT    NOT NULL,
    phone        TEXT,
    message      TEXT,
    status       TEXT    NOT NULL DEFAULT 'pending',
    token        TEXT,
    ip           TEXT,
    country      TEXT,
    userAgent    TEXT,
    createdAt    TEXT    NOT NULL,
    approvedAt   TEXT,
    lastActivity TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pa_status ON PortfolioAccess(status);
  CREATE INDEX IF NOT EXISTS idx_pa_email  ON PortfolioAccess(email);
  CREATE INDEX IF NOT EXISTS idx_pa_token  ON PortfolioAccess(token);
`);

const nowISO = () => new Date().toISOString();
const namedToPositional = (sql, obj) => {
  // node:sqlite supports named params with $/@/: but to keep both drivers
  // happy we bind named objects directly (both accept an object for @name).
  return obj;
};

export const Access = {
  create(data) {
    const createdAt = nowISO();
    const info = db
      .prepare(`
        INSERT INTO PortfolioAccess
          (fullName, companyName, email, phone, message, status, ip, country, userAgent, createdAt, lastActivity)
        VALUES
          (@fullName, @companyName, @email, @phone, @message, 'pending', @ip, @country, @userAgent, @createdAt, @createdAt)
      `)
      .run({
        fullName: data.fullName,
        companyName: data.companyName,
        email: data.email,
        phone: data.phone || null,
        message: data.message || null,
        ip: data.ip || null,
        country: data.country || null,
        userAgent: data.userAgent || null,
        createdAt,
      });
    return this.byId(Number(info.lastInsertRowid));
  },

  byId(id) {
    return db.prepare('SELECT * FROM PortfolioAccess WHERE id = ?').get(id);
  },
  byToken(token) {
    if (!token) return undefined;
    return db.prepare('SELECT * FROM PortfolioAccess WHERE token = ?').get(token);
  },
  setStatus(id, status, { token = null, approvedAt = null } = {}) {
    db.prepare(`
      UPDATE PortfolioAccess
      SET status = ?, token = ?, approvedAt = ?, lastActivity = ?
      WHERE id = ?
    `).run(status, token, approvedAt, nowISO(), id);
    return this.byId(id);
  },
  touch(id) {
    db.prepare('UPDATE PortfolioAccess SET lastActivity = ? WHERE id = ?').run(nowISO(), id);
  },
  remove(id) {
    return db.prepare('DELETE FROM PortfolioAccess WHERE id = ?').run(id).changes;
  },

  list({ status, search, page = 1, pageSize = 10 } = {}) {
    const where = [];
    const params = {};
    if (status && status !== 'all') { where.push('status = @status'); params.status = status; }
    if (search) { where.push('(email LIKE @q OR companyName LIKE @q OR fullName LIKE @q)'); params.q = `%${search}%`; }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM PortfolioAccess ${whereSql}`).get(params).c;
    const offset = (Math.max(1, page) - 1) * pageSize;
    const rows = db.prepare(
      `SELECT * FROM PortfolioAccess ${whereSql} ORDER BY datetime(createdAt) DESC LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit: pageSize, offset });
    return { rows, total, page, pageSize, pages: Math.ceil(total / pageSize) || 1 };
  },

  all() {
    return db.prepare('SELECT * FROM PortfolioAccess ORDER BY datetime(createdAt) DESC').all();
  },

  stats() {
    const row = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
      FROM PortfolioAccess`).get();
    return {
      total: row.total || 0, pending: row.pending || 0,
      approved: row.approved || 0, rejected: row.rejected || 0,
    };
  },
};

export default db;
