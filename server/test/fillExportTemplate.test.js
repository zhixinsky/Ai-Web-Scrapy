import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveColumnIndexByHeader,
  fillXlsxTemplateWithColumnMap,
  xlsxBufferFromColumnMapSyntheticHeader,
  xlsxBufferFromSingleHeaderRow,
} from '../src/export/fillExportTemplate.js';

describe('resolveColumnIndexByHeader', () => {
  it('finds column by exact header text on row 1', () => {
    const ws = {
      A1: { t: 's', v: '商品标题' },
      E1: { t: 's', v: '价格' },
      '!ref': 'A1:E1',
    };
    assert.equal(resolveColumnIndexByHeader(ws, 1, '商品标题'), 0);
    assert.equal(resolveColumnIndexByHeader(ws, 1, '价格'), 4);
  });

  it('normalizes whitespace for match', () => {
    const ws = {
      B1: { t: 's', v: '  采集  时间  ' },
      '!ref': 'A1:C1',
    };
    assert.equal(resolveColumnIndexByHeader(ws, 1, '采集 时间'), 1);
  });

  it('returns null when missing', () => {
    const ws = { A1: { t: 's', v: 'A' }, '!ref': 'A1:B1' };
    assert.equal(resolveColumnIndexByHeader(ws, 1, '不存在'), null);
  });

  it('finds column on header row 3 (1-based)', () => {
    const ws = {
      A1: { t: 's', v: 'note' },
      A3: { t: 's', v: 'item_name' },
      C3: { t: 's', v: 'sku' },
      '!ref': 'A1:C3',
    };
    assert.equal(resolveColumnIndexByHeader(ws, 3, 'item_name'), 0);
    assert.equal(resolveColumnIndexByHeader(ws, 3, 'sku'), 2);
  });

  it('reads header through horizontal merge (value only on merge top-left)', () => {
    const ws = {
      A3: { t: 's', v: 'item_name' },
      '!ref': 'A3:B3',
      '!merges': [{ s: { r: 2, c: 0 }, e: { r: 2, c: 1 } }],
    };
    assert.equal(resolveColumnIndexByHeader(ws, 3, 'item_name'), 0);
  });
});

describe('fillXlsxTemplateWithColumnMap by header', () => {
  it('writes row field to column matched by header', async () => {
    const XLSX = (await import('xlsx')).default;
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['商品标题', 'SKU'],
      ['', ''],
      ['', ''],
      ['', ''],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

    const out = await fillXlsxTemplateWithColumnMap(buf, [{ 标题: 'Hello', SKU: 'X1' }], {
      dataStartRow: 4,
      headerRow: 1,
      columns: [
        { header: '商品标题', field: '标题' },
        { header: 'SKU', field: 'SKU' },
      ],
    });

    const wb2 = XLSX.read(out, { type: 'buffer' });
    const ws2 = wb2.Sheets[wb2.SheetNames[0]];
    const a4 = ws2[XLSX.utils.encode_cell({ r: 3, c: 0 })];
    const b4 = ws2[XLSX.utils.encode_cell({ r: 3, c: 1 })];
    assert.equal(a4?.v, 'Hello');
    assert.equal(b4?.v, 'X1');
  });

  it('writes using excelHeader (English) mapped to field', async () => {
    const XLSX = (await import('xlsx')).default;
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Product Title', 'Other'],
      ['', ''],
      ['', ''],
      ['', ''],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

    const out = await fillXlsxTemplateWithColumnMap(buf, [{ 标题: 'Hi EN' }], {
      dataStartRow: 4,
      headerRow: 1,
      columns: [{ excelHeader: 'Product Title', field: '标题' }],
    });

    const wb2 = XLSX.read(out, { type: 'buffer' });
    const ws2 = wb2.Sheets[wb2.SheetNames[0]];
    const a4 = ws2[XLSX.utils.encode_cell({ r: 3, c: 0 })];
    assert.equal(a4?.v, 'Hi EN');
  });

  it('uses first matching header from headers array', async () => {
    const XLSX = (await import('xlsx')).default;
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 'Seller SKU'],
      ['', ''],
      ['', ''],
      ['', ''],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

    const out = await fillXlsxTemplateWithColumnMap(buf, [{ SKU: 'SK-9' }], {
      dataStartRow: 4,
      headerRow: 1,
      columns: [{ headers: ['SKU', 'Seller SKU'], field: 'SKU' }],
    });

    const wb2 = XLSX.read(out, { type: 'buffer' });
    const ws2 = wb2.Sheets[wb2.SheetNames[0]];
    const b4 = ws2[XLSX.utils.encode_cell({ r: 3, c: 1 })];
    assert.equal(b4?.v, 'SK-9');
  });

  it('matches header on row 3 when headerRow is 3', async () => {
    const XLSX = (await import('xlsx')).default;
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Template note row 1'],
      [''],
      ['item_name', 'sku'],
      ['', ''],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

    const out = await fillXlsxTemplateWithColumnMap(buf, [{ 标题: 'Row3Hdr', SKU: 'S1' }], {
      dataStartRow: 4,
      headerRow: 3,
      columns: [
        { excelHeader: 'item_name', field: '标题' },
        { excelHeader: 'sku', field: 'SKU' },
      ],
    });

    const wb2 = XLSX.read(out, { type: 'buffer' });
    const ws2 = wb2.Sheets[wb2.SheetNames[0]];
    const a4 = ws2[XLSX.utils.encode_cell({ r: 3, c: 0 })];
    const b4 = ws2[XLSX.utils.encode_cell({ r: 3, c: 1 })];
    assert.equal(a4?.v, 'Row3Hdr');
    assert.equal(b4?.v, 'S1');
  });

  it('uses worksheet where headers match when first sheet lacks them', async () => {
    const XLSX = (await import('xlsx')).default;
    const wb = XLSX.utils.book_new();
    const wsWrong = XLSX.utils.aoa_to_sheet([
      ['wrong'],
      [''],
      ['not_item', 'x'],
      ['', ''],
    ]);
    XLSX.utils.book_append_sheet(wb, wsWrong, 'Instructions');
    const wsOk = XLSX.utils.aoa_to_sheet([
      ['ok'],
      [''],
      ['item_name', 'sku'],
      ['', ''],
    ]);
    XLSX.utils.book_append_sheet(wb, wsOk, 'Template');
    const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

    const out = await fillXlsxTemplateWithColumnMap(buf, [{ 标题: 'Pick2', SKU: 'Z2' }], {
      dataStartRow: 4,
      headerRow: 3,
      columns: [
        { excelHeader: 'item_name', field: '标题' },
        { excelHeader: 'sku', field: 'SKU' },
      ],
    });

    const wb2 = XLSX.read(out, { type: 'buffer' });
    assert.equal(wb2.SheetNames[0], 'Instructions');
    const wsIns = wb2.Sheets.Instructions;
    const a4ins = wsIns[XLSX.utils.encode_cell({ r: 3, c: 0 })];
    assert.ok(!a4ins?.v || a4ins.v === '');
    const wsTpl = wb2.Sheets.Template;
    const a4 = wsTpl[XLSX.utils.encode_cell({ r: 3, c: 0 })];
    const b4 = wsTpl[XLSX.utils.encode_cell({ r: 3, c: 1 })];
    assert.equal(a4?.v, 'Pick2');
    assert.equal(b4?.v, 'Z2');
  });
});

