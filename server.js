const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const JSZip = require('jszip');
require('dotenv').config();

const { parseKissflowHTML } = require('./parser');
const { ServiceNowClient } = require('./snowClient');
const { initDb, saveDraft, listDrafts, getDraft, deleteDraft, adminGetTables, adminGetRows, adminDeleteRow } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// Multiple files: HTML + JS + CSS
const multiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
}).fields([
  { name: 'htmlFile', maxCount: 1 },
  { name: 'jsFiles', maxCount: 20 },
  { name: 'cssFiles', maxCount: 30 },
  { name: 'zipFile', maxCount: 1 },
]);

let analysisCache = {};
let snowClient = null;

// ─────────────────────────────────────────────────────────────
// API: ServiceNow 연결 설정
// ─────────────────────────────────────────────────────────────
app.post('/api/snow/connect', async (req, res) => {
  try {
    const { instance, username, password } = req.body;
    if (!instance || !username || !password)
      return res.status(400).json({ success: false, error: '모든 필드를 입력하세요' });

    snowClient = new ServiceNowClient(instance, username, password);
    const testResult = await snowClient.testConnection();

    if (testResult.success) {
      res.json({ success: true, message: '연결 성공', user: testResult.user });
    } else {
      snowClient = null;
      res.status(401).json({ success: false, error: testResult.error });
    }
  } catch (error) {
    snowClient = null;
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/snow/status', (req, res) => {
  res.json({ connected: snowClient !== null });
});

// ─────────────────────────────────────────────────────────────
// API: 단일 HTML 파일 업로드
// ─────────────────────────────────────────────────────────────
app.post('/api/analyze', upload.single('htmlFile'), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: 'HTML 파일을 업로드하세요' });

    const htmlContent = req.file.buffer.toString('utf-8');

    const analysis = parseKissflowHTML(htmlContent, [], []);
    const analysisId = `analysis_${Date.now()}`;
    analysisCache[analysisId] = analysis;

    res.json({ success: true, analysisId, ...formatAnalysisResponse(analysis) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// API: 다중 파일 업로드 (HTML + JS + CSS) or ZIP
// ─────────────────────────────────────────────────────────────
app.post('/api/analyze-folder', multiUpload, async (req, res) => {
  try {
    // Case 1: ZIP file
    if (req.files?.zipFile?.[0]) {
      const zipBuffer = req.files.zipFile[0].buffer;
      const zip = await JSZip.loadAsync(zipBuffer);

      let htmlContent = '';
      const jsFiles = [];
      const cssFiles = [];

      for (const [filename, file] of Object.entries(zip.files)) {
        if (file.dir) continue;
        const ext = path.extname(filename).toLowerCase();
        const content = await file.async('string');

        if (ext === '.html' && !htmlContent) {
          htmlContent = content;
        } else if (ext === '.js' && !filename.includes('external')) {
          jsFiles.push({ name: filename, content });
        } else if (ext === '.css') {
          cssFiles.push({ name: filename, content });
        }
      }

      if (!htmlContent)
        return res.status(400).json({ success: false, error: 'ZIP에서 HTML 파일을 찾을 수 없습니다' });

      const analysis = parseKissflowHTML(htmlContent, jsFiles, cssFiles);
      const analysisId = `analysis_${Date.now()}`;
      analysisCache[analysisId] = analysis;

      return res.json({ success: true, analysisId, ...formatAnalysisResponse(analysis) });
    }

    // Case 2: Separate HTML + JS + CSS files
    const htmlFile = req.files?.htmlFile?.[0];
    if (!htmlFile)
      return res.status(400).json({ success: false, error: 'HTML 파일을 업로드하세요' });

    const htmlContent = htmlFile.buffer.toString('utf-8');

    const jsFiles = (req.files?.jsFiles || []).map(f => ({
      name: f.originalname,
      content: f.buffer.toString('utf-8'),
    }));

    const cssFiles = (req.files?.cssFiles || []).map(f => ({
      name: f.originalname,
      content: f.buffer.toString('utf-8'),
    }));

    const analysis = parseKissflowHTML(htmlContent, jsFiles, cssFiles);
    const analysisId = `analysis_${Date.now()}`;
    analysisCache[analysisId] = analysis;

    res.json({ success: true, analysisId, ...formatAnalysisResponse(analysis) });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// API: 분석 결과 조회
// ─────────────────────────────────────────────────────────────
app.get('/api/analysis/:id', (req, res) => {
  const analysis = analysisCache[req.params.id];
  if (!analysis) return res.status(404).json({ success: false, error: '분석 결과를 찾을 수 없습니다' });
  res.json({ success: true, ...formatAnalysisResponse(analysis) });
});

// ─────────────────────────────────────────────────────────────
// API: ServiceNow에 Catalog 생성
// ─────────────────────────────────────────────────────────────
app.post('/api/snow/create-catalog', async (req, res) => {
  try {
    if (!snowClient)
      return res.status(400).json({ success: false, error: 'ServiceNow에 먼저 연결하세요' });

    const { analysisId, catalogName, catalogDescription, selectedFieldIds, referenceMappings, requesterMappings, fieldNameOverrides, guideBlocks, conditionalNotices } = req.body;
    const analysis = analysisCache[analysisId];
    if (!analysis)
      return res.status(400).json({ success: false, error: '분석 결과를 찾을 수 없습니다. 다시 분석하세요.' });

    // Use only user-selected fields if provided, otherwise use default migratable
    const fieldsToMigrate = selectedFieldIds?.length
      ? analysis.fields.filter(f => selectedFieldIds.includes(f.id))
      : analysis.fields.filter(f => f.migrateByDefault);

    // fieldNameOverrides 적용: UI에서 수정한 변수명을 field.name에 반영
    const overrides = fieldNameOverrides || {};
    const fieldsWithNames = fieldsToMigrate.map(f => ({
      ...f,
      name: overrides[f.id] ? overrides[f.id].trim() : f.name,
    }));

    const result = await snowClient.createFullCatalog({
      name: catalogName || analysis.processName,
      description: catalogDescription || `Migrated from Kissflow: ${analysis.processName}`,
      fields: fieldsWithNames,
      sections: analysis.sections,
      clientScripts: analysis.clientScripts,
      referenceMappings: referenceMappings || {},
      requesterMappings: requesterMappings || {},
      guideBlocks: guideBlocks || [],
      conditionalNotices: conditionalNotices || {},
    });

    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// API: API JSON 다운로드
// ─────────────────────────────────────────────────────────────
app.get('/api/export/:id', (req, res) => {
  const analysis = analysisCache[req.params.id];
  if (!analysis) return res.status(404).json({ success: false, error: '분석 결과를 찾을 수 없습니다' });

  const exportData = {
    processName: analysis.processName,
    generatedAt: new Date().toISOString(),
    summary: analysis.stats,
    apiRequests: analysis.apiRequests,
    clientScripts: analysis.clientScripts,
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${analysis.processName}_snow_api.json"`);
  res.json(exportData);
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function formatAnalysisResponse(analysis) {
  return {
    processName: analysis.processName,
    stats: analysis.stats,
    sections: analysis.sections,
    fields: analysis.fields,
    apiRequests: analysis.apiRequests,
    clientScripts: analysis.clientScripts,
    jsConditionsFound: analysis.jsConditionsFound,
  };
}

// ═════════════════════════════════════════════════════════════
// API: Draft → curl 명령 생성
// GET /api/snow/curl-preview/:draftId
// 저장된 draft 기준으로 ServiceNow 생성에 필요한
// 모든 API 호출을 순서대로 curl 명령으로 반환합니다.
// cat_item sys_id 는 1번 호출(Catalog Item 생성) 결과를 사용해야 하므로
// 스크립트에서 CAT_ITEM_ID 변수로 치환하여 표시합니다.
// ═════════════════════════════════════════════════════════════
app.get('/api/snow/curl-preview/:draftId', async (req, res) => {
  if (!snowClient)
    return res.status(400).json({ success: false, error: 'ServiceNow에 먼저 연결하세요' });

  const draft = await getDraft(Number(req.params.draftId));
  if (!draft) return res.status(404).json({ success: false, error: 'Draft를 찾을 수 없습니다' });

  const BASE   = snowClient.baseUrl;
  const AUTH   = `Basic ${snowClient.auth}`;
  const H      = `-H 'Content-Type: application/json' -H 'Accept: application/json' -H 'Authorization: ${AUTH}'`;
  const TABLE  = `${BASE}/api/now/table`;

  const CURRENCY_SYMBOLS = { KRW: '₩', USD: '$', EUR: '€', JPY: '¥', GBP: '£', CNY: '¥' };

  const curls = [];
  let order = 100;

  const j = (obj) => JSON.stringify(obj);

  // ── 1. Catalog Item 생성 ──────────────────────────────────
  curls.push({
    step: '1. Catalog Item 생성',
    note: '→ 응답의 result.sys_id 를 CAT_ITEM_ID 변수에 저장하세요',
    cmd: `curl -s -X POST '${TABLE}/sc_cat_item' ${H} \\\n  -d '${j({ name: draft.catalogName, short_description: draft.catalogDescription || draft.catalogName, description: draft.catalogDescription || draft.catalogName, active: true, use_sc_layout: true, no_quantity: true })}' | python3 -m json.tool`,
  });
  curls.push({ step: '', note: '이후 모든 명령에서 CAT_ITEM_ID를 실제 sys_id로 교체하세요', cmd: `CAT_ITEM_ID="<위에서 받은 sys_id>"` });

  // ── 2~3. Variables (fields 순서대로) ────────────────────
  for (const field of (draft.fields || [])) {

    // 섹션
    if (field._type === 'section') {
      const body = { cat_item: 'CAT_ITEM_ID', name: field.name, question_text: field.label || '', type: '11', order: String(order), active: true };
      curls.push({ step: `섹션: ${field.label || field.name}`, cmd: `curl -s -X POST '${TABLE}/item_option_new' ${H} \\\n  -d '${j(body).replace(/CAT_ITEM_ID/g, '$CAT_ITEM_ID')}' | python3 -m json.tool` });
      order += 100; continue;
    }

    // 안내문 블록
    if (field._type === 'label') {
      const body = { cat_item: 'CAT_ITEM_ID', name: field.name || `guide_${order}`, question_text: field.html || '', type: '32', order: String(order), active: true };
      curls.push({ step: `안내문 블록: ${field.name}`, cmd: `curl -s -X POST '${TABLE}/item_option_new' ${H} \\\n  -d '${j(body).replace(/CAT_ITEM_ID/g, '$CAT_ITEM_ID')}' | python3 -m json.tool` });
      order += 100; continue;
    }

    // 일반 Variable
    const varBody = {
      cat_item: '$CAT_ITEM_ID',
      name: field.name,
      question_text: field.label || field.name,
      type: field.snowType,
      order: String(order),
      active: true,
      mandatory: field.mandatory ? true : false,
    };
    if (field.readOnly) varBody.read_only = true;
    if (field.helpText) varBody.help_text = field.helpText;

    if (field.snowType === '8' || field._fieldType === 'reference') {
      varBody.type = '8';
      varBody.reference = (field.reference || '').trim() || 'sys_user';
      if (field.refQual) varBody.reference_qual = field.refQual;
    }
    if (field._fieldType === 'macro' || field.macroName) {
      varBody.type = '15';  // UI Page
      varBody.macro = '<UI_MACRO_SYS_ID>';
      if (field.macroName) varBody._macro_name_hint = field.macroName;
    }
    if ((field.snowType === '5' || field.snowType === '21') && field.ddDefault) varBody.default_value = field.ddDefault;
    if (field.snowType === '1' && field.boolDefault === 'true') varBody.default_value = 'true';
    if (field.currencyCode) {
      const sym = CURRENCY_SYMBOLS[field.currencyCode] || field.currencyCode;
      varBody.question_text = `${field.label || field.name} (${field.currencyCode} ${sym})`;
      varBody.help_text = varBody.help_text || `숫자만 입력하세요. 통화: ${field.currencyCode} ${sym}`;
    }
    if (field.snowType === '5' && field.dropdownType === 'table' && field.dropdownTable) {
      varBody.type = '18';  // Lookup Select Box
      varBody.lookup_table = field.dropdownTable;
      varBody.lookup_value = field.dropdownDisplayField || 'name';
    }

    const bodyStr = JSON.stringify(varBody, null, 2);
    curls.push({
      step: `Variable: ${field.label || field.name} (${field._fieldType}, type=${varBody.type})`,
      note: field._fieldType === 'macro' ? `→ 먼저 macro sys_id 조회: GET /api/snow/proxy/macro?name=${field.macroName}` : undefined,
      cmd: `curl -s -X POST '${TABLE}/item_option_new' ${H} \\\n  -d '${bodyStr.replace(/\n/g, '\n  ')}' | python3 -m json.tool`,
      varName: `VAR_${field.name.toUpperCase()}`,
      note2: `→ 응답 result.sys_id 를 ${`VAR_${field.name.toUpperCase()}`} 에 저장`,
    });

    // 드롭다운 고정 옵션 (Select Box=5)
    if (field.snowType === '5' && field.dropdownType !== 'table' && field.options?.length) {
      field.options.forEach((opt, i) => {
        const choiceBody = {
          question: `$VAR_${field.name.toUpperCase()}`,
          text: String(opt.label || opt),
          value: String(opt.value || opt).toLowerCase().replace(/[^a-z0-9가-힣]/g, '_'),
          order: String((i + 1) * 100),
        };
        curls.push({
          step: `  드롭다운 옵션: ${field.name} → "${opt.label}"`,
          cmd: `curl -s -X POST '${TABLE}/question_choice' ${H} \\\n  -d '${j(choiceBody)}' | python3 -m json.tool`,
        });
      });
    }

    order += 100;
  }

  // ── 4. onLoad Client Script (신청자 자동채움 + 숨김) ──────
  const onLoadLines = [];
  for (const field of (draft.fields || [])) {
    if (field.isRequester && field.requesterCol)
      onLoadLines.push(`  g_form.setValue('${field.name}', currentUser.getValue('${field.requesterCol}'));`);
    if (field.hidden)
      onLoadLines.push(`  g_form.setVisible('${field.name}', false);`);
  }
  if (onLoadLines.length) {
    const hasRequester = onLoadLines.some(l => l.includes('setValue'));
    const lines = ['function onLoad() {'];
    if (hasRequester) lines.push(`  var gr = new GlideRecord('sys_user');\n  gr.get(g_user.userID);\n  var currentUser = gr;\n`);
    lines.push(...onLoadLines, '}');
    const csBody = { sys_class_name: 'catalog_script_client', name: 'onLoad_RequesterAutoFill', type: 'onLoad', cat_item: '$CAT_ITEM_ID', script: lines.join('\n'), active: true };
    curls.push({ step: 'onLoad Client Script (신청자 자동채움 / 기본 숨김)', cmd: `curl -s -X POST '${TABLE}/catalog_script_client' ${H} \\\n  -d '${j(csBody)}' | python3 -m json.tool` });
  }

  // ── 5. onChange Client Scripts (드롭다운 규칙) ─────────────
  for (const field of (draft.fields || [])) {
    if (!field.onchangeRules?.length) continue;
    const lines = [`function onChange(control, oldValue, newValue, isLoading) {`, `  if (isLoading) return;`, ``];
    for (const rule of field.onchangeRules) {
      const condVal = String(rule.triggerValue || '').replace(/'/g, "\\'");
      lines.push(`  if (newValue == '${condVal}') {`);
      for (const act of rule.actions) {
        const t = act.target; if (!t) continue;
        if (act.visibility === 'show') lines.push(`    g_form.setVisible('${t}', true);`);
        else if (act.visibility === 'hide') lines.push(`    g_form.setVisible('${t}', false);`);
        if (act.value !== '' && act.value !== undefined && act.value !== null)
          lines.push(`    g_form.setValue('${t}', '${String(act.value).replace(/'/g, "\\'")}');`);
        if (act.mandatory === 'set') lines.push(`    g_form.setMandatory('${t}', true);`);
        else if (act.mandatory === 'unset') lines.push(`    g_form.setMandatory('${t}', false);`);
      }
      lines.push(`  }`);
    }
    lines.push('}');
    const csBody = { sys_class_name: 'catalog_script_client', name: `onChange_${field.name}`, type: 'onChange', cat_item: '$CAT_ITEM_ID', variable_name: field.name, cat_variable: `$VAR_${field.name.toUpperCase()}`, script: lines.join('\n'), active: true };
    curls.push({ step: `onChange Client Script: ${field.name} (${field.onchangeRules.length}개 규칙)`, cmd: `curl -s -X POST '${TABLE}/catalog_script_client' ${H} \\\n  -d '${j(csBody)}' | python3 -m json.tool` });
  }

  // ── 6. Currency 검증 onChange ────────────────────────────
  for (const field of (draft.fields || [])) {
    if (!field.currencyCode) continue;
    const sym = CURRENCY_SYMBOLS[field.currencyCode] || field.currencyCode;
    const isDecimal = !['KRW', 'JPY'].includes(field.currencyCode);
    const script = [
      `function onChange(control, oldValue, newValue, isLoading) {`,
      `  if (isLoading || newValue === '' || newValue === null) return;`,
      `  var pattern = ${isDecimal ? '/^\\d+(\\.\\d{1,2})?$/' : '/^\\d+$/'};`,
      `  if (!pattern.test(newValue)) {`,
      `    g_form.showFieldMsg('${field.name}', '숫자만 입력하세요 [${field.currencyCode} ${sym}]', 'error');`,
      `    g_form.setValue('${field.name}', oldValue);`,
      `  } else { g_form.hideFieldMsg('${field.name}'); }`,
      `}`,
    ].join('\n');
    const csBody = { sys_class_name: 'catalog_script_client', name: `onChange_currency_${field.name}`, type: 'onChange', cat_item: '$CAT_ITEM_ID', variable_name: field.name, cat_variable: `$VAR_${field.name.toUpperCase()}`, script, active: true };
    curls.push({ step: `통화 검증 onChange: ${field.name} (${field.currencyCode})`, cmd: `curl -s -X POST '${TABLE}/catalog_script_client' ${H} \\\n  -d '${j(csBody)}' | python3 -m json.tool` });
  }

  // ── 7. 직접 입력 Client Scripts ──────────────────────────
  for (const cs of (draft.clientScripts || [])) {
    if (!cs.script) continue;
    const targets = (cs.type === 'onChange' && cs.fields?.length) ? cs.fields : [null];
    for (const applyField of targets) {
      const csBody = {
        sys_class_name: 'catalog_script_client',
        name: `${cs.name || 'customScript'}${applyField ? `_${applyField}` : ''}`,
        type: cs.type || 'onLoad',
        cat_item: '$CAT_ITEM_ID',
        script: cs.script,
        active: true,
      };
      if (cs.type === 'onChange' && applyField) { csBody.variable_name = applyField; csBody.cat_variable = `$VAR_${applyField.toUpperCase()}`; }
      curls.push({ step: `직접 입력 Client Script: ${csBody.name}`, cmd: `curl -s -X POST '${TABLE}/catalog_script_client' ${H} \\\n  -d '${j(csBody)}' | python3 -m json.tool` });
    }
  }

  res.json({ success: true, draftName: draft.name, catalogName: draft.catalogName, totalSteps: curls.length, curls });
});


// 모든 API는 snowClient(연결)가 필요합니다.
// sc_cat_item_id 는 쿼리스트링 또는 path param 으로 주입합니다.
//
// ┌─────────────────────────────────────────────────────────┐
// │  # 조회(GET)                                            │
// │  GET  /api/snow/proxy/cat-item/:id                      │  카탈로그 아이템 단건
// │  GET  /api/snow/proxy/variables?cat_item=               │  Variable 목록
// │  GET  /api/snow/proxy/variable/:id                      │  Variable 단건
// │  GET  /api/snow/proxy/choices?question=                 │  드롭다운 옵션 목록
// │  GET  /api/snow/proxy/client-scripts?cat_item=          │  Client Script 목록
// │  GET  /api/snow/proxy/client-script/:id                 │  Client Script 단건
// │  GET  /api/snow/proxy/macro?name=                       │  UI Macro sys_id 조회
// │  GET  /api/snow/proxy/variable-type-choices             │  Variable 타입 choice 목록
// │                                                         │
// │  # 생성(POST)                                           │
// │  POST /api/snow/proxy/variable                          │  Variable 생성
// │  POST /api/snow/proxy/choice                            │  드롭다운 옵션 생성
// │  POST /api/snow/proxy/client-script                     │  Client Script 생성
// │                                                         │
// │  # 수정(PATCH)                                          │
// │  PATCH /api/snow/proxy/variable/:id                     │  Variable 수정
// │  PATCH /api/snow/proxy/client-script/:id                │  Client Script 수정
// │                                                         │
// │  # 삭제(DELETE)                                         │
// │  DELETE /api/snow/proxy/variable/:id                    │  Variable 삭제
// │  DELETE /api/snow/proxy/choice/:id                      │  드롭다운 옵션 삭제
// │  DELETE /api/snow/proxy/client-script/:id               │  Client Script 삭제
// └─────────────────────────────────────────────────────────┘
// ═════════════════════════════════════════════════════════════

const SNOW_TABLES = {
  catItem:      'sc_cat_item',
  variable:     'item_option_new',
  choice:       'question_choice',
  clientScript: 'catalog_script_client',
  macro:        'sys_ui_macro',
  sysChoice:    'sys_choice',
};

function requireSnow(req, res) {
  if (!snowClient) {
    res.status(400).json({ success: false, error: 'ServiceNow에 먼저 연결하세요' });
    return false;
  }
  return true;
}

// ── 조회 ─────────────────────────────────────────────────────

// 카탈로그 아이템 단건
app.get('/api/snow/proxy/cat-item/:id', async (req, res) => {
  if (!requireSnow(req, res)) return;
  try {
    const r = await snowClient.client.get(`/api/now/table/${SNOW_TABLES.catItem}/${req.params.id}`);
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// Variable 목록 (cat_item 기준)
app.get('/api/snow/proxy/variables', async (req, res) => {
  if (!requireSnow(req, res)) return;
  const { cat_item, fields = 'sys_id,name,question_text,type,reference,macro,active,order,default_value,read_only,mandatory', limit = 100 } = req.query;
  if (!cat_item) return res.status(400).json({ success: false, error: 'cat_item 쿼리스트링 필요' });
  try {
    const r = await snowClient.client.get(
      `/api/now/table/${SNOW_TABLES.variable}?sysparm_query=cat_item=${cat_item}&sysparm_fields=${fields}&sysparm_orderby=order&sysparm_limit=${limit}`
    );
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// Variable 단건
app.get('/api/snow/proxy/variable/:id', async (req, res) => {
  if (!requireSnow(req, res)) return;
  try {
    const r = await snowClient.client.get(`/api/now/table/${SNOW_TABLES.variable}/${req.params.id}`);
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// 드롭다운 옵션 목록 (question sys_id 기준)
app.get('/api/snow/proxy/choices', async (req, res) => {
  if (!requireSnow(req, res)) return;
  const { question } = req.query;
  if (!question) return res.status(400).json({ success: false, error: 'question 쿼리스트링 필요' });
  try {
    const r = await snowClient.client.get(
      `/api/now/table/${SNOW_TABLES.choice}?sysparm_query=question=${question}&sysparm_fields=sys_id,text,value,order&sysparm_orderby=order&sysparm_limit=200`
    );
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// Client Script 목록 (cat_item 기준)
app.get('/api/snow/proxy/client-scripts', async (req, res) => {
  if (!requireSnow(req, res)) return;
  const { cat_item } = req.query;
  if (!cat_item) return res.status(400).json({ success: false, error: 'cat_item 쿼리스트링 필요' });
  try {
    const r = await snowClient.client.get(
      `/api/now/table/${SNOW_TABLES.clientScript}?sysparm_query=cat_item=${cat_item}&sysparm_fields=sys_id,name,type,script,active,applies_to,field&sysparm_limit=50`
    );
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// Client Script 단건
app.get('/api/snow/proxy/client-script/:id', async (req, res) => {
  if (!requireSnow(req, res)) return;
  try {
    const r = await snowClient.client.get(`/api/now/table/${SNOW_TABLES.clientScript}/${req.params.id}`);
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// UI Macro 조회 (name 기준)
app.get('/api/snow/proxy/macro', async (req, res) => {
  if (!requireSnow(req, res)) return;
  const { name } = req.query;
  if (!name) return res.status(400).json({ success: false, error: 'name 쿼리스트링 필요' });
  try {
    const r = await snowClient.client.get(
      `/api/now/table/${SNOW_TABLES.macro}?sysparm_query=name=${encodeURIComponent(name)}&sysparm_fields=sys_id,name,description&sysparm_limit=5`
    );
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// Variable 타입 choice 목록 (item_option_new.type)
app.get('/api/snow/proxy/variable-type-choices', async (req, res) => {
  if (!requireSnow(req, res)) return;
  try {
    const r = await snowClient.client.get(
      `/api/now/table/${SNOW_TABLES.sysChoice}?sysparm_query=name=item_option_new^element=type&sysparm_fields=value,label,language&sysparm_orderby=value&sysparm_limit=100`
    );
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// ── 생성 ─────────────────────────────────────────────────────

// Variable 생성
app.post('/api/snow/proxy/variable', async (req, res) => {
  if (!requireSnow(req, res)) return;
  try {
    const r = await snowClient.client.post(`/api/now/table/${SNOW_TABLES.variable}`, req.body);
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// 드롭다운 옵션 생성
app.post('/api/snow/proxy/choice', async (req, res) => {
  if (!requireSnow(req, res)) return;
  try {
    const r = await snowClient.client.post(`/api/now/table/${SNOW_TABLES.choice}`, req.body);
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// Client Script 생성
app.post('/api/snow/proxy/client-script', async (req, res) => {
  if (!requireSnow(req, res)) return;
  try {
    const body = { sys_class_name: 'catalog_script_client', ...req.body };
    const r = await snowClient.client.post(`/api/now/table/${SNOW_TABLES.clientScript}`, body);
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// ── 수정 ─────────────────────────────────────────────────────

// Variable 수정
app.patch('/api/snow/proxy/variable/:id', async (req, res) => {
  if (!requireSnow(req, res)) return;
  try {
    const r = await snowClient.client.patch(`/api/now/table/${SNOW_TABLES.variable}/${req.params.id}`, req.body);
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// Client Script 수정
app.patch('/api/snow/proxy/client-script/:id', async (req, res) => {
  if (!requireSnow(req, res)) return;
  try {
    const r = await snowClient.client.patch(`/api/now/table/${SNOW_TABLES.clientScript}/${req.params.id}`, req.body);
    res.json({ success: true, result: r.data.result });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// ── 삭제 ─────────────────────────────────────────────────────

// Variable 삭제
app.delete('/api/snow/proxy/variable/:id', async (req, res) => {
  if (!requireSnow(req, res)) return;
  try {
    await snowClient.client.delete(`/api/now/table/${SNOW_TABLES.variable}/${req.params.id}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// 드롭다운 옵션 삭제
app.delete('/api/snow/proxy/choice/:id', async (req, res) => {
  if (!requireSnow(req, res)) return;
  try {
    await snowClient.client.delete(`/api/now/table/${SNOW_TABLES.choice}/${req.params.id}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});

// Client Script 삭제
app.delete('/api/snow/proxy/client-script/:id', async (req, res) => {
  if (!requireSnow(req, res)) return;
  try {
    await snowClient.client.delete(`/api/now/table/${SNOW_TABLES.clientScript}/${req.params.id}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message, detail: e.response?.data }); }
});


// ─────────────────────────────────────────────────────────────
// API: 수동 Catalog 생성 (Manual Builder)
// ─────────────────────────────────────────────────────────────
app.post('/api/snow/create-manual', async (req, res) => {
  try {
    if (!snowClient)
      return res.status(400).json({ success: false, error: 'ServiceNow에 먼저 연결하세요' });

    const { catalogName, catalogDescription, fields, clientScripts } = req.body;
    if (!catalogName)
      return res.status(400).json({ success: false, error: 'Catalog Item 이름을 입력하세요' });

    const result = await snowClient.createFromManual({
      name: catalogName,
      description: catalogDescription || '',
      fields: fields || [],
      guideBlocks: [],  // fields 배열 안에 _type:'label'로 포함되어 있음
      clientScripts: clientScripts || [],
    });

    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// API: 임시저장 (Draft) CRUD
// ─────────────────────────────────────────────────────────────

// 저장 또는 업데이트
app.post('/api/drafts', async (req, res) => {
  try {
    const { id, name, catalogName, catalogDescription, fields, clientScripts } = req.body;
    if (!name) return res.status(400).json({ success: false, error: '저장 이름을 입력하세요' });
    const result = await saveDraft({ id, name, catalogName, catalogDescription, fields, clientScripts });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 목록
app.get('/api/drafts', async (req, res) => {
  try {
    res.json({ success: true, drafts: await listDrafts() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 단건 불러오기
app.get('/api/drafts/:id', async (req, res) => {
  try {
    const draft = await getDraft(Number(req.params.id));
    if (!draft) return res.status(404).json({ success: false, error: '저장 항목을 찾을 수 없습니다' });
    res.json({ success: true, draft });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 삭제
app.delete('/api/drafts/:id', async (req, res) => {
  try {
    const ok = await deleteDraft(Number(req.params.id));
    res.json({ success: ok });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DB Admin: /db-admin 웹 뷰어
// ─────────────────────────────────────────────────────────────
app.get('/db-admin', (req, res) => {
  res.send(dbAdminHtml());
});

app.get('/api/db-admin/tables', async (req, res) => {
  try { res.json({ success: true, tables: await adminGetTables() }); }
  catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/db-admin/rows/:table', async (req, res) => {
  try { res.json({ success: true, rows: await adminGetRows(req.params.table) }); }
  catch(e) { res.status(400).json({ success: false, error: e.message }); }
});

app.delete('/api/db-admin/rows/:table/:id', async (req, res) => {
  try {
    const ok = await adminDeleteRow(req.params.table, Number(req.params.id));
    res.json({ success: ok });
  } catch(e) { res.status(400).json({ success: false, error: e.message }); }
});

function dbAdminHtml() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DB Admin — drafts.db</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI','Apple SD Gothic Neo',sans-serif;background:#f0f4f8;color:#1a1f2e;font-size:14px;line-height:1.6}
.hdr{background:#fff;border-bottom:1px solid #dde1e7;padding:14px 28px;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:100}
.hdr h1{font-size:17px;font-weight:800}
.hdr span{font-size:12px;color:#5f6b7a;background:#f0f4f8;border:1px solid #dde1e7;border-radius:6px;padding:3px 10px;}
.wrap{max-width:1300px;margin:0 auto;padding:24px}
.layout{display:grid;grid-template-columns:200px 1fr;gap:20px}
@media(max-width:700px){.layout{grid-template-columns:1fr}}
.sidebar{background:#fff;border:1px solid #dde1e7;border-radius:12px;padding:14px;height:fit-content}
.sidebar h2{font-size:12px;font-weight:700;color:#5f6b7a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}
.tbl-btn{display:block;width:100%;text-align:left;padding:8px 12px;border:none;border-radius:7px;background:transparent;font-size:13px;font-weight:600;cursor:pointer;color:#1a1f2e;transition:background .15s}
.tbl-btn:hover{background:#f0f4f8}
.tbl-btn.active{background:#eff6ff;color:#1d4ed8}
.main{background:#fff;border:1px solid #dde1e7;border-radius:12px;padding:20px;min-height:400px}
.main-hdr{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.main-hdr h2{font-size:15px;font-weight:800}
.badge{background:#eff6ff;color:#1d4ed8;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:700}
.refresh-btn{margin-left:auto;padding:6px 14px;font-size:12px;font-weight:700;background:#f0f4f8;border:1px solid #dde1e7;border-radius:7px;cursor:pointer}
.refresh-btn:hover{background:#e2e8f0}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#5f6b7a;padding:9px 12px;border-bottom:1px solid #dde1e7;text-align:left;white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid #f1f5f9;vertical-align:top;max-width:400px;word-break:break-all}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafbff}
.json-cell{font-family:Consolas,monospace;font-size:11px;color:#374151;background:#f9fafb;padding:4px 7px;border-radius:5px;cursor:pointer;max-height:60px;overflow:hidden;white-space:pre-wrap;line-height:1.4}
.json-cell.expanded{max-height:none}
.del-btn{padding:4px 10px;font-size:12px;font-weight:700;background:#fff1f0;border:1px solid #fca5a5;border-radius:5px;color:#c62828;cursor:pointer;white-space:nowrap}
.del-btn:hover{background:#fee2e2}
.empty{text-align:center;padding:48px;color:#94a3b8;font-size:14px}
.msg{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:14px}
.msg.ok{background:#f0fdf4;border:1px solid #86efac;color:#1e8a3e}
.msg.err{background:#fff1f0;border:1px solid #fca5a5;color:#c62828}
</style>
</head>
<body>
<header class="hdr">
  <div style="font-size:22px">🗄</div>
  <h1>DB Admin</h1>
  <span>data/drafts.db (SQLite)</span>
  <a href="/" style="margin-left:auto;font-size:13px;color:#1a73e8;text-decoration:none;">← Builder로 돌아가기</a>
</header>

<div class="wrap">
  <div class="layout">
    <div class="sidebar">
      <h2>테이블</h2>
      <div id="tableList"><div style="color:#94a3b8;font-size:12px;padding:8px">로딩 중...</div></div>
    </div>
    <div class="main">
      <div id="msgBox" style="display:none"></div>
      <div id="tableContent"><div class="empty">왼쪽에서 테이블을 선택하세요</div></div>
    </div>
  </div>
</div>

<script>
let currentTable = null;

async function loadTables() {
  const r = await fetch('/api/db-admin/tables').then(r=>r.json());
  const el = document.getElementById('tableList');
  if (!r.success || !r.tables.length) {
    el.innerHTML = '<div style="color:#94a3b8;font-size:12px;padding:8px">테이블 없음</div>';
    return;
  }
  el.innerHTML = r.tables.map(t =>
    \`<button class="tbl-btn" id="tbtn_\${t.name}" onclick="loadRows('\${t.name}')">\${t.name}</button>\`
  ).join('');
}

async function loadRows(table) {
  currentTable = table;
  document.querySelectorAll('.tbl-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tbtn_' + table)?.classList.add('active');

  const content = document.getElementById('tableContent');
  content.innerHTML = '<div class="empty">로딩 중...</div>';

  const r = await fetch(\`/api/db-admin/rows/\${table}\`).then(r=>r.json());
  if (!r.success) { showMsg('err', r.error); return; }

  if (!r.rows.length) {
    content.innerHTML = \`
      <div class="main-hdr">
        <h2>\${table}</h2>
        <span class="badge">0행</span>
        <button class="refresh-btn" onclick="loadRows('\${table}')">새로고침</button>
      </div>
      <div class="empty">데이터가 없습니다</div>\`;
    return;
  }

  const cols = Object.keys(r.rows[0]);
  const isJson = col => col === 'payload' || col.endsWith('_json');

  content.innerHTML = \`
    <div class="main-hdr">
      <h2>\${table}</h2>
      <span class="badge">\${r.rows.length}행</span>
      <button class="refresh-btn" onclick="loadRows('\${table}')">새로고침</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>\${cols.map(c=>\`<th>\${c}</th>\`).join('')}<th></th></tr></thead>
        <tbody>
          \${r.rows.map(row => \`<tr>
            \${cols.map(c => {
              const v = row[c];
              if (isJson(c) && v) {
                let pretty = v;
                try { pretty = JSON.stringify(JSON.parse(v), null, 2); } catch {}
                return \`<td><div class="json-cell" onclick="this.classList.toggle('expanded')" title="클릭하여 펼치기">\${escHtml(pretty)}</div></td>\`;
              }
              return \`<td>\${escHtml(String(v ?? ''))}</td>\`;
            }).join('')}
            <td><button class="del-btn" onclick="deleteRow('\${table}', \${row.id})">삭제</button></td>
          </tr>\`).join('')}
        </tbody>
      </table>
    </div>\`;
}

async function deleteRow(table, id) {
  if (!confirm(\`[\${table}] id=\${id} 행을 삭제합니까?\`)) return;
  const r = await fetch(\`/api/db-admin/rows/\${table}/\${id}\`, { method: 'DELETE' }).then(r=>r.json());
  if (r.success) { showMsg('ok', \`삭제 완료 (id:\${id})\`); loadRows(table); }
  else showMsg('err', r.error || '삭제 실패');
}

function showMsg(type, text) {
  const el = document.getElementById('msgBox');
  el.className = 'msg ' + type;
  el.textContent = text;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

loadTables();
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║   Kissflow → ServiceNow Migration Server                 ║
║   http://localhost:${PORT}                                  ║
║                                                          ║
║   지원: HTML 단독 | HTML+JS+CSS 묶음 | ZIP 업로드         ║
╚══════════════════════════════════════════════════════════╝
`);
  });
}).catch(e => { console.error('DB 초기화 실패:', e); process.exit(1); });
