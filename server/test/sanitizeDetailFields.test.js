import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeBrDetailString,
  sanitizeRowDetailFields,
  stripNoiseKeysFromRow,
} from '../src/sanitizeDetailFields.js';

describe('sanitizeBrDetailString', () => {
  it('drops brand and size segments', () => {
    const input =
      'Color: Red<br>Brand: X<br>Material: Cotton<br>Size: L';
    const out = sanitizeBrDetailString(input);
    assert.ok(!out.includes('Brand'));
    assert.ok(!out.includes('Size'));
    assert.ok(out.includes('Color'));
    assert.ok(out.includes('Material'));
  });

  it('drops segments when key contains Chinese drop substrings', () => {
    const input =
      '颜色:红<br>品牌:某牌<br>面料:棉<br>尺码:M<br>货号:001';
    const out = sanitizeBrDetailString(input);
    assert.ok(out.includes('颜色'));
    assert.ok(out.includes('面料'));
    assert.ok(!out.includes('品牌'));
    assert.ok(!out.includes('尺码'));
    assert.ok(!out.includes('货号'));
  });

  it('passes through non-string', () => {
    assert.equal(sanitizeBrDetailString(null), null);
    assert.equal(sanitizeBrDetailString(undefined), undefined);
  });

  it('drops 搜索关键页 / 搜索关键字 segments in 详情', () => {
    const input = '颜色:红<br>搜索关键页:foo<br>面料:棉<br>搜索关键字:bar';
    const out = sanitizeBrDetailString(input);
    assert.ok(out.includes('颜色'));
    assert.ok(out.includes('面料'));
    assert.ok(!out.includes('搜索关键'));
  });
});

describe('sanitizeRowDetailFields', () => {
  it('sanitizes keys containing 详情', () => {
    const row = {
      商品详情: 'Brand: A<br>Weight: 1kg',
      name: 'x',
    };
    const out = sanitizeRowDetailFields(row);
    assert.ok(!out.商品详情.includes('Brand'));
    assert.equal(out.name, 'x');
  });
});

describe('stripNoiseKeysFromRow', () => {
  it('removes standalone 搜索关键页 / 搜索关键字 columns', () => {
    const row = { 标题: 'a', 搜索关键页: 'x', 搜索关键字: 'y' };
    const out = stripNoiseKeysFromRow(row);
    assert.equal(out.标题, 'a');
    assert.ok(!('搜索关键页' in out));
    assert.ok(!('搜索关键字' in out));
  });
});
