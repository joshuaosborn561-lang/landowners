import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractPdfText, textFromDocument } from './ocr.js';
import { parseOfficerRoster } from './officers.js';

describe('free OCR / PDF text', () => {
  it('extracts officer names from PDF literal strings without a paid library', () => {
    const pdf = Buffer.from('%PDF-1.1\nBT (Chief Executive Officer: JANE SAMPLE) Tj ET\n%%EOF\n');
    const text = extractPdfText(pdf);
    const rows = parseOfficerRoster(text);
    assert.equal(rows[0]?.name, 'JANE SAMPLE');
  });

  it('OCRs image SI bytes through the injected engine (tesseract.js in production)', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0x00]);
    const got = await textFromDocument(jpeg, 'image/jpeg', {
      ocr: async () => 'Manager: JANE SAMPLE',
    });
    assert.equal(got.ocr_used, true);
    assert.equal(parseOfficerRoster(got.text)[0]?.name, 'JANE SAMPLE');
  });
});
