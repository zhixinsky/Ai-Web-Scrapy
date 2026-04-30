import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPlatformDataOnSave,
  genericToAmazonPlatformData,
  genericToExportSecondaryPlatformData,
} from '../src/platform/genericToPlatform.js';

describe('genericToExportSecondaryPlatformData', () => {
  it('does not merge 详情 + 详情_value_xpath (keeps both columns)', () => {
    const out = genericToExportSecondaryPlatformData({
      rows: [{ 详情: 'A|B', 详情_value_xpath: '1|2' }],
    });
    assert.ok(Array.isArray(out.rows));
    const row = out.rows[0];
    assert.equal(row['详情'], 'A|B');
    assert.equal(row['详情_value_xpath'], '1|2');
  });
});

describe('genericToAmazonPlatformData', () => {
  it('merges 详情 into Amazon format', () => {
    const out = genericToAmazonPlatformData({
      rows: [{ 详情: 'A|B', 详情_value_xpath: '1|2' }],
    });
    assert.ok(!('详情_value_xpath' in out.rows[0]));
    assert.ok(String(out.rows[0]['详情']).includes('A:1'));
  });
});

describe('applyPlatformDataOnSave', () => {
  it('normalizes string[] 尺码 like genericToAmazonPlatformData (no detail merge)', () => {
    const out = applyPlatformDataOnSave({
      rows: [
        {
          尺码: ['M 50-60 KG', 'L 60-67.5 KG'],
          详情: 'already:merged<br>',
        },
      ],
    });
    assert.equal(typeof out.rows[0].尺码, 'string');
    assert.ok(String(out.rows[0].尺码).includes('X-Small'));
    assert.equal(out.rows[0].详情, 'already:merged<br>');
  });
});
