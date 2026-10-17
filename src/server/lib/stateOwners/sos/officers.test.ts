import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseOfficerRoster, rosterToPeople } from './officers.js';

describe('parseOfficerRoster', () => {
  it('reads SI-550 labeled officers and skips registered agents', () => {
    const text = `
Chief Executive Officer: JANE SAMPLE
Secretary: JOHN SAMPLE
Registered Agent: CT CORPORATION SYSTEM
`;
    const rows = parseOfficerRoster(text);
    assert.deepEqual(
      rows.map((r) => r.name),
      ['JANE SAMPLE', 'JOHN SAMPLE'],
    );
    assert.equal(rows[0]?.role, 'officer');
  });

  it('reads HTML officer tables', () => {
    const html = `<table><tr><th>Title</th><th>Name</th></tr><tr><td>Manager</td><td>JANE SAMPLE</td></tr></table>`;
    const rows = parseOfficerRoster(html);
    assert.equal(rows[0]?.name, 'JANE SAMPLE');
    assert.equal(rows[0]?.role, 'member');
  });

  it('maps roster rows to people with first/last', () => {
    const people = rosterToPeople(
      [{ name: 'JANE SAMPLE', title: 'CEO', role: 'officer' }],
      'ca_bizfile',
      'https://example.test',
      'high',
    );
    assert.equal(people[0]?.first_name, 'JANE');
    assert.equal(people[0]?.last_name, 'SAMPLE');
  });
});
