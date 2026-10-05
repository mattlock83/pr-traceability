import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findReferences } from '../src/jira.mjs';

for (const [name, text, expected] of [
  ['empty', '', []],
  ['none', 'Nothing to see here', []],
  ['title', '[TEAM-123] Fix login', ['TEAM-123']],
  ['branch', 'feature/TEAM-123-fix-login', ['TEAM-123']],
  ['underscore separators', 'feature_TEAM-123_fix', ['TEAM-123']],
  ['multiple adjacent', 'AB-1,CD-2;EF-3/AB-1', ['AB-1', 'CD-2', 'EF-3']],
  ['multiline', 'Fix login\n\nRelates to TEAM-123 and OPS-456', ['TEAM-123', 'OPS-456']],
  ['URL', 'https://example.atlassian.net/browse/TEAM-123', ['TEAM-123']],
  ['digits in project', 'A2-45 TEAM2-123', ['A2-45', 'TEAM2-123']],
  ['case sensitive', 'team-123 Team-123 tEAM-123', []],
  ['invalid keys', 'A-1 2TEAM-123 TEAM-0 TEAM-012 TEAM- TEAM--123', []],
  ['embedded', 'prefixTEAM-123 TEAM-123suffix TEAM-123ABC', []],
  ['Unicode boundaries', 'éTEAM-123 TEAM-123漢 １TEAM-123 TEAM-123٢ 𝒜TEAM-123', []],
  ['Unicode separators', '✨TEAM-123—OPS-456', ['TEAM-123', 'OPS-456']],
  ['incident is not Jira', 'INC123456', []],
]) {
  test(`Jira: ${name}`, () => assert.deepEqual(findReferences(text), expected));
}

test('matching is repeatable and returned arrays are independent', () => {
  const first = findReferences('TEAM-123 OPS-456 TEAM-123');
  first.push('EXTRA-1');
  assert.deepEqual(findReferences('TEAM-123 OPS-456 TEAM-123'), ['TEAM-123', 'OPS-456']);
});
