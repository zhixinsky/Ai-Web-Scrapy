import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAmazonDetailFromNameValueLists,
  mergeAmazonDetailNameValueRow,
  shouldDropAmazonDetailAttributeName,
} from '../src/amazonDetailFromNameValueLists.js';

describe('shouldDropAmazonDetailAttributeName', () => {
  it('drops CN case-insensitively', () => {
    assert.equal(shouldDropAmazonDetailAttributeName('CN'), true);
    assert.equal(shouldDropAmazonDetailAttributeName('cn'), true);
  });
  it('drops Brand Name case-insensitively', () => {
    assert.equal(shouldDropAmazonDetailAttributeName('brand name'), true);
    assert.equal(shouldDropAmazonDetailAttributeName('Brand Name'), true);
  });
  it('keeps unrelated keys', () => {
    assert.equal(shouldDropAmazonDetailAttributeName('Closure Type'), false);
    assert.equal(shouldDropAmazonDetailAttributeName('Product Care Instructions'), false);
  });
});

describe('buildAmazonDetailFromNameValueLists', () => {
  it('matches user example with | delimiter (multi-word safe)', () => {
    const out = buildAmazonDetailFromNameValueLists(
      'Special Features|Product Care Instructions|Closure Type|CN',
      'Breathable|Machine Wash|Pull On|Guangdong'
    );
    assert.equal(
      out,
      'Special Features:Breathable<br>Product Care Instructions:Machine Wash<br>Closure Type:Pull On<br>'
    );
  });

  it('truncates to shorter list', () => {
    const out = buildAmazonDetailFromNameValueLists('A B C', '1 2');
    assert.equal(out, 'A:1<br>B:2<br>');
  });

  it('uses whitespace split when no pipe', () => {
    const out = buildAmazonDetailFromNameValueLists('A B', '1 2');
    assert.equal(out, 'A:1<br>B:2<br>');
  });
});

describe('mergeAmazonDetailNameValueRow', () => {
  it('removes 详情_value_xpath', () => {
    const row = mergeAmazonDetailNameValueRow({
      详情: 'A|B',
      详情_value_xpath: '1|2',
      x: 1,
    });
    assert.equal(row.详情, 'A:1<br>B:2<br>');
    assert.equal('详情_value_xpath' in row, false);
  });

  it('merges parallel string arrays (plugin style)', () => {
    const row = mergeAmazonDetailNameValueRow({
      详情: ['面料', '风格'],
      详情_value_xpath: ['棉', '休闲'],
    });
    assert.equal(row.详情, '面料:棉<br>风格:休闲<br>');
    assert.equal('详情_value_xpath' in row, false);
  });
});
