import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findReferences } from '../src/jira.mjs';

for (const [name, text, expected] of [
  ['empty', '', []],
  ['none', 'Nothing to see here', []],
  ['entire text', 'TEAM-123', ['TEAM-123']],
  ['start of title', 'TEAM-123: Fix login', ['TEAM-123']],
  ['end of title', 'Fix login for TEAM-123', ['TEAM-123']],
  ['title', '[TEAM-123] Fix login', ['TEAM-123']],
  ['conventional commit title', 'fix(TEAM-123): login', ['TEAM-123']],
  ['multiple title references', '[TEAM-123, OPS-456] Fix login', ['TEAM-123', 'OPS-456']],
  ['branch', 'feature/TEAM-123-fix-login', ['TEAM-123']],
  ['branch without prefix', 'TEAM-123-fix-login', ['TEAM-123']],
  ['nested branch', 'matt/bugfix/TEAM-123/fix-login', ['TEAM-123']],
  ['underscore separators', 'feature_TEAM-123_fix', ['TEAM-123']],
  ['adjacent branch references', 'feature/TEAM-123-OPS-456-fix', ['TEAM-123', 'OPS-456']],
  ['multiple adjacent', 'AB-1,CD-2;EF-3/AB-1', ['AB-1', 'CD-2', 'EF-3']],
  ['first-seen order', 'ZZ-9 AB-1 ZZ-9 CD-2 AB-1', ['ZZ-9', 'AB-1', 'CD-2']],
  ['multiline', 'Fix login\n\nRelates to TEAM-123 and OPS-456', ['TEAM-123', 'OPS-456']],
  ['URL', 'https://example.atlassian.net/browse/TEAM-123', ['TEAM-123']],
  ['digits in project', 'A2-45 TEAM2-123', ['A2-45', 'TEAM2-123']],
  ['zeroes inside project key', 'A0-1 TEAM00-123', ['A0-1', 'TEAM00-123']],
  ['zeroes inside issue number', 'TEAM-10 TEAM-1001', ['TEAM-10', 'TEAM-1001']],
  ['large issue number is preserved as text', 'TEAM-900719925474099312345', ['TEAM-900719925474099312345']],
  ['uppercase prefix and trailing digits belong to the full key', 'XTEAM-123 TEAM-1230', ['XTEAM-123', 'TEAM-1230']],
  ['valid reference after invalid candidates', 'A-1 TEAM-012 TEAM-123suffix OPS-4', ['OPS-4']],
  ['Unicode separators', '✨TEAM-123—OPS-456', ['TEAM-123', 'OPS-456']],
  ['incident is not Jira', 'INC123456', []],
]) {
  test(`Jira: ${name}`, () => assert.deepEqual(findReferences(text), expected));
}

for (const length of [2, 10, 11, 254, 255]) {
  test(`Jira: accepts a ${length}-character project key`, () => {
    const reference = `${'A'.repeat(length)}-123`;
    assert.deepEqual(findReferences(reference), [reference]);
  });
}

for (const length of [256, 300]) {
  test(`Jira: rejects a ${length}-character project key without matching its suffix`, () => {
    const reference = `${'A'.repeat(length)}-123`;
    assert.deepEqual(findReferences(reference), []);
    assert.deepEqual(findReferences(`feature/${reference}-OPS-4`), ['OPS-4']);
  });
}

test('Jira: maximum project key length includes the first letter and digits', () => {
  assert.deepEqual(findReferences(`A${'0'.repeat(254)}-1`), [`A${'0'.repeat(254)}-1`]);
  assert.deepEqual(findReferences(`A${'0'.repeat(255)}-1`), []);
});

for (const text of [
  'A-1', '-123', '0TEAM-123', '2TEAM-123', '123-456',
  'team-123', 'Team-123', 'tEAM-123',
  'TEAM-0', 'TEAM-00', 'TEAM-01', 'TEAM-0123',
  'TEAM-', 'TEAM--123', 'TEAM-+123', 'TEAM -123', 'TEAM- 123',
  'TEAM–123', 'TEAM−123', 'TEAM-１２３', 'TEAM-١٢٣',
  'prefixTEAM-123', 'TEAM-123suffix', 'TEAM-123ABC',
]) {
  test(`Jira: rejects invalid reference ${text}`, () => {
    assert.deepEqual(findReferences(text), []);
  });
}

for (const adjacent of ['a', 'é', '漢', '１', '٢', '𝒜']) {
  test(`Jira: adjacent letter or number ${adjacent} prevents a partial match`, () => {
    assert.deepEqual(findReferences(`${adjacent}TEAM-123`), []);
    assert.deepEqual(findReferences(`TEAM-123${adjacent}`), []);
  });
}

for (const separator of [' ', '\t', '\n', '\r\n', '/', '-', '_', '.', ',', ':', '#', '—', '✨']) {
  test(`Jira: separator ${JSON.stringify(separator)} permits references on both sides`, () => {
    assert.deepEqual(findReferences(`${separator}TEAM-123${separator}OPS-4${separator}`), ['TEAM-123', 'OPS-4']);
  });
}

test('matching is repeatable and returned arrays are independent', () => {
  const first = findReferences('TEAM-123 OPS-456 TEAM-123');
  first.push('EXTRA-1');
  assert.deepEqual(findReferences('No reference'), []);
  assert.deepEqual(findReferences('TEAM-123 OPS-456 TEAM-123'), ['TEAM-123', 'OPS-456']);
});
