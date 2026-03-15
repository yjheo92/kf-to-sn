/**
 * db.js — SQLite 기반 작업 임시저장/불러오기 모듈
 * 저장 항목: catalogName, catalogDescription, fields, guideBlocks
 * 저장 제외: 인증정보 (instance, username, password)
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'drafts.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    cat_name  TEXT NOT NULL DEFAULT '',
    cat_desc  TEXT NOT NULL DEFAULT '',
    payload   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

const stmts = {
  insert: db.prepare(`
    INSERT INTO drafts (name, cat_name, cat_desc, payload, created_at, updated_at)
    VALUES (@name, @cat_name, @cat_desc, @payload, datetime('now','localtime'), datetime('now','localtime'))
  `),
  update: db.prepare(`
    UPDATE drafts
    SET name=@name, cat_name=@cat_name, cat_desc=@cat_desc, payload=@payload,
        updated_at=datetime('now','localtime')
    WHERE id=@id
  `),
  getAll: db.prepare(`SELECT id, name, cat_name, cat_desc, created_at, updated_at FROM drafts ORDER BY updated_at DESC`),
  getOne: db.prepare(`SELECT * FROM drafts WHERE id=?`),
  delete: db.prepare(`DELETE FROM drafts WHERE id=?`),
};

/**
 * 저장 또는 업데이트
 * @param {{ id?, name, catalogName, catalogDescription, fields, clientScripts }} data
 */
function saveDraft({ id, name, catalogName, catalogDescription, fields, clientScripts }) {
  const payload = JSON.stringify({ fields, clientScripts: clientScripts || [] });
  if (id) {
    stmts.update.run({ id, name, cat_name: catalogName || '', cat_desc: catalogDescription || '', payload });
    return { id: Number(id), updated: true };
  } else {
    const info = stmts.insert.run({ name, cat_name: catalogName || '', cat_desc: catalogDescription || '', payload });
    return { id: info.lastInsertRowid, updated: false };
  }
}

/** 목록 반환 */
function listDrafts() {
  return stmts.getAll.all();
}

/** 단건 반환 (payload 파싱 포함) */
function getDraft(id) {
  const row = stmts.getOne.get(id);
  if (!row) return null;
  const { fields, clientScripts } = JSON.parse(row.payload);
  return {
    id: row.id,
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
function deleteDraft(id) {
  const info = stmts.delete.run(id);
  return info.changes > 0;
}

/** DB 어드민용: 테이블 목록 */
function adminGetTables() {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
}

/** DB 어드민용: 테이블 전체 행 (최대 500) */
function adminGetRows(table) {
  // 테이블명 화이트리스트 — sqlite_master로 실존 확인
  const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  if (!exists) throw new Error('존재하지 않는 테이블입니다');
  return db.prepare(`SELECT * FROM "${table}" LIMIT 500`).all();
}

/** DB 어드민용: 단건 삭제 (drafts 테이블 전용) */
function adminDeleteRow(table, id) {
  const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  if (!exists) throw new Error('존재하지 않는 테이블입니다');
  const info = db.prepare(`DELETE FROM "${table}" WHERE id=?`).run(id);
  return info.changes > 0;
}

module.exports = { saveDraft, listDrafts, getDraft, deleteDraft, adminGetTables, adminGetRows, adminDeleteRow };
