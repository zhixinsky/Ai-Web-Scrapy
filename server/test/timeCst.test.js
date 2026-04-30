import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nowCstIso } from '../src/timeCst.js';

describe('nowCstIso', () => {
  it('returns +08:00 suffix and looks like ISO date', () => {
    const s = nowCstIso();
    assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  });
});
