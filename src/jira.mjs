const issueKey = /(?<![\p{L}\p{N}])[A-Z][A-Z0-9]{1,254}-[1-9][0-9]*(?![\p{L}\p{N}])/gu;

/**
 * Return distinct Jira issue keys in first-seen order, or [] for no matches.
 * Cloud project keys contain 2–255 uppercase ASCII letters or digits and
 * start with a letter. Issue numbers are positive and have no leading zeroes.
 * Matching is case-sensitive and checks syntax only. Adjacent Unicode letters
 * or numbers disqualify a match; punctuation and underscores separate keys.
 * This module is independent of GitHub Actions and has no dependencies.
 */
export function findReferences(text) {
  return [...new Set(Array.from(text.matchAll(issueKey), (match) => match[0]))];
}
