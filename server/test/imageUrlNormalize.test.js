import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCollectionImageUrls, normalizeOneImageUrl } from '../src/imageUrlNormalize.js';

describe('normalizeOneImageUrl', () => {
  it('strips Alibaba _.webp after first .jpg', () => {
    const input =
      'https://cbu01.alicdn.com/img/ibank/O1CN01JF0p4V1kgbj6ITkmE_!!2216353244713-0-cib.jpg_.webp';
    const out = normalizeOneImageUrl(input);
    assert.equal(
      out,
      'https://cbu01.alicdn.com/img/ibank/O1CN01JF0p4V1kgbj6ITkmE_!!2216353244713-0-cib.jpg'
    );
  });

  it('strips _b.jpg after first .jpg', () => {
    const input =
      'https://cbu01.alicdn.com/img/ibank/O1CN01iSL0bS1kgbj85gUGV_!!2216353244713-0-cib.jpg_b.jpg';
    const out = normalizeOneImageUrl(input);
    assert.equal(
      out,
      'https://cbu01.alicdn.com/img/ibank/O1CN01iSL0bS1kgbj85gUGV_!!2216353244713-0-cib.jpg'
    );
  });

  it('finds https after leading junk', () => {
    const input = 'see pic https://a.com/i.png@large extra';
    assert.equal(normalizeOneImageUrl(input), 'https://a.com/i.png');
  });

  it('drops query after extension', () => {
    assert.equal(
      normalizeOneImageUrl('https://x.com/a/b.jpg?w=800&h=800'),
      'https://x.com/a/b.jpg'
    );
  });
});

describe('normalizeCollectionImageUrls', () => {
  it('normalizes 副图 and 副图N in platform rows', () => {
    const dirty =
      'https://cbu01.alicdn.com/img/ibank/O1CN01JF0p4V1kgbj6ITkmE_!!2216353244713-0-cib.jpg_.webp';
    const out = normalizeCollectionImageUrls({
      rows: [
        {
          副图: dirty,
          副图2: dirty,
        },
      ],
    });
    const row = out.rows[0];
    assert.ok(!String(row['副图']).includes('_.webp'));
    assert.ok(!String(row['副图2']).includes('_.webp'));
  });
});
