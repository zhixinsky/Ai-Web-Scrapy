import XLSX from 'xlsx';
import XlsxPopulate from 'xlsx-populate';

/**
 * @param {*} workbook
 * @returns {Promise<Buffer>}
 */
async function workbookToBuffer(workbook) {
  const buf = await workbook.outputAsync({ type: 'nodebuffer' });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

/**
 * 裁剪 strict 列数右侧的单元格内容（与旧 SheetJS deleteCellsBeyondColumn 对齐；xlsx-populate 保留样式）。
 * @param {*} xpSheet
 * @param {number} strictN 保留列数（1-based 最大列为 strictN）
 * @param {number} templateMaxCol0 模板最大列 0-based
 * @param {number} trimEndRow1Based 清除到的最后一行（含表头）
 */
function trimColumnsBeyondStrictXp(xpSheet, strictN, templateMaxCol0, trimEndRow1Based) {
  const strictMax0 = strictN - 1;
  if (templateMaxCol0 <= strictMax0 || trimEndRow1Based < 1) return;
  const startCol = strictMax0 + 2;
  const endCol = templateMaxCol0 + 1;
  xpSheet.range(1, startCol, trimEndRow1Based, endCol).clear();
}

/**
 * 由单行表头文案生成仅含表头一行的 xlsx（用于内置写死模板，无需上传文件）。
 * @param {string[]} headerCells
 * @returns {Buffer}
 */
export function xlsxBufferFromSingleHeaderRow(headerCells) {
  const row = Array.isArray(headerCells) ? headerCells.map((c) => String(c ?? '')) : [];
  if (!row.length) {
    throw new Error('内置表头为空');
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([row]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/**
 * 无 builtinHeaderRow、无上传文件时，用列映射生成仅含表头行的最小 xlsx（前若干行为空，表头在 `headerRow`）。
 * 支持：① 每条映射均有 excelHeader/header/headers 之一且无 col；② 每条均有 col（≥0），表头格用首候选文案或 field。
 * 同时含 col 与纯表头文案定位的映射返回 null（须自备模板）。
 * @param {{ headerRow?: number, sheetName?: string, builtinHeaderRow?: string[], columns?: Record<string, unknown>[] }} mapCfg
 * @returns {Buffer | null}
 */
export function xlsxBufferFromColumnMapSyntheticHeader(mapCfg) {
  if (!mapCfg || typeof mapCfg !== 'object') return null;
  if (Array.isArray(mapCfg.builtinHeaderRow) && mapCfg.builtinHeaderRow.length > 0) return null;

  const columns = Array.isArray(mapCfg.columns) ? mapCfg.columns : [];
  const headerRow1 = Math.max(1, Number(mapCfg.headerRow) || 1);
  const sheetName = String(mapCfg.sheetName ?? '').trim() || 'Sheet1';

  /** @param {Record<string, unknown>} entry */
  function firstHeaderLabel(entry) {
    if (Array.isArray(entry.headers) && entry.headers.length) {
      const x = String(entry.headers[0] ?? '').trim();
      if (x) return x;
    }
    const ex = String(entry.excelHeader ?? '').trim();
    if (ex) return ex;
    return String(entry.header ?? '').trim();
  }

  let anyCol = false;
  let anyHeaderOnly = false;
  const entries = [];
  for (const e of columns) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const o = /** @type {Record<string, unknown>} */ (e);
    const field = String(o.field ?? '').trim();
    if (!field) continue;
    const colNum = Number(o.col);
    const hasCol = Number.isFinite(colNum) && colNum >= 0;
    const lab = firstHeaderLabel(o);
    if (hasCol) anyCol = true;
    if (!hasCol && lab) anyHeaderOnly = true;
    if (!hasCol && !lab) return null;
    entries.push({ o, field, hasCol, colNum: hasCol ? colNum : null, lab });
  }
  if (!entries.length) return null;
  if (anyCol && anyHeaderOnly) return null;

  /** @type {string[]} */
  let headerCells;
  if (anyCol) {
    let maxC = -1;
    for (const e of entries) {
      if (e.colNum != null) maxC = Math.max(maxC, e.colNum);
    }
    headerCells = Array(maxC + 1).fill('');
    for (const e of entries) {
      if (e.colNum == null) return null;
      const text = e.lab || e.field;
      headerCells[e.colNum] = text;
    }
  } else {
    headerCells = entries.map((e) => e.lab);
  }

  const aoa = [];
  for (let r = 1; r < headerRow1; r++) {
    aoa.push([]);
  }
  aoa.push(headerCells);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/**
 * @param {import('xlsx').WorkSheet} ws
 * @param {number} r0 0-based row
 * @param {number} c0 0-based col
 * @returns {string}
 */
function cellText(ws, r0, c0) {
  const addr = XLSX.utils.encode_cell({ r: r0, c: c0 });
  const cell = ws[addr];
  if (!cell) return '';
  if (cell.w != null) return String(cell.w);
  if (cell.v == null) return '';
  if (cell.t === 'n' && Number.isFinite(cell.v)) return String(cell.v);
  return String(cell.v);
}

/**
 * 合并区域内仅左上角单元格在 xlsx 里存值；表头行常见横向合并，需从 master 读文案。
 * @param {import('xlsx').WorkSheet} ws
 * @param {number} r0
 * @param {number} c0
 * @returns {{ r: number, c: number }}
 */
function mergeTopLeftForCell(ws, r0, c0) {
  const merges = ws['!merges'];
  if (!Array.isArray(merges)) return { r: r0, c: c0 };
  for (const m of merges) {
    if (!m || typeof m.s?.r !== 'number' || typeof m.s?.c !== 'number') continue;
    if (typeof m.e?.r !== 'number' || typeof m.e?.c !== 'number') continue;
    const sr = m.s.r;
    const sc = m.s.c;
    const er = m.e.r;
    const ec = m.e.c;
    if (r0 >= sr && r0 <= er && c0 >= sc && c0 <= ec) return { r: sr, c: sc };
  }
  return { r: r0, c: c0 };
}

/** 表头匹配用：含合并单元格解析 */
function cellTextForHeader(ws, r0, c0) {
  const { r, c } = mergeTopLeftForCell(ws, r0, c0);
  return cellText(ws, r, c);
}

function normalizeHeaderText(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/**
 * @param {import('xlsx').WorkSheet} ws
 * @returns {number}
 */
function sheetMaxCol0(ws) {
  const ref = ws['!ref'];
  if (!ref) return 255;
  try {
    return Math.max(0, XLSX.utils.decode_range(ref).e.c);
  } catch {
    return 255;
  }
}

/**
 * 在表头行（1-based）中按单元格文字精确匹配（去首尾空白、合并连续空白）找列下标。
 * 优先用 `sheet_to_json` 读取该行（利于共享字符串等）；空格列再回退到合并解析 + 逐格读取。
 * 列扫描至少到第 512 列（宽表）。
 * @param {import('xlsx').WorkSheet} ws
 * @param {number} headerRow1 Excel 行号，从 1 起
 * @param {string} headerLabel 与表头单元格一致的文字
 * @returns {number | null} 0-based 列下标
 */
export function resolveColumnIndexByHeader(ws, headerRow1, headerLabel) {
  const want = normalizeHeaderText(headerLabel);
  if (!want) return null;
  const r0 = Math.max(0, headerRow1 - 1);
  const rows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: '',
    raw: false,
    blankrows: true,
  });
  const rowArr = Array.isArray(rows[r0]) ? /** @type {unknown[]} */ (rows[r0]) : [];
  const maxC = Math.max(rowArr.length ? rowArr.length - 1 : 0, sheetMaxCol0(ws), 511);
  for (let c = 0; c <= maxC; c++) {
    let piece = '';
    if (c < rowArr.length) {
      const v = rowArr[c];
      piece = v == null || v === '' ? cellTextForHeader(ws, r0, c) : String(v);
    } else {
      piece = cellTextForHeader(ws, r0, c);
    }
    const got = normalizeHeaderText(piece);
    if (got === want) return c;
  }
  return null;
}

/**
 * 按候选列表依次在表头行中匹配（用于模板为英文表头、或多语言多套模板）。
 * @param {import('xlsx').WorkSheet} ws
 * @param {number} headerRow1
 * @param {string[]} candidates
 * @returns {number | null}
 */
export function resolveColumnIndexByHeaderCandidates(ws, headerRow1, candidates) {
  for (const label of candidates) {
    const c = resolveColumnIndexByHeader(ws, headerRow1, label);
    if (c != null) return c;
  }
  return null;
}

/**
 * 从配置项收集「模板里可能出现的表头文案」（与程序 field 分离，用于映射）。
 * @param {Record<string, unknown>} entry
 * @returns {string[]}
 */
function templateHeaderCandidates(entry) {
  if (Array.isArray(entry?.headers)) {
    const list = entry.headers.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (list.length) return list;
  }
  const ex = String(entry?.excelHeader ?? '').trim();
  const hd = String(entry?.header ?? '').trim();
  const out = [];
  if (ex) out.push(ex);
  if (hd && hd !== ex) out.push(hd);
  return out;
}

/**
 * @param {import('xlsx').WorkSheet} ws
 * @param {Record<string, unknown>[]} columns
 * @param {number} headerRow1
 * @returns {{ col: number, field: string }[]}
 */
function resolveColumnsForSheetTry(ws, columns, headerRow1) {
  try {
    return resolveColumnsForSheet(ws, columns, headerRow1);
  } catch {
    return null;
  }
}

function resolveColumnsForSheet(ws, columns, headerRow1) {
  const out = [];
  for (const entry of columns) {
    const field = String(entry?.field ?? '').trim();
    if (!field) continue;
    const colNum = Number(entry?.col);
    if (Number.isFinite(colNum) && colNum >= 0) {
      out.push({ col: colNum, field });
      continue;
    }
    const candidates = templateHeaderCandidates(entry);
    if (candidates.length) {
      const c = resolveColumnIndexByHeaderCandidates(ws, headerRow1, candidates);
      if (c == null) {
        const tried = candidates.map((s) => `「${s}」`).join('、');
        throw new Error(
          `模板表头未匹配：在第 ${headerRow1} 行未找到与以下任一文案完全一致的列：${tried}（映射到程序字段「${field}」）。请核对模板表头文案是否与列映射一致（header / excelHeader / headers）。`
        );
      }
      out.push({ col: c, field });
    }
  }
  return out;
}

/**
 * 无列映射时仅按 strictHeaderColumnCount 保留表头（不写 rowObjects 字段）。
 * @param {{
 *   templateBuffer: Buffer,
 *   list: Record<string, unknown>[],
 *   dataStartRow: number,
 *   headerRow: number,
 *   strictN: number,
 *   sheetNameOpt?: string,
 * }} p
 */
async function fillXlsxTemplateBuiltinHeaderOnly(p) {
  const { templateBuffer, list, dataStartRow, headerRow, strictN, sheetNameOpt } = p;
  const wb = XLSX.read(templateBuffer, { type: 'buffer' });
  const names = wb.SheetNames || [];
  if (!names.length) throw new Error('模板中无工作表');
  const explicit = String(sheetNameOpt ?? '').trim();
  const sheetName =
    explicit && names.includes(explicit) ? explicit : names[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`工作表「${sheetName}」无效`);

  let templateMaxCol = 0;
  if (ws['!ref']) {
    try {
      templateMaxCol = Math.max(0, XLSX.utils.decode_range(ws['!ref']).e.c);
    } catch {
      templateMaxCol = 0;
    }
  }

  const strictMax0 = strictN - 1;
  if (templateMaxCol + 1 < strictN) {
    throw new Error(
      `模板列数(${templateMaxCol + 1})少于内置表头列数(${strictN})，请检查 xlsx 与 txt 是否一致`
    );
  }

  const xpWb = await XlsxPopulate.fromDataAsync(templateBuffer);
  const xpSheet = xpWb.sheet(sheetName);
  if (!xpSheet) throw new Error(`工作表「${sheetName}」无效`);

  const startR = dataStartRow - 1;
  const lastDataR = startR + Math.max(0, list.length) - 1;
  const lastR = Math.max(headerRow - 1, Math.max(startR - 1, lastDataR));
  const lastRow1Based = lastR + 1;

  const ur = xpSheet.usedRange();
  const trimEndRow = ur ? Math.max(lastRow1Based, ur.endCell().rowNumber()) : lastRow1Based;
  if (templateMaxCol > strictMax0) {
    trimColumnsBeyondStrictXp(xpSheet, strictN, templateMaxCol, trimEndRow);
  }

  return workbookToBuffer(xpWb);
}

/**
 * @param {import('xlsx').WorkBook} wb
 * @param {Record<string, unknown>[]} rawColumns
 * @param {number} headerRow1
 * @param {string} [sheetNameOpt] 指定工作表名；不指定时依次尝试各表直至表头全部匹配。
 * @returns {{ ws: import('xlsx').WorkSheet, sheetName: string, columns: { col: number, field: string }[] }}
 */
function pickWorksheetAndColumns(wb, rawColumns, headerRow1, sheetNameOpt) {
  const names = wb.SheetNames || [];
  if (!names.length) throw new Error('模板中无工作表');
  const explicit = String(sheetNameOpt ?? '').trim();
  if (explicit) {
    if (!names.includes(explicit)) {
      throw new Error(`模板中未找到工作表「${explicit}」。当前工作表：${names.join('、')}`);
    }
    const ws = wb.Sheets[explicit];
    if (!ws) throw new Error(`工作表「${explicit}」无效`);
    const columns = resolveColumnsForSheet(ws, rawColumns, headerRow1);
    return { ws, sheetName: explicit, columns };
  }
  const snippets = [];
  for (const name of names) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const columns = resolveColumnsForSheetTry(ws, rawColumns, headerRow1);
    if (columns?.length) return { ws, sheetName: name, columns };
    const tryRow = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: true })[
      headerRow1 - 1
    ];
    const preview = Array.isArray(tryRow)
      ? tryRow
          .slice(0, 12)
          .map((x) => normalizeHeaderText(String(x ?? '')) || '（空）')
          .join(' | ')
      : '（无该行）';
    snippets.push(`「${name}」第 ${headerRow1} 行前若干格：${preview}`);
  }
  const tail = snippets.length ? `\n${snippets.slice(0, 6).join('\n')}` : '';
  throw new Error(
    `所有工作表均未完成表头匹配。请核对第 ${headerRow1} 行是否与配置完全一致（含隐藏空格），或在草稿中设置 sheetName 指向含表头的工作表。${tail}`
  );
}

