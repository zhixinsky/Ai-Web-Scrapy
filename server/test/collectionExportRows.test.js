import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getExportRowsForDataJson } from '../src/export/collectionExportRows.js';

describe('getExportRowsForDataJson sku_axes', () => {
  it('expands 3 colors × 5 sizes when mains length wrongly equals sizes (15 rows)', () => {
    const parsed = {
      rows: [
        {
          父子关系: 'parent',
          标题: 'T',
          主图: ['https://a/0.jpg', 'https://a/1.jpg', 'https://a/2.jpg'],
        },
      ],
      sku_axes: {
        colors: ['红', '黄', '蓝'],
        sizes: ['X-Small', 'Small', 'Medium', 'Large', 'X-Large'],
        mains: ['u0', 'u1', 'u2', 'u3', 'u4'],
      },
    };
    const rows = getExportRowsForDataJson(parsed);
    assert.equal(rows.length, 15);
    assert.equal(rows[0]['颜色'], '红');
    assert.equal(rows[4]['颜色'], '红');
    assert.equal(rows[5]['颜色'], '黄');
    assert.equal(rows[14]['颜色'], '蓝');
    assert.equal(rows[14]['尺码'], 'X-Large');
  });

  it('pads short mains to color count using parent main URLs', () => {
    const parsed = {
      rows: [
        {
          父子关系: 'parent',
          主图: ['https://m/a.jpg', 'https://m/b.jpg', 'https://m/c.jpg'],
        },
      ],
      sku_axes: {
        colors: ['红', '黄', '蓝'],
        sizes: ['S', 'M'],
        mains: ['only-one'],
      },
    };
    const rows = getExportRowsForDataJson(parsed);
    assert.equal(rows.length, 6);
    assert.equal(rows[0]['主图'], 'only-one');
    assert.ok(String(rows[2]['主图'] ?? '').includes('m/b'));
  });

  it('expands single flat row without 父子关系: array colors × multiline sizes (3×5=15)', () => {
    const parsed = {
      rows: [
        {
          标题: 'Men Autumn Long Sleeve',
          颜色: ['Gray', 'Blue', 'Purple'],
          尺码: 'X-Small\nSmall\nMedium\nLarge\nX-Large',
          主图: ['https://example.com/0.jpg', 'https://example.com/1.jpg', 'https://example.com/2.jpg'],
        },
      ],
    };
    const rows = getExportRowsForDataJson(parsed);
    assert.equal(rows.length, 15);
    assert.equal(rows[0]['颜色'], 'Gray');
    assert.equal(rows[4]['颜色'], 'Gray');
    assert.equal(rows[5]['颜色'], 'Blue');
    assert.equal(rows[14]['尺码'], 'X-Large');
    assert.equal(rows[0]['主图'], 'https://example.com/0.jpg');
    assert.equal(rows[4]['主图'], 'https://example.com/0.jpg');
    assert.equal(rows[5]['主图'], 'https://example.com/1.jpg');
    assert.equal(rows[9]['主图'], 'https://example.com/1.jpg');
    assert.equal(rows[10]['主图'], 'https://example.com/2.jpg');
    assert.equal(rows[14]['主图'], 'https://example.com/2.jpg');
  });

  it('skips colors marked false in color_export_checked (sku_axes)', () => {
    const parsed = {
      color_export_checked: [true, false, true],
      rows: [{ 父子关系: 'parent', 标题: 'T' }],
      sku_axes: {
        colors: ['红', '黄', '蓝'],
        sizes: ['S', 'M'],
        mains: ['m0', 'm1', 'm2'],
      },
    };
    const rows = getExportRowsForDataJson(parsed);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r['颜色'] !== '黄'));
  });

  it('skips colors marked false in color_export_checked (multiline parent)', () => {
    const parsed = {
      color_export_checked: [true, false],
      rows: [
        {
          标题: 'T',
          颜色: 'A\nB',
          尺码: 'S\nM',
          主图: ['https://a/0.jpg', 'https://a/1.jpg'],
        },
      ],
    };
    const rows = getExportRowsForDataJson(parsed);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => String(r['颜色'] ?? '').trim() === 'A'));
  });

  it('skips sizes marked false in size_export_checked (sku_axes)', () => {
    const parsed = {
      size_export_checked: [true, false, true, false, true],
      rows: [{ 父子关系: 'parent', 标题: 'T' }],
      sku_axes: {
        colors: ['红', '黄'],
        sizes: ['X-Small', 'Small', 'Medium', 'Large', 'X-Large'],
        mains: ['m0', 'm1'],
      },
    };
    const rows = getExportRowsForDataJson(parsed);
    assert.equal(rows.length, 6);
    assert.ok(rows.every((r) => !['Small', 'Large'].includes(String(r['尺码'] ?? '').trim())));
  });

  it('skips sizes marked false in size_export_checked (multiline parent)', () => {
    const parsed = {
      size_export_checked: [true, false, true],
      rows: [
        {
          标题: 'T',
          颜色: 'A\nB',
          尺码: 'S\nM\nL',
          主图: ['https://a/0.jpg', 'https://a/1.jpg'],
        },
      ],
    };
    const rows = getExportRowsForDataJson(parsed);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => String(r['尺码'] ?? '').trim() !== 'M'));
  });
});
