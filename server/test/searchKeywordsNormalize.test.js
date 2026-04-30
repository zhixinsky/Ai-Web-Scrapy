import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAmazonSearchKeywordsText } from '../src/ai/responseNormalize.js';

describe('normalizeAmazonSearchKeywordsText', () => {
  it('splits CamelCase-glued tokens into space-separated words', () => {
    const out = normalizeAmazonSearchKeywordsText(
      'MenSummerShirt CottonShirt CasualShirt WorkShirt WhiteShirt ShortSleeveShirt BreathableShirt Collare'
    );
    assert.ok(out.includes('Men Summer Shirt'), out);
    assert.ok(out.includes('Cotton Shirt'), out);
    assert.ok(!out.includes('MenSummerShirt'), out);
  });

  it('preserves semicolons between keyword phrases and trims to 100 chars', () => {
    const raw =
      'Men Shirts;ShortSleeve Shirts;Cotton Shirts;Casual Shirts;Summer Shirts;Work Shirts;Breathable Fabric;Extra';
    const out = normalizeAmazonSearchKeywordsText(raw);
    assert.ok(out.includes(';'), out);
    assert.ok(out.startsWith('Men Shirts'), out);
    assert.ok(out.includes('Short Sleeve Shirts'), out);
    assert.ok(out.length <= 100, `length ${out.length}`);
  });
});
