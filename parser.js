const cheerio = require('cheerio');

// ── Kissflow field icon → ServiceNow variable type ────────────────────────
const ICON_TO_SNOW = {
  'form-field-sequence-number': { type: '6', typeName: 'Single Line Text',  autoFill: true  },
  'form-field-text-area':       { type: '7', typeName: 'Multi Line Text',   autoFill: false },
  'form-field-number':          { type: '5', typeName: 'Integer',           autoFill: false },
  'form-field-date':            { type: '10', typeName: 'Date',             autoFill: false },
  'form-field-date-time':       { type: '9', typeName: 'Date/Time',         autoFill: false },
  'form-field-dropdown':        { type: '1', typeName: 'Select Box',        autoFill: false },
  'arrow-down-simple-minimized':{ type: '1', typeName: 'Select Box',        autoFill: false },
  'form-field-multiselect-dropdown':{ type: '21', typeName: 'List Collector', autoFill: false },
  'form-field-currency':        { type: '5', typeName: 'Integer',           autoFill: false },
  'form-field-user':            { type: '8', typeName: 'Reference',         autoFill: false, reference: 'sys_user' },
  'search':                     { type: '8', typeName: 'Reference',         autoFill: false, reference: 'sys_user' },
  'form-field-remote-lookup':   { type: '8', typeName: 'Reference',         autoFill: false, reference: 'sys_user' },
  'form-field-smart-attachment':{ type: '14', typeName: 'Attachment',       autoFill: false },
  'attach':                     { type: '14', typeName: 'Attachment',       autoFill: false },
  'form-field-aggregation':     { type: '6', typeName: 'Single Line Text',  autoFill: true  },
  'form-field-signature':       { type: '14', typeName: 'Attachment',       autoFill: false },
  'form-field-checklist':       { type: '3', typeName: 'Multiple Choice',   autoFill: false },
  'form-field-slider':          { type: '5', typeName: 'Integer',           autoFill: false },
  'formula':                    { type: '6', typeName: 'Single Line Text',  autoFill: true  },
};
const DEFAULT_SNOW = { type: '6', typeName: 'Single Line Text', autoFill: false };

// ── Korean → English snake_case dictionary ───────────────────────────────
const KO_EN_DICT = {
  // 경조사 도메인
  '경조구분': 'ceremony_type',
  '경조일': 'ceremony_date',
  '경조금액': 'ceremony_amount',
  '경조휴가': 'ceremony_leave',
  '경조물품': 'ceremony_gift',
  '경조': 'ceremony',
  '휴가시작일': 'leave_start_date',
  '휴가종료일': 'leave_end_date',
  '휴가일수': 'leave_days',
  '휴가시작': 'leave_start',
  '휴가종료': 'leave_end',
  '휴가': 'leave',
  '분할사용여부': 'split_usage',
  '분할사용': 'split_usage',
  '분할': 'split',
  '결혼': 'wedding',
  '출산': 'childbirth',
  '사망': 'death',
  '부고': 'obituary',
  '칠순': 'seventieth_birthday',
  '팔순': 'eightieth_birthday',
  '생일': 'birthday',
  '기념일': 'anniversary',

  // 신청자 정보
  '신청자': 'requester',
  '신청자명': 'requester_name',
  '신청자정보': 'requester_info',
  '신청일': 'request_date',
  '신청': 'request',
  '성명': 'full_name',
  '이름': 'name',
  '성': 'last_name',
  '이메일': 'email',

  // 조직 정보
  '부서': 'department',
  '팀': 'team',
  '직급': 'position',
  '직위': 'title',
  '사원번호': 'employee_number',
  '사번': 'employee_number',
  '회사': 'company',
  '조직': 'organization',
  '소속': 'affiliation',
  '법인': 'entity',
  '비용센터': 'cost_center',

  // 결재/승인
  '결재': 'approval',
  '승인': 'approve',
  '반려': 'reject',
  '팀장': 'manager',
  '부서장': 'department_head',
  '담당자': 'assignee',
  '검토': 'review',
  '확인': 'confirm',

  // 날짜/기간
  '시작일': 'start_date',
  '종료일': 'end_date',
  '기간': 'period',
  '날짜': 'date',
  '일자': 'date',
  '년도': 'year',
  '월': 'month',
  '일': 'day',

  // 일반 필드
  '제목': 'title',
  '내용': 'content',
  '설명': 'description',
  '사유': 'reason',
  '비고': 'note',
  '첨부': 'attachment',
  '첨부파일': 'attachment',
  '금액': 'amount',
  '수량': 'quantity',
  '번호': 'number',
  '코드': 'code',
  '유형': 'type',
  '종류': 'category',
  '구분': 'category',
  '상태': 'status',
  '여부': 'flag',
  '선택': 'selection',
  '기타': 'etc',
  '주소': 'address',
  '전화번호': 'phone',
  '연락처': 'contact',
  '메모': 'memo',
  '항목': 'item',
  '관계': 'relationship',
  '대리': 'proxy',
  '위임': 'delegation',
  '증빙': 'evidence',
  '계좌': 'account',
  '은행': 'bank',
  '예금주': 'account_holder',
};

