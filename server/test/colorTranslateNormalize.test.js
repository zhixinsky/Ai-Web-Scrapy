import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  containsChinese,
  parseColorTranslateOutput,
  parseSingleLineColorOutput,
  truncateColorLine,
} from '../src/ai/responseNormalize.js';

describe('containsChinese', () => {
  it('detects CJK', () => {
    assert.equal(containsChinese('红色'), true);
    assert.equal(containsChinese('Red'), false);
    assert.equal(containsChinese('红Blue'), true);
  });
});

describe('parseColorTranslateOutput', () => {
  it('accepts exact line count', () => {
    assert.deepEqual(parseColorTranslateOutput('Red\nBlue\n', 3), null);
    assert.deepEqual(parseColorTranslateOutput('Red\nBlue\nBlack', 3), ['Red', 'Blue', 'Black']);
  });

  it('strips trailing blank lines from model', () => {
    assert.deepEqual(parseColorTranslateOutput('Red\nBlue\n\n', 2), ['Red', 'Blue']);
  });
});

describe('parseSingleLineColorOutput', () => {
  it('takes first line when model returns multiple lines', () => {
    assert.equal(parseSingleLineColorOutput('Army Green\nDark Green'), 'Army Green');
  });

  it('returns null for empty', () => {
    assert.equal(parseSingleLineColorOutput(''), null);
    assert.equal(parseSingleLineColorOutput('  \n  '), null);
  });
});

describe('truncateColorLine', () => {
  it('cuts off product words and keeps leading color phrase', () => {
    assert.equal(truncateColorLine('Gray Men Tshirt'), 'Gray');
    assert.equal(truncateColorLine('Blue Men Tshirt'), 'Blue');
    assert.equal(truncateColorLine('Purple Men Tshirt'), 'Purple');
    assert.equal(truncateColorLine('Light Blue Men T-Shirt'), 'Light Blue');
  });
});
