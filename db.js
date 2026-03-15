/**
 * db.js — 듀얼 DB 모듈
 *   - 로컬 개발: @libsql/client/node (SQLite file)
 *   - Vercel/Supabase 배포: postgres (node-postgres compatible)
 *
 * DATABASE_URL 또는 POSTGRES_URL 환경변수가 있으면 Postgres 사용,
 * 없으면 로컬 SQLite 사용.
 */

const path = require('path');
const fs   = require('fs');

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
const USE_POSTGRES = !!CONNECTION_STRING;
const SQLITE_PATH  = path.join(__dirname, 'data', 'drafts.db');

// ── Postgres (postgres 드라이버) ───────────────────────────────
let pgSql;
if (USE_POSTGRES) {
  const postgres = require('postgres');
  pgSql = postgres(CONNECTION_STRING, {
    ssl: 'require',
    max: 1,          // 서버리스 환경에서 연결 수 제한
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

// ── Local SQLite (libsql) ──────────────────────────────────────
let sqliteDb;
if (!USE_POSTGRES) {
  const { createClient } = require('@libsql/client/node');
  const DATA_DIR = path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  sqliteDb = createClient({ url: `file:${SQLITE_PATH}` });
}

// ── 테이블 생성 ───────────────────────────────────────────────
async function createTables() {
  if (USE_POSTGRES) {
    await pgSql`
      CREATE TABLE IF NOT EXISTS drafts (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        cat_name   TEXT NOT NULL DEFAULT '',
        cat_desc   TEXT NOT NULL DEFAULT '',
        payload    TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await pgSql`
      CREATE TABLE IF NOT EXISTS _migrations (
        key        TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  } else {
    await sqliteDb.execute(`
      CREATE TABLE IF NOT EXISTS drafts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        cat_name   TEXT NOT NULL DEFAULT '',
        cat_desc   TEXT NOT NULL DEFAULT '',
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      )
    `);
  }
}

// ── SQLite → Postgres 마이그레이션 ───────────────────────────
async function migrateFromSqlite() {
  if (!USE_POSTGRES) return;
  if (!fs.existsSync(SQLITE_PATH)) return;

  const done = await pgSql`SELECT key FROM _migrations WHERE key='sqlite_initial'`;
  if (done.length > 0) {
    console.log('[DB] SQLite 마이그레이션 이미 완료 — 스킵');
    return;
  }

  console.log('[DB] SQLite → Postgres 마이그레이션 시작...');

  let srcClient;
  try {
    const { createClient } = require('@libsql/client/node');
    srcClient = createClient({ url: `file:${SQLITE_PATH}` });
  } catch (e) {
    console.warn('[DB] SQLite 파일 읽기 실패 — 마이그레이션 스킵:', e.message);
    return;
  }

  let rows;
  try {
    const result = await srcClient.execute(`SELECT * FROM drafts ORDER BY id ASC`);
    rows = result.rows;
  } catch (e) {
    console.warn('[DB] drafts 테이블 없음 — 마이그레이션 스킵:', e.message);
    await pgSql`INSERT INTO _migrations (key) VALUES ('sqlite_initial')`;
    return;
  }

  if (rows.length === 0) {
    console.log('[DB] SQLite에 데이터 없음 — 완료 표시');
    await pgSql`INSERT INTO _migrations (key) VALUES ('sqlite_initial')`;
    return;
  }

  let migrated = 0;
  for (const row of rows) {
    try {
      const createdAt = row.created_at ? new Date(row.created_at) : new Date();
      const updatedAt = row.updated_at ? new Date(row.updated_at) : new Date();
      await pgSql`
        INSERT INTO drafts (name, cat_name, cat_desc, payload, created_at, updated_at)
        VALUES (${row.name}, ${row.cat_name || ''}, ${row.cat_desc || ''}, ${row.payload},
                ${createdAt}, ${updatedAt})
        ON CONFLICT DO NOTHING
      `;
      migrated++;
    } catch (e) {
      console.warn(`[DB] 행 ${row.id} 마이그레이션 실패:`, e.message);
    }
  }

  await pgSql`INSERT INTO _migrations (key) VALUES ('sqlite_initial')`;

  const backupPath = SQLITE_PATH + '.migrated';
  try {
    fs.renameSync(SQLITE_PATH, backupPath);
    console.log(`[DB] ✓ ${migrated}/${rows.length}개 마이그레이션 완료 → 백업: ${backupPath}`);
  } catch {
    console.log(`[DB] ✓ ${migrated}/${rows.length}개 마이그레이션 완료`);
  }
}

// ── 초기화 (서버 시작 시 1회) ─────────────────────────────────
async function initDb() {
  await createTables();
  await migrateFromSqlite();
  console.log(`[DB] 준비 완료 (${USE_POSTGRES ? 'Postgres' : 'SQLite'})`);
}

// ── 저장 또는 업데이트 ────────────────────────────────────────
async function saveDraft({ id, name, catalogName, catalogDescription, fields, clientScripts }) {
  const payload = JSON.stringify({ fields, clientScripts: clientScripts || [] });
  const catName = catalogName || '';
  const catDesc = catalogDescription || '';

  if (id) {
    if (USE_POSTGRES) {
      await pgSql`
        UPDATE drafts SET name=${name}, cat_name=${catName}, cat_desc=${catDesc},
        payload=${payload}, updated_at=NOW() WHERE id=${Number(id)}
      `;
    } else {
      await sqliteDb.execute({
        sql: `UPDATE drafts SET name=?, cat_name=?, cat_desc=?, payload=?,
              updated_at=datetime('now','localtime') WHERE id=?`,
        args: [name, catName, catDesc, payload, Number(id)],
      });
    }
    return { id: Number(id), updated: true };
  } else {
    if (USE_POSTGRES) {
      const rows = await pgSql`
        INSERT INTO drafts (name, cat_name, cat_desc, payload)
        VALUES (${name}, ${catName}, ${catDesc}, ${payload})
        RETURNING id
      `;
      return { id: Number(rows[0].id), updated: false };
    } else {
      const result = await sqliteDb.execute({
        sql: `INSERT INTO drafts (name, cat_name, cat_desc, payload, created_at, updated_at)
              VALUES (?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
        args: [name, catName, catDesc, payload],
      });
      return { id: Number(result.lastInsertRowid), updated: false };
    }
  }
}

// ── 목록 반환 ─────────────────────────────────────────────────
async function listDrafts() {
  if (USE_POSTGRES) {
    return pgSql`SELECT id, name, cat_name, cat_desc, created_at, updated_at
                 FROM drafts ORDER BY updated_at DESC`;
  } else {
    const result = await sqliteDb.execute(
      `SELECT id, name, cat_name, cat_desc, created_at, updated_at FROM drafts ORDER BY updated_at DESC`
    );
    return result.rows;
  }
}

// ── 단건 반환 ─────────────────────────────────────────────────
async function getDraft(id) {
  let row;
  if (USE_POSTGRES) {
    const rows = await pgSql`SELECT * FROM drafts WHERE id=${Number(id)}`;
    row = rows[0];
  } else {
    const result = await sqliteDb.execute({ sql: `SELECT * FROM drafts WHERE id=?`, args: [Number(id)] });
    row = result.rows[0];
  }
  if (!row) return null;
  const { fields, clientScripts } = JSON.parse(row.payload);
  return {
    id: Number(row.id),
    name: row.name,
    catalogName: row.cat_name,
    catalogDescription: row.cat_desc,
    fields,
    clientScripts: clientScripts || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── 삭제 ──────────────────────────────────────────────────────
async function deleteDraft(id) {
  if (USE_POSTGRES) {
    const rows = await pgSql`DELETE FROM drafts WHERE id=${Number(id)} RETURNING id`;
    return rows.length > 0;
  } else {
    const result = await sqliteDb.execute({ sql: `DELETE FROM drafts WHERE id=?`, args: [Number(id)] });
    return result.rowsAffected > 0;
  }
}

// ── DB 어드민: 테이블 목록 ────────────────────────────────────
async function adminGetTables() {
  if (USE_POSTGRES) {
    return pgSql`SELECT table_name AS name FROM information_schema.tables
                 WHERE table_schema='public' ORDER BY table_name`;
  } else {
    const result = await sqliteDb.execute(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
    return result.rows;
  }
}

// ── DB 어드민: 테이블 전체 행 ─────────────────────────────────
async function adminGetRows(table) {
  if (USE_POSTGRES) {
    const check = await pgSql`SELECT table_name FROM information_schema.tables
                               WHERE table_schema='public' AND table_name=${table}`;
    if (!check[0]) throw new Error('존재하지 않는 테이블입니다');
    // 동적 테이블명은 pgSql.unsafe 사용
    return pgSql.unsafe(`SELECT * FROM "${table}" LIMIT 500`);
  } else {
    const check = await sqliteDb.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, args: [table],
    });
    if (!check.rows[0]) throw new Error('존재하지 않는 테이블입니다');
    const result = await sqliteDb.execute({ sql: `SELECT * FROM "${table}" LIMIT 500`, args: [] });
    return result.rows;
  }
}

// ── DB 어드민: 단건 삭제 ──────────────────────────────────────
async function adminDeleteRow(table, id) {
  if (USE_POSTGRES) {
    const check = await pgSql`SELECT table_name FROM information_schema.tables
                               WHERE table_schema='public' AND table_name=${table}`;
    if (!check[0]) throw new Error('존재하지 않는 테이블입니다');
    const rows = await pgSql.unsafe(`DELETE FROM "${table}" WHERE id=$1 RETURNING id`, [id]);
    return rows.length > 0;
  } else {
    const check = await sqliteDb.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, args: [table],
    });
    if (!check.rows[0]) throw new Error('존재하지 않는 테이블입니다');
    const result = await sqliteDb.execute({ sql: `DELETE FROM "${table}" WHERE id=?`, args: [Number(id)] });
    return result.rowsAffected > 0;
  }
}

module.exports = { initDb, saveDraft, listDrafts, getDraft, deleteDraft, adminGetTables, adminGetRows, adminDeleteRow };