describe('xlsxBufferFromColumnMapSyntheticHeader', () => {
  it('builds sheet with header on row 3 and fills data', async () => {
    const XLSX = (await import('xlsx')).default;
    const mapCfg = {
      dataStartRow: 4,
      headerRow: 3,
      sheetName: '模板',
      columns: [
        { excelHeader: 'item_name', field: '标题' },
        { excelHeader: 'product_description', field: '描述' },
      ],
    };
    const buf = xlsxBufferFromColumnMapSyntheticHeader(mapCfg);
    assert.ok(buf && buf.length > 0);
    const out = await fillXlsxTemplateWithColumnMap(buf, [{ 标题: 'SynTitle', 描述: 'SynDesc' }], {
      dataStartRow: 4,
      headerRow: 3,
      sheetName: '模板',
      columns: mapCfg.columns,
    });
    const wb2 = XLSX.read(out, { type: 'buffer' });
    const ws2 = wb2.Sheets['模板'];
    const a4 = ws2[XLSX.utils.encode_cell({ r: 3, c: 0 })];
    const b4 = ws2[XLSX.utils.encode_cell({ r: 3, c: 1 })];
    assert.equal(a4?.v, 'SynTitle');
    assert.equal(b4?.v, 'SynDesc');
  });

  it('returns null when builtinHeaderRow is set', () => {
    const buf = xlsxBufferFromColumnMapSyntheticHeader({
      builtinHeaderRow: ['A', 'B'],
      columns: [{ col: 0, field: 'x' }],
    });
    assert.equal(buf, null);
  });
});

describe('strictHeaderColumnCount', () => {
  it('trims sheet to exact column count and drops extra template columns', async () => {
    const XLSX = (await import('xlsx')).default;
    const headers = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const buf = xlsxBufferFromSingleHeaderRow(headers);
    const out = await fillXlsxTemplateWithColumnMap(buf, [{ v: 'ok' }], {
      dataStartRow: 2,
      headerRow: 1,
      columns: [{ col: 0, field: 'v' }],
      strictHeaderColumnCount: 5,
    });
    const wb = XLSX.read(out, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rng = XLSX.utils.decode_range(ws['!ref']);
    assert.equal(rng.e.c + 1, 5);
    assert.equal(ws[XLSX.utils.encode_cell({ r: 0, c: 4 })]?.v, 'c4');
    assert.equal(ws[XLSX.utils.encode_cell({ r: 0, c: 5 })], undefined);
  });
});

describe('fillXlsxTemplateWithColumnMap wide builtin header', () => {
  it('preserves all header columns in !ref when only a few columns are mapped', async () => {
    const XLSX = (await import('xlsx')).default;
    const headers = Array.from({ length: 80 }, (_, i) => `h${i}`);
    headers[0] = '商品名称';
    headers[1] = '卖家 SKU';
    const buf = xlsxBufferFromSingleHeaderRow(headers);
    const out = await fillXlsxTemplateWithColumnMap(buf, [{ 标题: 'WideTitle', 卖家SKU: 'SK-1' }], {
      dataStartRow: 2,
      headerRow: 1,
      columns: [
        { col: 0, field: '标题' },
        { col: 1, field: '卖家SKU' },
      ],
    });
    const wb = XLSX.read(out, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rng = XLSX.utils.decode_range(ws['!ref']);
    assert.ok(rng.e.c >= 79, `expected sheet last column index >= 79, got ${rng.e.c}`);
    const lastHeader = ws[XLSX.utils.encode_cell({ r: 0, c: 79 })];
    assert.equal(lastHeader?.v, 'h79');
  });
});
