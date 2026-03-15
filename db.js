/**
 * db.js — @libsql/client 기반 SQLite 임시저장/불러오기 모듈
 * 로컬: file:data/drafts.db  /  Turso: LIBSQL_URL + LIBSQL_AUTH_TOKEN 환경변수
 */
const { createClient } = require('@libsql/client/node');
const path = require('path');
const fs = require('fs');

// 로컬 파일 모드일 때 data 디렉토리 보장
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const url = process.env.LIBSQL_URL || `file:${path.join(DATA_DIR, 'drafts.db')}`;
const authToken = process.env.LIBSQL_AUTH_TOKEN;

const db = createClient(authToken ? { url, authToken } : { url });

/** 테이블 초기화 (서버 시작 시 1회 호출) */
async function initDb() {
  await db.execute(`
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

/**
 * 저장 또는 업데이트
 * @param {{ id?, name, catalogName, catalogDescription, fields, clientScripts }} data
 */
async function saveDraft({ id, name, catalogName, catalogDescription, fields, clientScripts }) {
  const payload = JSON.stringify({ fields, clientScripts: clientScripts || [] });
  if (id) {
    await db.execute({
      sql: `UPDATE drafts SET name=?, cat_name=?, cat_desc=?, payload=?,
            updated_at=datetime('now','localtime') WHERE id=?`,
      args: [name, catalogName || '', catalogDescription || '', payload, Number(id)],
    });
    return { id: Number(id), updated: true };
  } else {
    const result = await db.execute({
      sql: `INSERT INTO drafts (name, cat_name, cat_desc, payload, created_at, updated_at)
            VALUES (?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
      args: [name, catalogName || '', catalogDescription || '', payload],
    });
    return { id: Number(result.lastInsertRowid), updated: false };
  }
}

/** 목록 반환 */
async function listDrafts() {
  const result = await db.execute(
    `SELECT id, name, cat_name, cat_desc, created_at, updated_at FROM drafts ORDER BY updated_at DESC`
  );
  return result.rows;
}

/** 단건 반환 (payload 파싱 포함) */
async function getDraft(id) {
  const result = await db.execute({
    sql: `SELECT * FROM drafts WHERE id=?`,
    args: [Number(id)],
  });
  const row = result.rows[0];
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

/** 삭제 */
async function deleteDraft(id) {
  const result = await db.execute({
    sql: `DELETE FROM drafts WHERE id=?`,
    args: [Number(id)],
  });
  return result.rowsAffected > 0;
}

/** DB 어드민용: 테이블 목록 */
async function adminGetTables() {
  const result = await db.execute(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  );
  return result.rows;
}

/** DB 어드민용: 테이블 전체 행 (최대 500) */
async function adminGetRows(table) {
  const check = await db.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    args: [table],
  });
  if (!check.rows[0]) throw new Error('존재하지 않는 테이블입니다');
  const result = await db.execute({ sql: `SELECT * FROM "${table}" LIMIT 500`, args: [] });
  return result.rows;
}

/** DB 어드민용: 단건 삭제 (drafts 테이블 전용) */
async function adminDeleteRow(table, id) {
  const check = await db.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    args: [table],
  });
  if (!check.rows[0]) throw new Error('존재하지 않는 테이블입니다');
  const result = await db.execute({
    sql: `DELETE FROM "${table}" WHERE id=?`,
    args: [Number(id)],
  });
  return result.rowsAffected > 0;
}

module.exports = { initDb, saveDraft, listDrafts, getDraft, deleteDraft, adminGetTables, adminGetRows, adminDeleteRow };
