const axios = require('axios');

class ServiceNowClient {
  constructor(instance, username, password) {
    this.baseUrl = instance.includes('://')
      ? instance
      : `https://${instance}.service-now.com`;
    this.auth = Buffer.from(`${username}:${password}`).toString('base64');

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${this.auth}`,
      },
      timeout: 30000,
    });
  }

  async testConnection() {
    try {
      const r = await this.client.get('/api/now/table/sys_user?sysparm_limit=1');
      return { success: true, user: r.data.result?.[0]?.name || 'Connected' };
    } catch (e) {
      return { success: false, error: this.parseError(e) };
    }
  }

  async createRecord(table, data) {
    const response = await this.client.post(`/api/now/table/${table}`, data);
    return response.data.result;
  }

  async createClientScript(data) {
    return this.createRecord('catalog_script_client', {
      sys_class_name: 'catalog_script_client',
      ...data,
    });
  }

  // ── Full catalog creation ─────────────────────────────────────────────
  async createFullCatalog({ name, description, fields, sections, clientScripts, referenceMappings = {}, requesterMappings = {}, guideBlocks = [], conditionalNotices = {} }) {
    const logs = [];
    const created = { catalogItem: null, variables: [], choices: [], tasks: [], clientScripts: [] };

    const log = (type, msg) => {
      logs.push({ type, message: msg, time: new Date().toLocaleTimeString() });
    };

    try {
      // ── 1. Catalog Item ──────────────────────────────────────────────
      log('info', `📦 Catalog Item 생성: ${name}`);
      const catItem = await this.createRecord('sc_cat_item', {
        name,
        short_description: description || name,
        description: `Migrated from Kissflow: ${name}`,
        active: true,
        use_sc_layout: true,
        no_quantity: true,
      });
      created.catalogItem = catItem;
      const catId = catItem.sys_id;
      log('success', `✓ Catalog Item (sys_id: ${catId})`);

      // ── 2. Section labels ───────────────────────────────────────────
      let order = 100;
      for (const section of sections) {
        try {
            await this.createRecord('item_option_new', {
              cat_item: catId,
              name: section.id,
              question_text: section.title,
              type: '11',
              order: String(order),
              active: true,
            });
          log('success', `  섹션: ${section.title}`);
        } catch (e) {
          log('error', `  ✗ 섹션 ${section.title}: ${e.message}`);
        }
        order += 100;
      }

      // ── 3. Guide Blocks (안내문 텍스트) ─────────────────────────────────
      if (guideBlocks.length) {
        log('info', `📄 안내문 블록 생성 (${guideBlocks.length}개)`);
        for (const guide of guideBlocks) {
          try {
            await this.createRecord('item_option_new', {
              cat_item: catId,
              name: `guide_${guide.order}`,
              question_text: guide.html,
              type: '32',             // Rich Text Label
              order: String(guide.order),
              active: true,
            });
            log('success', `  ✓ 안내문 (order: ${guide.order})`);
          } catch (e) {
            log('error', `  ✗ 안내문 (order: ${guide.order}): ${e.message}`);
          }
        }
      }

      // ── 4. Variables ─────────────────────────────────────────────────
      log('info', `📝 Variables 생성 (${fields.length}개)`);
      const dropdownMap = {};
      // finalClientScripts를 여기서 미리 선언해서 조건부 안내 스크립트도 추가 가능하게
      const finalClientScripts = [...(clientScripts || [])];

      for (const field of fields) {
        try {
          const varData = {
            cat_item: catId,
            name: field.name,
            question_text: field.label,
            type: field.snowType,
            order: String(order),
            active: true,
            mandatory: false,
          };
          if (field.readOnly) varData.read_only = true;
          if (field.hint) varData.help_text = field.hint;

          // Reference 타입(8)은 반드시 유효한 테이블명이 있어야 함
          // 없으면 GlideRecord.setTableName empty 오류 발생
          if (field.snowType === '8') {
            const refTable = (referenceMappings[field.id] && referenceMappings[field.id].trim())
              || (field.reference && field.reference.trim())
              || 'sys_user';
            varData.reference = refTable;
          }

          const varResult = await this.createRecord('item_option_new', varData);
          created.variables.push({ field: field.id, sys_id: varResult.sys_id });

          const catLabel = field.conditionNote ? ` [${field.conditionNote}]` : '';
          log('success', `  ✓ ${field.label}${catLabel}`);

          // Track dropdowns for choices
          if (field.snowType === '1') {
            dropdownMap[field.id] = { sys_id: varResult.sys_id, field };
          }
        } catch (e) {
          log('error', `  ✗ ${field.id}: ${e.message}`);
        }
        order += 100;
      }

      // ── 4.5 Conditional Notice Variables ────────────────────────────────
      // conditionalNotices: { noticeFieldId: [ { triggerField, triggerValue, text } ] }
      // 각 안내문마다 읽기 전용 텍스트 Variable(type=6)을 생성하고,
      // onChange Client Script에서 트리거 조건에 따라 setVisible로 표시/숨김
      const noticeVarMap = {}; // { noticeFieldId_ruleIdx: varName }

      if (Object.keys(conditionalNotices).length > 0) {
        log('info', `💬 조건부 안내 텍스트 생성`);
        for (const [noticeFieldId, rules] of Object.entries(conditionalNotices)) {
          for (let i = 0; i < rules.length; i++) {
            const rule = rules[i];
            const varName = `notice_${noticeFieldId.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${i + 1}`.slice(0, 40);
            try {
              await this.createRecord('item_option_new', {
                cat_item: catId,
                name: varName,
                question_text: rule.text,
                type: '6',          // Single Line Text (read-only)
                read_only: true,
                active: true,
                order: String(order),
              });
              noticeVarMap[`${noticeFieldId}_${i}`] = { varName, rule };
              log('success', `  ✓ 안내 Variable: ${varName} (${rule.triggerField}="${rule.triggerValue}")`);
              order += 10;
            } catch (e) {
              log('error', `  ✗ 안내 Variable ${varName}: ${e.message}`);
            }
          }
        }

        // 안내 Variable 표시/숨김 onChange 스크립트 생성
        // 트리거 필드별로 그룹화
        const triggerMap = {}; // { triggerFieldId: [ { triggerValue, varName } ] }
        for (const [key, { varName, rule }] of Object.entries(noticeVarMap)) {
          if (!triggerMap[rule.triggerField]) triggerMap[rule.triggerField] = [];
          triggerMap[rule.triggerField].push({ triggerValue: rule.triggerValue, varName });
        }

        for (const [triggerFieldId, notices] of Object.entries(triggerMap)) {
          const triggerField = fields.find(f => f.id === triggerFieldId);
          const triggerName = triggerField ? triggerField.name : triggerFieldId.toLowerCase().replace(/[^a-z0-9]/g, '_');
          const allNoticeVarNames = notices.map(n => n.varName);

          // 값별로 그룹화
          const valueMap = {};
          for (const n of notices) {
            if (!valueMap[n.triggerValue]) valueMap[n.triggerValue] = [];
            valueMap[n.triggerValue].push(n.varName);
          }

          let scriptBody = `function onChange(control, oldValue, newValue, isLoading) {\n  if (isLoading) return;\n\n`;
          scriptBody += `  // 먼저 모든 안내문 숨김\n`;
          for (const vn of allNoticeVarNames) {
            scriptBody += `  g_form.setVisible('${vn}', false);\n`;
          }
          scriptBody += `\n`;
          for (const [val, varNames] of Object.entries(valueMap)) {
            scriptBody += `  if (newValue === '${val}') {\n`;
            for (const vn of varNames) {
              scriptBody += `    g_form.setVisible('${vn}', true);\n`;
            }
            scriptBody += `  }\n`;
          }
          scriptBody += `}\n`;

          const noticeScript = {
            name: `OnChange_Notice_${triggerName}`,
            type: 'onChange',
            applies_to: 'item',
            field_name: triggerName,
            script: scriptBody,
            description: `${triggerFieldId} 값 변경 시 조건부 안내 텍스트 표시`,
          };

          // 안내 onChange 스크립트를 finalClientScripts에 추가
          finalClientScripts.push(noticeScript);
          log('success', `  ✓ onChange 안내 스크립트: OnChange_Notice_${triggerName}`);
        }

        // onLoad에서 모든 안내 Variable 숨김 처리를 기존 onLoad에 추가
        const allNoticeVars = Object.values(noticeVarMap).map(v => v.varName);
        const onLoadIdx = finalClientScripts.findIndex(cs => cs.type === 'onLoad');
        const hideLines = allNoticeVars.map(vn => `  g_form.setVisible('${vn}', false);`).join('\n');
        if (onLoadIdx >= 0) {
          const existing = finalClientScripts[onLoadIdx];
          const existingBody = existing.script.replace(/^function\s+onLoad\s*\(\s*\)\s*\{/, '').replace(/\}\s*$/, '').trim();
          finalClientScripts[onLoadIdx] = {
            ...existing,
            script: `function onLoad() {\n${existingBody}\n\n  // 조건부 안내문 초기 숨김\n${hideLines}\n}`,
          };
        } else {
          finalClientScripts.unshift({
            name: 'onLoad_HideNotices',
            type: 'onLoad',
            applies_to: 'item',
            script: `function onLoad() {\n  // 조건부 안내문 초기 숨김\n${hideLines}\n}`,
            description: '조건부 안내 텍스트 초기 숨김',
          });
        }
      }

      // ── 5. Choice Options ─────────────────────────────────────────────
      for (const [fieldId, { sys_id, field }] of Object.entries(dropdownMap)) {
        if (!field.options?.length) continue;
        log('info', `  🔽 ${fieldId} 옵션 생성...`);
        for (let i = 0; i < field.options.length; i++) {
          const opt = field.options[i];
          try {
            await this.createRecord('question_choice', {
              question: sys_id,
              text: String(opt),
              value: String(opt).toLowerCase().replace(/[^a-z0-9]/g, '_'),
              order: String((i + 1) * 100),
            });
          } catch (e) {
            log('error', `    ✗ ${opt}: ${e.message}`);
          }
        }
        log('success', `    ✓ ${field.options.length}개 옵션`);
      }

      // ── 6. Catalog Tasks ──────────────────────────────────────────────
      const defaultTasks = [
        { name: '팀장 승인', short_description: '신청에 대한 팀장 승인', order: '100' },
        { name: 'HR 검토', short_description: 'HR 검토 및 처리', order: '200' },
      ];
      log('info', `📋 Catalog Tasks 생성`);
      for (const task of defaultTasks) {
        try {
          const t = await this.createRecord('sc_cat_item_delivery_task', {
            ...task,
            sc_cat_item: catId,
          });
          created.tasks.push({ name: task.name, sys_id: t.sys_id });
          log('success', `  ✓ ${task.name}`);
        } catch (e) {
          log('error', `  ✗ ${task.name}: ${e.message}`);
        }
      }

      // ── 7. Client Scripts ─────────────────────────────────────────────
      // requesterMappings가 있으면 g_user 기반 onLoad 스크립트 생성 후 기존 onLoad와 병합

      if (Object.keys(requesterMappings).length > 0) {
        // 신청자 정보 자동채움 스크립트 생성
        const fieldLines = Object.entries(requesterMappings)
          .map(([fieldId, sysUserCol]) => {
            const field = fields.find(f => f.id === fieldId);
            const fieldName = field ? field.name : fieldId.toLowerCase().replace(/[^a-z0-9]/g, '_');
            return `    g_form.setValue('${fieldName}', currentUser.${sysUserCol});`;
          })
          .join('\n');

        const requesterScript = `function onLoad() {\n  var gr = new GlideRecord('sys_user');\n  gr.get(g_user.userID);\n  var currentUser = gr;\n\n${fieldLines}\n}`;

        // 기존 onLoad 스크립트가 있으면 병합, 없으면 새로 추가
        const existingOnLoadIdx = finalClientScripts.findIndex(cs => cs.type === 'onLoad');
        if (existingOnLoadIdx >= 0) {
          const existing = finalClientScripts[existingOnLoadIdx];
          // 기존 onLoad 함수 바디와 신청자 채움 라인을 하나의 onLoad로 병합
          const existingBody = existing.script.replace(/^function\s+onLoad\s*\(\s*\)\s*\{/, '').replace(/\}\s*$/, '').trim();
          const requesterBody = `  var gr = new GlideRecord('sys_user');\n  gr.get(g_user.userID);\n  var currentUser = gr;\n\n${fieldLines}`;
          const merged = `function onLoad() {\n${existingBody}\n\n  // 신청자 정보 자동채움\n${requesterBody}\n}`;
          finalClientScripts[existingOnLoadIdx] = {
            ...existing,
            script: merged,
            description: existing.description + ' + 신청자 정보 자동채움',
          };
          log('info', `⚙ onLoad 병합: 조건부 숨김 + 신청자 정보 자동채움 (${Object.keys(requesterMappings).length}개 필드)`);
        } else {
          finalClientScripts.unshift({
            name: 'onLoad_RequesterInfo',
            type: 'onLoad',
            applies_to: 'item',
            script: requesterScript,
            description: `신청자 정보 자동채움: ${Object.keys(requesterMappings).join(', ')}`,
          });
          log('info', `⚙ onLoad 신청자 정보 자동채움 스크립트 추가 (${Object.keys(requesterMappings).length}개 필드)`);
        }
      }

      if (finalClientScripts.length) {
        log('info', `⚙ Client Scripts 생성 (${finalClientScripts.length}개)`);
        for (const cs of finalClientScripts) {
          try {
            const csResult = await this.createClientScript({
              name: cs.name,
              type: cs.type === 'onLoad' ? 'onLoad' : 'onChange',
              applies_to: 'item',
              cat_item: catId,
              script: cs.script,
              active: true,
              description: cs.description,
            });
            created.clientScripts.push({ name: cs.name, sys_id: csResult.sys_id });
            log('success', `  ✓ ${cs.name}`);
          } catch (e) {
            // Client scripts may not be available in all SNow versions
            log('error', `  ✗ ${cs.name}: ${e.message} (수동으로 추가하세요)`);
          }
        }
      }

      log('success', `🎉 완료! Variables: ${created.variables.length}, Tasks: ${created.tasks.length}`);

      return {
        success: true,
        catalogItemSysId: catId,
        catalogItemUrl: `${this.baseUrl}/nav_to.do?uri=sc_cat_item.do?sys_id=${catId}`,
        created,
        logs,
      };
    } catch (error) {
      log('error', `❌ 실패: ${error.message}`);
      return { success: false, error: error.message, created, logs };
    }
  }

  // ── Manual catalog creation (수동 빌더) ──────────────────────────────
  async createFromManual({ name, description, fields, guideBlocks = [], clientScripts = [] }) {
    const logs = [];
    const created = { catalogItem: null, variables: [], choices: [], clientScripts: [] };
    const log = (type, msg) => logs.push({ type, message: msg, time: new Date().toLocaleTimeString() });

    try {
      // 1. Catalog Item
      log('info', `Catalog Item 생성: ${name}`);
      const catItem = await this.createRecord('sc_cat_item', {
        name,
        short_description: description || name,
        description: description || name,
        active: true,
        use_sc_layout: true,
        no_quantity: true,
      });
      created.catalogItem = catItem;
      const catId = catItem.sys_id;
      log('success', `✓ Catalog Item (sys_id: ${catId})`);

      let order = 100;

      // 2 & 3. Fields + Guide Blocks — 배열 순서대로 처리 (label이 중간에 있어도 순서 유지)
      // fields 배열: { name, label, snowType, mandatory, readOnly, helpText,
      //   reference(table), dropdownType('fixed'|'table'), dropdownTable, options([]),
      //   isRequester(bool), requesterCol(sys_user column), _type('label'), html }
      const onLoadLines = [];   // 신청자 자동채움
      const dropdownVars = [];  // choice 생성 대상
      const currencyVars = [];  // 통화 포맷 검증 onChange 스크립트 생성 대상

      const allItems = [...fields, ...guideBlocks.filter(g =>
        !fields.some(f => f._type === 'label' && f.name === g.name)
      )];

      log('info', `Variables/안내문 생성 (${fields.length}개)`);
      for (const field of fields) {
        // 섹션 구분선 (type=11 Label)
        if (field._type === 'section') {
          try {
            await this.createRecord('item_option_new', {
              cat_item: catId,
              name: field.name || `section_${order}`,
              question_text: field.label || '',
              type: '11',
              order: String(order),
              active: true,
            });
            log('success', `  ✓ 섹션: ${field.label || field.name}`);
          } catch (e) {
            log('error', `  ✗ 섹션: ${e.message}`);
          }
          order += 100;
          continue;
        }

        // 안내문 블록 (label) — type 32(Rich Text Label), question_text에 HTML 내용 삽입
        if (field._type === 'label') {
          try {
            await this.createRecord('item_option_new', {
              cat_item: catId,
              name: field.name || `guide_${order}`,
              question_text: field.html || '',
              type: '32',
              order: String(order),
              active: true,
            });
            log('success', `  ✓ 안내문 블록 (order: ${order})`);
          } catch (e) {
            log('error', `  ✗ 안내문: ${e.message}`);
          }
          order += 100;
          continue;
        }

        try {
          const varData = {
            cat_item: catId,
            name: field.name,
            question_text: field.label || field.name,
            type: field.snowType,
            order: String(order),
            active: true,
            mandatory: field.mandatory ? true : false,
          };
          if (field.readOnly) varData.read_only = true;
          if (field.helpText) varData.help_text = field.helpText;

          // Reference (type=8) — reference 테이블명 반드시 설정 (없으면 GlideRecord.setTableName 오류)
          if (field.snowType === '8' || field._fieldType === 'reference') {
            varData.type = '8';
            varData.reference = (field.reference || '').trim() || 'sys_user';
            if (field.refQual) {
              varData.reference_qual = field.refQual;
            }
          }

          // Macro (type=15 UI Page) — UI Macro 이름으로 sys_ui_macro sys_id 조회 후 연결
          if (field._fieldType === 'macro' || field.macroName) {
            varData.type = '15';
            if (field.macroName) {
              try {
                const macroRes = await this.request('GET', `/api/now/table/sys_ui_macro?sysparm_query=name=${encodeURIComponent(field.macroName)}&sysparm_limit=1&sysparm_fields=sys_id,name`);
                const macroRecord = macroRes?.result?.[0];
                if (macroRecord) {
                  varData.macro = macroRecord.sys_id;
                  log('success', `  → UI Macro 연결: ${field.macroName} (${macroRecord.sys_id})`);
                } else {
                  log('warn', `  ⚠ UI Macro '${field.macroName}' 를 찾지 못했습니다. macro 필드를 수동으로 연결하세요.`);
                }
              } catch (e) {
                log('warn', `  ⚠ UI Macro 조회 실패: ${e.message}`);
              }
            }
          }

          // Dropdown 기본값 (Select Box=5, List Collector=21)
          if ((field.snowType === '5' || field.snowType === '21') && field.ddDefault) {
            varData.default_value = field.ddDefault;
          }

          // Boolean/Yes/No (type=1) default value
          if (field.snowType === '1' && field.boolDefault === 'true') {
            varData.default_value = 'true';
          }

          // Currency: type=6(text), 레이블에 통화 기호 표시
          const CURRENCY_SYMBOLS = { KRW: '₩', USD: '$', EUR: '€', JPY: '¥', GBP: '£', CNY: '¥' };
          if (field.currencyCode) {
            const sym = CURRENCY_SYMBOLS[field.currencyCode] || field.currencyCode;
            varData.question_text = `${field.label || field.name} (${field.currencyCode} ${sym})`;
            if (!varData.help_text) {
              varData.help_text = `숫자만 입력하세요 (예: 60000). 통화: ${field.currencyCode} ${sym}`;
            }
          }

          // Dropdown from table (Lookup Select Box=18)
          if (field.snowType === '5' && field.dropdownType === 'table' && field.dropdownTable) {
            varData.type = '18';
            varData.lookup_table = field.dropdownTable;
            varData.lookup_value = field.dropdownDisplayField || 'name';
          }

          const varResult = await this.createRecord('item_option_new', varData);
          created.variables.push({ name: field.name, sys_id: varResult.sys_id });
          log('success', `  ✓ ${field.label || field.name}`);

          // fixed dropdown choices 대상 수집 (Select Box=5)
          if (field.snowType === '5' && field.dropdownType !== 'table' && field.options?.length) {
            dropdownVars.push({ sys_id: varResult.sys_id, options: field.options });
          }

          // 통화 포맷 검증 대상 수집
          if (field.currencyCode) {
            currencyVars.push({ name: field.name, currencyCode: field.currencyCode });
          }

          // 신청자 자동채움 대상 수집
          if (field.isRequester && field.requesterCol) {
            onLoadLines.push(`  g_form.setValue('${field.name}', currentUser.getValue('${field.requesterCol}'));`);
          }

          // 기본 숨김 필드
          if (field.hidden) {
            onLoadLines.push(`  g_form.setVisible('${field.name}', false);`);
          }

        } catch (e) {
          log('error', `  ✗ ${field.name}: ${e.message}`);
        }
        order += 100;
      }

      // 4. Dropdown choices (fixed)
      for (const { sys_id, options } of dropdownVars) {
        for (let i = 0; i < options.length; i++) {
          const opt = options[i];
          try {
            await this.createRecord('question_choice', {
              question: sys_id,
              text: String(opt.label || opt),
              value: String(opt.value || opt).toLowerCase().replace(/[^a-z0-9]/g, '_'),
              order: String((i + 1) * 100),
            });
          } catch (e) {
            log('error', `    ✗ 옵션 ${opt}: ${e.message}`);
          }
        }
        log('success', `    ✓ ${options.length}개 옵션`);
      }

      // 5. onLoad Client Script (신청자 자동채움 + 기본 숨김 필드)
      if (onLoadLines.length > 0) {
        const hasRequester = onLoadLines.some(l => l.includes('setValue'));
        const scriptLines = ['function onLoad() {'];
        if (hasRequester) {
          scriptLines.push(
            '  var gr = new GlideRecord(\'sys_user\');',
            '  gr.get(g_user.userID);',
            '  var currentUser = gr;',
            '',
          );
        }
        scriptLines.push(...onLoadLines, '}');
        const script = scriptLines.join('\n');

        try {
          const cs = await this.createClientScript({
            name: 'onLoad_RequesterAutoFill',
            type: 'onLoad',
            cat_item: catId,
            script,
            active: true,
          });
          created.clientScripts.push({ name: 'onLoad_RequesterAutoFill', sys_id: cs.sys_id });
          log('success', `✓ onLoad Client Script (신청자 자동채움 ${onLoadLines.length}개 필드)`);
        } catch (e) {
          const detail = e.response?.data ? JSON.stringify(e.response.data) : '';
          log('error', `✗ onLoad Script: ${e.message} ${detail} (수동으로 추가하세요)`);
        }
      }

      // 6. onChange Client Scripts (per trigger field)
      const onchangeScripts = new Map();
      for (const field of fields) {
        if (!field.onchangeRules?.length) continue;
        onchangeScripts.set(field.name, { fieldName: field.name, rules: field.onchangeRules });
      }

      for (const [triggerName, { rules }] of onchangeScripts) {
        const lines = [
          `function onChange(control, oldValue, newValue, isLoading) {`,
          `  if (isLoading) return;`,
          ``,
        ];

        for (const rule of rules) {
          const condVal = String(rule.triggerValue || '').replace(/'/g, "\\'");
          lines.push(`  if (newValue == '${condVal}') {`);
          for (const act of rule.actions) {
            const target = act.target;
            if (!target) continue;

            if (act.visibility === 'show') {
              lines.push(`    g_form.setVisible('${target}', true);`);
            } else if (act.visibility === 'hide') {
              lines.push(`    g_form.setVisible('${target}', false);`);
            }
            if (act.value !== '' && act.value !== undefined && act.value !== null) {
              const val = String(act.value).replace(/'/g, "\\'");
              lines.push(`    g_form.setValue('${target}', '${val}');`);
            }
            if (act.mandatory === 'set') {
              lines.push(`    g_form.setMandatory('${target}', true);`);
            } else if (act.mandatory === 'unset') {
              lines.push(`    g_form.setMandatory('${target}', false);`);
            }
            // 이전 버전 호환
            if (act.actionType === 'setValue') {
              lines.push(`    g_form.setValue('${target}', '${String(act.value ?? '').replace(/'/g, "\\'")}');`);
            } else if (act.actionType === 'setVisibility') {
              lines.push(`    g_form.setVisible('${target}', ${act.subOption !== 'hide'});`);
            } else if (act.actionType === 'setMandatory') {
              lines.push(`    g_form.setMandatory('${target}', ${act.subOption !== 'unset'});`);
            } else if (act.actionType === 'setVisible') {
              lines.push(`    g_form.setVisible('${target}', true);`);
            } else if (act.actionType === 'setHidden') {
              lines.push(`    g_form.setVisible('${target}', false);`);
            } else if (act.actionType === 'setNotMandatory') {
              lines.push(`    g_form.setMandatory('${target}', false);`);
            }
          }
          lines.push(`  }`);
        }
        lines.push(`}`);

        const script = lines.join('\n');
        const scriptName = `onChange_${triggerName}`;

        // triggerName에 해당하는 variable sys_id 찾기
        const triggerVar = created.variables.find(v => v.name === triggerName);

        try {
          const csData = {
            name: scriptName,
            type: 'onChange',
            cat_item: catId,
            variable_name: triggerName,
            script,
            active: true,
          };
          if (triggerVar) csData.cat_variable = triggerVar.sys_id;

          const cs = await this.createClientScript(csData);
          created.clientScripts.push({ name: scriptName, sys_id: cs.sys_id });
          log('success', `✓ onChange Script: ${scriptName} (${rules.length}개 조건)`);
        } catch (e) {
          const detail = e.response?.data ? JSON.stringify(e.response.data) : '';
          log('error', `✗ onChange Script ${scriptName}: ${e.message} ${detail}`);
        }
      }

      // 7. Currency 포맷 검증 onChange Client Scripts
      for (const { name, currencyCode } of currencyVars) {
        const CURRENCY_SYMBOLS = { KRW: '₩', USD: '$', EUR: '€', JPY: '¥', GBP: '£', CNY: '¥' };
        const sym = CURRENCY_SYMBOLS[currencyCode] || currencyCode;
        const isDecimal = !['KRW', 'JPY'].includes(currencyCode);
        const formatDesc = isDecimal
          ? `숫자와 소수점만 입력 가능합니다 (예: 1234.56)`
          : `숫자만 입력 가능합니다 (예: 60000)`;

        const script = [
          `function onChange(control, oldValue, newValue, isLoading) {`,
          `  if (isLoading || newValue === '' || newValue === null) return;`,
          `  var pattern = ${isDecimal ? '/^\\d+(\\.\\d{1,2})?$/' : '/^\\d+$/'};`,
          `  if (!pattern.test(newValue)) {`,
          `    g_form.showFieldMsg('${name}', '${formatDesc} [통화: ${currencyCode} ${sym}]', 'error');`,
          `    g_form.setValue('${name}', oldValue);`,
          `  } else {`,
          `    g_form.hideFieldMsg('${name}');`,
          `  }`,
          `}`,
        ].join('\n');

        const scriptName = `onChange_currency_${name}`;
        try {
          const cs = await this.createClientScript({
            name: scriptName,
            type: 'onChange',
            cat_item: catId,
            variable_name: name,
            script,
            active: true,
          });
          created.clientScripts.push({ name: scriptName, sys_id: cs.sys_id });
          log('success', `✓ 통화 검증 Script: ${scriptName} (${currencyCode} ${sym})`);
        } catch (e) {
          const detail = e.response?.data ? JSON.stringify(e.response.data) : '';
          log('error', `✗ 통화 검증 Script ${scriptName}: ${e.message} ${detail}`);
        }
      }

      log('success', `완료! Variables: ${created.variables.length}`);

      // 8. 직접 입력 Client Scripts
      if (clientScripts?.length) {
        log('info', `\n[8] Client Script 직접 추가 (${clientScripts.length}개)`);
        for (const cs of clientScripts) {
          if (!cs.script) continue;

          const fieldsToApply = (cs.type === 'onChange' && cs.fields?.length)
            ? cs.fields
            : [null];

          for (const applyField of fieldsToApply) {
            const suffix = applyField ? `_${applyField}` : '';
            const csData = {
              name: `${cs.name || `customScript_${Date.now()}`}${suffix}`,
              type: cs.type || 'onLoad',
              cat_item: catId,
              script: cs.script,
              active: true,
            };
            if (cs.type === 'onChange' && applyField) {
              csData.variable_name = applyField;
              const applyVar = created.variables.find(v => v.name === applyField);
              if (applyVar) csData.cat_variable = applyVar.sys_id;
            }
            try {
              const result = await this.createClientScript(csData);
              created.clientScripts.push({ name: csData.name, sys_id: result.sys_id });
              log('success', `✓ ${csData.name} (${cs.type}${applyField ? ` → ${applyField}` : ''})`);
            } catch (e) {
              const detail = e.response?.data ? JSON.stringify(e.response.data) : '';
              log('error', `✗ ${csData.name}: ${e.message} ${detail}`);
            }
          }
        }
      }

      return {
        success: true,
        catalogItemSysId: catId,
        catalogItemUrl: `${this.baseUrl}/nav_to.do?uri=sc_cat_item.do?sys_id=${catId}`,
        created,
        logs,
      };
    } catch (error) {
      log('error', `실패: ${error.message}`);
      return { success: false, error: error.message, created, logs };
    }
  }

  parseError(error) {    if (error.response) {
      const d = error.response.data;
      return d?.error?.message || `HTTP ${error.response.status}: ${error.response.statusText}`;
    }
    if (error.code === 'ENOTFOUND') return 'Instance URL을 찾을 수 없습니다';
    if (error.code === 'ETIMEDOUT') return '연결 시간 초과';
    return error.message;
  }
}

module.exports = { ServiceNowClient };