/**
 * 将平台数据行写入自定义 xlsx 模板。
 * - **按列号**：`{ col: 0, field: '标题' }`（0=A 列）
 * - **按模板表头 → 程序字段（映射）**：模板里是英文、程序里是中文键时，用下面任一写法（三选一，勿混用同一语义重复）：
 *   - `{ excelHeader: 'Product Title', field: '标题' }` — `excelHeader` 与 `header` 等价，表示 **Excel 单元格里写的表头文字**。
 *   - `{ header: 'Product Title', field: '标题' }` — 同上。
 *   - `{ headers: ['Product Title', 'Title'], field: '标题' }` — 多个候选，按顺序匹配第 `headerRow` 行里第一个命中的列。
 *
 * @param {Buffer} templateBuffer
 * @param {Record<string, unknown>[]} rowObjects
 * @param {{
 *   dataStartRow?: number,
 *   headerRow?: number,
 *   sheetName?: string,
 *   columns?: Record<string, unknown>[],
 *   strictHeaderColumnCount?: number,
 * }} options
 *        columns 可为空：须配合 strictHeaderColumnCount（仅保留内置表头、不写数据列）。
 *        strictHeaderColumnCount：有 builtinHeaderRow 时传其 length，工作表列数严格等于该值，且映射 col 不得越界。
 *        dataStartRow：数据首行 Excel 行号（从 1 开始），默认 4。
 *        headerRow：表头所在行（从 1 开始），用于表头匹配；默认 1。
 *        sheetName：仅使用该工作表（与 Excel 底部标签名一致）；不传则自动在全部工作表中查找能匹配列映射的表。
 *        写回使用 xlsx-populate：对已有单元格赋 `value`，尽量保留模板格式；strict 时裁剪多余列。
 * @returns {Promise<Buffer>}
 */
