import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenRowColorFields,
  writeBackRowColors,
} from '../src/ai/collectionAuto.js';

describe('flattenRowColorFields / writeBackRowColors', () => {
  it('expands 颜色 string[] into one flat line per element (mode array)', () => {
    const rows = [
      {
        颜色: ['白色', '黄色', '抹茶绿'],
      },
    ];
    const { flatLines, owners } = flattenRowColorFields(rows);
    assert.deepEqual(flatLines, ['白色', '黄色', '抹茶绿']);
    assert.equal(owners.length, 3);
    assert.equal(owners[0].mode, 'array');
    assert.equal(owners[1].mode, 'array');
    assert.equal(owners[2].mode, 'array');
  });

  it('writeBack restores array shape for translated lines', () => {
    const rows = [{ 颜色: ['白色', '黄色'] }];
    const { flatLines, owners } = flattenRowColorFields(rows);
    assert.equal(flatLines.length, 2);
    const ok = writeBackRowColors(rows, owners, ['White', 'Yellow']);
    assert.equal(ok, true);
    assert.ok(Array.isArray(rows[0].颜色));
    assert.deepEqual(rows[0].颜色, ['White', 'Yellow']);
  });

  it('still supports multiline string (mode lines)', () => {
    const rows = [{ 颜色: '白色\n黄色' }];
    const { flatLines, owners } = flattenRowColorFields(rows);
    assert.deepEqual(flatLines, ['白色', '黄色']);
    assert.equal(owners[0].mode, 'lines');
    writeBackRowColors(rows, owners, ['White', 'Yellow']);
    assert.equal(typeof rows[0].颜色, 'string');
    assert.equal(rows[0].颜色, 'White\nYellow');
  });
});
