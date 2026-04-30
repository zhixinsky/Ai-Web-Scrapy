import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRowSizeFields, parseToBestCanonicalUsSize } from '../src/sizeUsStandardize.js';

describe('parseToBestCanonicalUsSize', () => {
  it('picks max size from slash-separated (L/XL → XL)', () => {
    assert.equal(parseToBestCanonicalUsSize('L/XL'), 'X-Large');
  });

  it('matches longer token first (xxl before xl)', () => {
    assert.equal(parseToBestCanonicalUsSize('xxl'), 'XX-Large');
  });
});

describe('normalizeRowSizeFields', () => {
  it('normalizes 尺码 to US full names only (no 简码 columns)', () => {
    const row = { 尺码: 'Small' };
    const out = normalizeRowSizeFields(row);
    assert.equal(out.尺码, 'XX-Small');
    assert.ok(!('尺码简码' in out));
    assert.ok(!('标准尺码' in out));
    assert.ok(!('简码' in out));
  });

  it('handles english Size key and syncs 尺码', () => {
    const row = { Size: 'Medium' };
    const out = normalizeRowSizeFields(row);
    assert.equal(out.Size, 'X-Small');
    assert.equal(out['尺码'], 'X-Small');
    assert.ok(!('Size简码' in out));
  });

  it('composite key L/XL yields single max size (Medium)', () => {
    const row = { '尺码(US)': 'L/XL' };
    const out = normalizeRowSizeFields(row);
    assert.equal(out['尺码(US)'], 'Medium');
    assert.ok(!('尺码(US)简码' in out));
  });

  it('keeps suffix text but normalizes leading size token', () => {
    const row = {
      尺码: ['M 50-60 KG', 'L 60-67.5 KG', 'XL 65-75 KG'].join('\n'),
    };
    const out = normalizeRowSizeFields(row);
    assert.equal(out.尺码, ['X-Small', 'Small', 'Medium'].join('\n'));
  });

  it('normalizes 尺码 when plugin reports string[] (weight chart rows)', () => {
    const row = {
      尺码: ['M 50-60 KG', 'L 60-67.5 KG', 'XL 65-75 KG', 'XXL 70-82.5 KG', 'XXXL 80-90 KG'],
    };
    const out = normalizeRowSizeFields(row);
    assert.equal(typeof out.尺码, 'string');
    assert.equal(
      out.尺码,
      ['X-Small', 'Small', 'Medium', 'Large', 'X-Large'].join('\n')
    );
  });

  it('does not reprocess 尺码简码 as a size source column; leaves user placeholder', () => {
    const row = {
      尺码: 'M 50-60 KG',
      尺码简码: 'placeholder',
    };
    const out = normalizeRowSizeFields(row);
    assert.ok(String(out.尺码).includes('X-Small'));
    assert.equal(out.尺码简码, 'placeholder');
  });
});
