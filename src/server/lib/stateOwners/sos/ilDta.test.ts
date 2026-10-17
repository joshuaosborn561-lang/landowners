import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  emptyIlIndex,
  ingestIlDtaText,
  matchIlDta,
  parseCorpAnnualLine,
} from './ilDta.js';

describe('IL DTA bulk files', () => {
  it('parses a 126-byte corporate annual-report line', () => {
    const line =
      '20240001' +
      '2024' +
      'JANE SAMPLE'.padEnd(40) +
      'MANAGER'.padEnd(20) +
      'JOHN SAMPLE'.padEnd(40) +
      'MEMBER'.padEnd(14);
    assert.equal(line.length, 126);
    const parsed = parseCorpAnnualLine(line);
    assert.ok(parsed);
    assert.equal(parsed!.file_number, '20240001');
    assert.ok(parsed!.officers.some((o) => o.name === 'JANE SAMPLE'));
  });

  it('ingests a TSV annual-report extract and city-matches', () => {
    const index = emptyIlIndex();
    ingestIlDtaText(
      index,
      [
        'file_number\tlegal_name\tdba_name\tcity\tofficer_name\tofficer_title',
        '20240001\tSAMPLE HVAC LLC\t\tChicago\tJANE SAMPLE\tMANAGER',
      ].join('\n'),
      'officers.tsv',
    );
    const hit = matchIlDta({ company_name: 'Sample HVAC LLC', city: 'Chicago', state: 'IL' }, index);
    assert.ok(hit);
    assert.equal(hit!.entity.officers[0]?.name, 'JANE SAMPLE');
  });
});