export async function fillXlsxTemplateWithColumnMap(templateBuffer, rowObjects, options) {
  if (!templateBuffer || !templateBuffer.length) {
    throw new Error('模板文件为空');
  }
  const list = Array.isArray(rowObjects) ? rowObjects : [];
  const rawColumns = Array.isArray(options?.columns) ? options.columns : [];
  const dataStartRow = Math.max(1, Number(options?.dataStartRow) || 4);
  const headerRow = Math.max(1, Number(options?.headerRow) || 1);
  const strictNRaw = options?.strictHeaderColumnCount;
  const strictN =
    strictNRaw != null && Number.isFinite(Number(strictNRaw)) && Number(strictNRaw) > 0
      ? Math.floor(Number(strictNRaw))
      : 0;

  if (!rawColumns.length) {
    if (!(strictN > 0)) {
      throw new Error(
        '列映射为空：请先在「导出映射配置」中保存映射草稿，或传入 strictHeaderColumnCount（仅保留表头不写数据）'
      );
    }
    return await fillXlsxTemplateBuiltinHeaderOnly({
      templateBuffer,
      list,
      dataStartRow,
      headerRow,
      strictN,
      sheetNameOpt: String(options?.sheetName ?? '').trim() || undefined,
    });
  }

  const startR = dataStartRow - 1;
  const wb = XLSX.read(templateBuffer, { type: 'buffer' });
  const sheetNameOpt = String(options?.sheetName ?? '').trim() || undefined;
  const { ws, sheetName: targetSheetName, columns } = pickWorksheetAndColumns(
    wb,
    rawColumns,
    headerRow,
    sheetNameOpt
  );
  if (!columns.length) {
    throw new Error(
      '列映射无效：每条需含 field，且提供 col（≥0）或 header / excelHeader / headers（模板表头文案）之一'
    );
  }

  if (strictN > 0) {
    const strictMax0 = strictN - 1;
    for (const entry of columns) {
      if (!Number.isFinite(entry.col)) continue;
      if (entry.col > strictMax0) {
        throw new Error(
          `列映射 col=${entry.col}（field=${entry.field}）超出 strictHeaderColumnCount=${strictN}，请检查表头列数配置`
        );
      }
    }
  }

  /** 写入数据前工作表已占用的最大列（宽表表头等）；勿在收尾用「仅映射列」覆盖 !ref 否则会把未映射列裁掉 */
  let templateMaxCol = 0;
  if (ws['!ref']) {
    try {
      templateMaxCol = Math.max(0, XLSX.utils.decode_range(ws['!ref']).e.c);
    } catch {
      templateMaxCol = 0;
    }
  }

  if (strictN > 0 && templateMaxCol + 1 < strictN) {
    throw new Error(
      `模板列数(${templateMaxCol + 1})少于 strictHeaderColumnCount(${strictN})，请检查模板表头列数是否正确`
    );
  }

  const xpWb = await XlsxPopulate.fromDataAsync(templateBuffer);
  const xpSheet = xpWb.sheet(targetSheetName);
  if (!xpSheet) {
    throw new Error(`工作表「${targetSheetName}」无效`);
  }

  for (let r = 0; r < list.length; r++) {
    const obj =
      list[r] && typeof list[r] === 'object' && !Array.isArray(list[r]) ? list[r] : {};
    const excelRow = startR + r + 1;
    for (const entry of columns) {
      const c = entry.col;
      const fk = entry.field;
      const val = obj[fk];
      const str = val == null ? '' : String(val);
      xpSheet.row(excelRow).cell(c + 1).value(str);
    }
  }

  const lastDataR = startR + Math.max(0, list.length) - 1;
  const lastR = Math.max(headerRow - 1, Math.max(startR - 1, lastDataR));
  const lastRow1Based = lastR + 1;
  const ur = xpSheet.usedRange();
  const trimEndRow = ur ? Math.max(lastRow1Based, ur.endCell().rowNumber()) : lastRow1Based;

  if (strictN > 0 && templateMaxCol > strictN - 1) {
    trimColumnsBeyondStrictXp(xpSheet, strictN, templateMaxCol, trimEndRow);
  }

  return workbookToBuffer(xpWb);
}