// 한글이 포함된 문자열인지 확인
function hasKorean(str) {
  return /[\uAC00-\uD7A3]/.test(str);
}

// camelCase / PascalCase → snake_case 변환
function camelToSnake(str) {
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// 한글 문자열을 사전 기반으로 영문 snake_case로 변환
function koreanToSnakeCase(str) {
  if (!hasKorean(str)) {
    // 한글 없으면 camelCase → snake_case만 적용
    return camelToSnake(str) || str.toLowerCase().replace(/[^a-z0-9]/g, '_');
  }

  // 전체 문자열이 사전에 있으면 바로 반환
  if (KO_EN_DICT[str.trim()]) return KO_EN_DICT[str.trim()];

  // 사전 키를 길이 내림차순으로 정렬해서 긴 것부터 매칭 (부분 치환)
  let result = str;
  const sortedKeys = Object.keys(KO_EN_DICT).sort((a, b) => b.length - a.length);
  for (const ko of sortedKeys) {
    if (result.includes(ko)) {
      result = result.replace(new RegExp(ko, 'g'), '_' + KO_EN_DICT[ko] + '_');
    }
  }

  // 남은 한글 제거 후 정리
  result = result
    .replace(/[\uAC00-\uD7A3]+/g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  return result || 'field_' + Math.random().toString(36).slice(2, 6);
}

// ── Known system / internal fields to exclude from migration ──────────────
const SYSTEM_FIELD_PATTERNS = [
  /^processFlag$/i, /^cancelFlag$/i, /^cancelSuccess$/i,
  /^flow_id$/i, /^draftId$/i, /^companyOriginalId$/i,
  /^employeeId$/i, /^costcenterlookup$/i,
  /^deputy_lookUp$/i, /^deputy_manager_lookUp$/i,
  /^Process_Ncompleted$/i, /^ShareLink$/i, /^testuser$/i,
  /^check_jobposition/i,
];

// ── Condition inference rules (field A visible when field B = value) ───────
// These are derived from domain knowledge of the form structure
const CONDITION_RULES = [
  {
    fieldId: 'SelectOrg',
    condition: { field: 'ChangeOrganization', operator: 'is', value: 'Yes' },
    note: '조직 변경 시에만 표시'
  },
  {
    fieldId: 'ProxyRequestName',
    condition: { field: 'ProxyRequest', operator: 'is', value: 'Yes' },
    note: '대리 신청 시에만 표시'
  },
  {
    fieldId: 'wedding_time',
    condition: { field: 'RequestType', operator: 'contains', value: '결혼' },
    note: '결혼 신청 시에만 표시'
  },
  {
    fieldId: 'wedding_photo',
    condition: { field: 'RequestType', operator: 'contains', value: '결혼' },
    note: '결혼 신청 시에만 표시'
  },
  {
    fieldId: 'child_type',
    condition: { field: 'RequestType', operator: 'contains', value: '출산' },
    note: '출산 신청 시에만 표시'
  },
  {
    fieldId: 'child_num',
    condition: { field: 'RequestType', operator: 'contains', value: '출산' },
    note: '출산 신청 시에만 표시'
  },
  {
    fieldId: 'Classification',
    condition: { field: 'RequestType', operator: 'contains', value: '출산' },
    note: '출산 신청 시에만 표시'
  },
  {
    fieldId: 'Whether_to_use_split',
    condition: { field: 'RequestType', operator: 'contains', value: '출산' },
    note: '출산 신청 시에만 표시'
  },
  // Split usage sections (2nd, 3rd, 4th splits)
  {
    fieldId: 'Start_date_type_1',
    condition: { field: 'Whether_to_use_split', operator: 'is', value: 'Yes' },
    note: '1차 분할 시에만 표시'
  },
  {
    fieldId: 'End_date_type_1',
    condition: { field: 'Whether_to_use_split', operator: 'is', value: 'Yes' },
    note: '1차 분할 시에만 표시'
  },
  {
    fieldId: 'duplication_holiday_check1',
    condition: { field: 'Whether_to_use_split', operator: 'is', value: 'Yes' },
    note: '1차 분할 시에만 표시'
  },
  {
    fieldId: 'Whether_to_use_split_2',
    condition: { field: 'Whether_to_use_split', operator: 'is', value: 'Yes' },
    note: '1차 분할 선택 시 2차 분할 여부'
  },
];

// ── Condition extraction from minified JS ─────────────────────────────────
function extractConditionsFromJS(jsContent) {
  const conditions = [];

  // Pattern 1: Kissflow stores conditions in objects like:
  // {field_id:"RequestType",operator:"is",value:"결혼"} or similar
  const conditionPatterns = [
    // field visibility conditions
    /\{[^}]*?(?:fieldId|field_id|fieldID)['":\s]*['":]?\s*['"]([^'"]+)['"]\s*,\s*[^}]*?(?:value|val)['":\s]*['":]?\s*['"]([^'"]+)['"]/g,
    // show when / hide when patterns
    /(?:showWhen|hideWhen|visibleWhen|show_when|hide_when)\s*[=:]\s*\{[^}]*?['"]([^'"]+)['"]\s*,\s*[^}]*?['"]([^'"]+)['"]/g,
    // criteria / condition blocks with field references
    /criteria['"]\s*:\s*\[\s*\{[^}]*?['"]([A-Za-z_][A-Za-z0-9_]+)['"]\s*,\s*['"](.*?)['"]/g,
  ];

  for (const pattern of conditionPatterns) {
    let match;
    while ((match = pattern.exec(jsContent)) !== null) {
      const [, fieldRef, condValue] = match;
      // Filter: only include if looks like a field ID (not a CSS class etc.)
      if (fieldRef && /^[A-Z][a-zA-Z0-9_]+$/.test(fieldRef)) {
        conditions.push({ fieldRef, condValue, source: 'js' });
      }
    }
  }

  // Pattern 2: Look for conditional visibility markers in JS code
  // e.g., "condition":{"rules":[{"field":"TypeTarget","operator":"equal","value":"결혼"}]}
  const jsonCondPattern = /"condition"\s*:\s*\{[^}]{0,300}\}/g;
  let match;
  while ((match = jsonCondPattern.exec(jsContent)) !== null) {
    try {
      // Try to parse the JSON fragment
      const fragment = match[0].replace(/"condition"\s*:\s*/, '');
      const parsed = JSON.parse(fragment);
      if (parsed.rules) {
        conditions.push(...parsed.rules);
      }
    } catch {}
  }

  return conditions;
}

// ── CSS analysis: extract section groupings ───────────────────────────────
function analyzeCSSForGroups(cssContent) {
  const groups = [];
  // Look for layout hints like grid areas, column definitions
  const gridAreas = cssContent.match(/grid-template-areas\s*:\s*['"]([^'"]+)['"]/g) || [];
  return groups;
}

// ── Classify a field ──────────────────────────────────────────────────────
function classifyField(fieldId, label, isReadOnly, icon, jsConditions) {
  // 1. System field?
  if (SYSTEM_FIELD_PATTERNS.some(p => p.test(fieldId))) {
    return 'system';
  }

  // 2. Auto-fill / formula?
  const iconInfo = ICON_TO_SNOW[icon] || {};
  if (isReadOnly && iconInfo.autoFill !== false) {
    return 'auto_fill';
  }
  // Read-only single-line text = likely auto-filled from lookup
  if (isReadOnly && icon === 'unknown') {
    // Known auto-fill fields based on naming
    const autoFillNames = /^(Title|Name_of_target|Relationship|Place_|Account_Number|Bank$|Account_Holder|Phone_number|Entity_Name|RequesterName|Requesters_Email|Organization|check_jobposition)/i;
    if (autoFillNames.test(fieldId)) {
      return 'auto_fill';
    }
    return 'formula';
  }

  // 3. Has a condition rule (from JS or inferred)?
  const condRule = CONDITION_RULES.find(r => r.fieldId === fieldId);
  if (condRule) {
    return 'conditional';
  }

  // 4. Numbered duplicate field (split usage pattern)
  if (/_\d+$/.test(fieldId)) {
    const base = fieldId.replace(/_\d+$/, '');
    // If base field exists, this is a conditional repeat
    return 'conditional_repeat';
  }

  return 'user_input';
}

// ── Field category labels ─────────────────────────────────────────────────
const CATEGORY_META = {
  user_input:         { label: '사용자 입력',   migrate: true,  snowRecommendation: 'Variable (입력 필드)' },
  auto_fill:          { label: '자동 채움',     migrate: false, snowRecommendation: 'Variable (Read-only) 또는 제외' },
  formula:            { label: '수식/계산',     migrate: false, snowRecommendation: 'Calculated Field 또는 제외' },
  conditional:        { label: '조건부 표시',   migrate: true,  snowRecommendation: 'Variable + Client Script' },
  conditional_repeat: { label: '반복 조건부',   migrate: true,  snowRecommendation: 'Variable + Client Script (분할 사용)' },
  system:             { label: '시스템 내부',   migrate: false, snowRecommendation: '마이그레이션 불필요' },
};

// ── Main HTML parser ──────────────────────────────────────────────────────
function parseKissflowHTML(html, jsFiles = [], cssFiles = []) {
  const $ = cheerio.load(html);

  // Extract process name
  let processName = '경조사 신청';
  const processNameMatch = html.match(/"Name"\s*:\s*"([^"]{2,60})"/);
  if (processNameMatch) processName = processNameMatch[1];
  const titleEl = $('title').text();
  if (titleEl && titleEl.length > 2 && titleEl.length < 60) processName = titleEl;

  // Combine all JS content for condition analysis
  const combinedJS = jsFiles.map(f => f.content).join('\n');
  const jsConditions = combinedJS ? extractConditionsFromJS(combinedJS) : [];

  // Extract sections
  const sections = [];
  $('[data-component="editableinput"]').each((i, el) => {
    const text = $(el).text().trim();
    if (text && (text.startsWith('■') || text.startsWith('◆') || text.startsWith('●'))) {
      sections.push({ id: `section_${i}`, title: text, order: (i + 1) * 1000 });
    }
  });

  // Parse all field containers
  const fields = [];
  const fieldMap = {};

  $('[class*="fieldPreviewContainer"]').each((index, container) => {
    const $c = $(container);
    const fieldId = $c.attr('id');

    if (!fieldId || /^(CC-Column|Row_|EmptyCol)/.test(fieldId)) return;

    // Label
    const labelRaw = $c.find('[class*="fieldLabel"]').first().text().trim();
    const label = labelRaw || fieldId.replace(/_/g, ' ');

    // Hint / help text
    const hint = $c.find('[class*="fieldHint"]').first().text().trim();

    // Field type icon
    const icons = [];
    $c.find('[data-icon]').each((_, el) => icons.push($(el).attr('data-icon')));
    const primaryIcon = icons.find(ic => ICON_TO_SNOW[ic]) || icons[0] || 'unknown';

    // Read-only detection
    const isReadOnly = $c.find('[class*="readOnlyInput"]').length > 0
                    || primaryIcon === 'formula';

    // Snow type mapping
    const snowMeta = ICON_TO_SNOW[primaryIcon] || DEFAULT_SNOW;

    // Classification
    const category = classifyField(fieldId, label, isReadOnly, primaryIcon, jsConditions);
    const catMeta = CATEGORY_META[category];

    // Condition rule (if any)
    const condRule = CONDITION_RULES.find(r => r.fieldId === fieldId) || null;

    const field = {
      id: fieldId,
      name: koreanToSnakeCase(fieldId),
      nameAutoTranslated: hasKorean(fieldId),
      label,
      hint,
      kfIcon: primaryIcon,
      snowType: snowMeta.type,
      snowTypeName: snowMeta.typeName,
      reference: snowMeta.reference || null,
      readOnly: isReadOnly || snowMeta.autoFill || false,
      category,
      categoryLabel: catMeta.label,
      migrateByDefault: catMeta.migrate,
      snowRecommendation: catMeta.snowRecommendation,
      condition: condRule ? condRule.condition : null,
      conditionNote: condRule ? condRule.note : null,
      order: (index + 1) * 100,
    };

    fields.push(field);
    fieldMap[fieldId] = field;
  });

  // Statistics
  const stats = {
    total: fields.length,
    byCategory: {},
    migratable: fields.filter(f => f.migrateByDefault).length,
    conditional: fields.filter(f => ['conditional', 'conditional_repeat'].includes(f.category)).length,
  };
  for (const f of fields) {
    stats.byCategory[f.category] = (stats.byCategory[f.category] || 0) + 1;
  }

  // Build API requests for migratable fields
  const migratableFields = fields.filter(f => f.migrateByDefault);
  const apiRequests = buildAPIRequests(processName, migratableFields, sections);

  // Build Client Scripts for conditional fields
  const clientScripts = buildClientScripts(processName, fields);

  return {
    processName,
    fields,
    sections,
    stats,
    apiRequests,
    clientScripts,
    jsConditionsFound: jsConditions.length,
  };
}

// ── Build ServiceNow API request bodies ───────────────────────────────────
function buildAPIRequests(processName, fields, sections) {
  const catalogItem = {
    name: processName,
    short_description: `${processName} 신청`,
    description: `Migrated from Kissflow: ${processName}`,
    active: true,
    use_sc_layout: true,
    no_quantity: true,
  };

  const variables = [];
  let order = 100;

  // Section labels
  for (const section of sections) {
    variables.push({
      _info: `섹션 헤더: ${section.title}`,
      cat_item: '{CATALOG_ITEM_SYS_ID}',
      name: section.id,
      question_text: section.title,
      type: '24',
      order: String(order),
      active: true,
    });
    order += 100;
  }

  // Variables
  for (const field of fields) {
    const v = {
      _info: `${field.categoryLabel} | ${field.conditionNote || ''}`.trim().replace(/\|$/, '').trim(),
      cat_item: '{CATALOG_ITEM_SYS_ID}',
      name: field.name,
      question_text: field.label,
      type: field.snowType,
      order: String(order),
      active: true,
      mandatory: false,
    };
    if (field.readOnly) v.read_only = true;
    if (field.hint) v.help_text = field.hint;
    if (field.reference) v.reference = field.reference;
    if (field.condition) v._condition = field.condition;
    variables.push(v);
    order += 100;
  }

  const tasks = [
    { sc_cat_item: '{CATALOG_ITEM_SYS_ID}', name: '팀장 승인 (Manager Approval)', order: '100' },
    { sc_cat_item: '{CATALOG_ITEM_SYS_ID}', name: 'HR 검토 (HR Review)', order: '200' },
  ];

  return { catalogItem, variables, tasks };
}

// ── Build ServiceNow Client Scripts for conditions ─────────────────────────
function buildClientScripts(processName, fields) {
  const conditionalFields = fields.filter(f => f.condition);
  if (!conditionalFields.length) return [];

  // Group conditions by controlling field
  const controllerMap = {};
  for (const field of conditionalFields) {
    const ctrlField = field.condition.field;
    if (!controllerMap[ctrlField]) controllerMap[ctrlField] = [];
    controllerMap[ctrlField].push(field);
  }

  const scripts = [];

  for (const [ctrlFieldId, dependentFields] of Object.entries(controllerMap)) {
    const ctrlField = fields.find(f => f.id === ctrlFieldId);
    const ctrlName = ctrlField ? ctrlField.name : koreanToSnakeCase(ctrlFieldId);

    // Group by value
    const valueMap = {};
    for (const f of dependentFields) {
      const val = f.condition.value;
      if (!valueMap[val]) valueMap[val] = [];
      valueMap[val].push(f);
    }

    // Generate onChange script
    let scriptBody = `function onChange(control, oldValue, newValue, isLoading) {\n`;
    scriptBody += `  if (isLoading) return;\n\n`;
    scriptBody += `  var val = newValue;\n\n`;

    for (const [value, flds] of Object.entries(valueMap)) {
      const showNames = flds.map(f => `'${f.name}'`).join(', ');
      const hideNames = dependentFields
        .filter(f => !flds.includes(f))
        .map(f => `'${f.name}'`).join(', ');

      scriptBody += `  // ${value} 선택 시\n`;
      scriptBody += `  if (val === '${value}') {\n`;
      for (const f of flds) {
        scriptBody += `    g_form.setVisible('${f.name}', true);\n`;
      }
      const others = dependentFields.filter(f => !flds.includes(f));
      for (const f of others) {
        scriptBody += `    g_form.setVisible('${f.name}', false);\n`;
      }
      scriptBody += `  }\n`;
    }
    scriptBody += `}\n`;

    scripts.push({
      name: `OnChange_${ctrlName}`,
      type: 'onChange',
      applies_to: `sc_cat_item_option_mtom`,
      field_name: ctrlName,
      script: scriptBody,
      description: `${ctrlFieldId} 변경 시 조건부 필드 표시/숨김: ${dependentFields.map(f => f.id).join(', ')}`,
    });
  }

  // onLoad script to initialize visibility
  let onLoadScript = `function onLoad() {\n`;
  onLoadScript += `  // 초기 로드 시 조건부 필드 모두 숨김\n`;
  for (const field of conditionalFields) {
    onLoadScript += `  g_form.setVisible('${field.name}', false);\n`;
  }
  onLoadScript += `}\n`;

  scripts.unshift({
    name: 'onLoad_InitVisibility',
    type: 'onLoad',
    applies_to: 'sc_cat_item_option_mtom',
    script: onLoadScript,
    description: '초기 로드 시 조건부 필드 숨김 처리',
  });

  return scripts;
}

module.exports = { parseKissflowHTML };
