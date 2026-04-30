import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  coerceDetailFieldValueToBrString,
  flattenRowDetailBrSegments,
} from '../src/ai/collectionAuto.js';

describe('coerceDetailFieldValueToBrString / flattenRowDetailBrSegments', () => {
  it('coerces 详情 string[] to br-joined string', () => {
    const s = coerceDetailFieldValueToBrString(['颜色:白', '面料:棉']);
    assert.equal(s, '颜色:白<br>面料:棉');
  });

  it('flatten includes 详情 array when text contains Chinese', () => {
    const rows = [{ 详情: ['品牌:测试', '面料:纯棉'] }];
    const { flatLines, owners } = flattenRowDetailBrSegments(rows);
    assert.ok(flatLines.length >= 1);
    assert.equal(owners[0].key, '详情');
  });

  it('drops empty segment from trailing <br> (merge output) so MiMo line count matches', () => {
    const rows = [{ 详情: '面料:棉<br>风格:休闲<br>' }];
    const { flatLines } = flattenRowDetailBrSegments(rows);
    assert.equal(flatLines.length, 2);
    assert.ok(!flatLines.some((l) => !l.trim()));
    assert.ok(flatLines.some((l) => l.includes('面料')));
  });
});
