// Package jira finds Jira issue references without depending on GitHub Actions.
package jira

import (
	"regexp"
	"unicode"
	"unicode/utf8"
)

var issueKey = regexp.MustCompile(`[A-Z][A-Z0-9]{1,254}-[1-9][0-9]*`)

// FindReferences returns distinct Jira issue keys in first-seen order. When no
// keys match, it returns an empty, non-nil slice.
//
// Cloud project keys contain 2–255 uppercase ASCII letters or digits and start
// with a letter. Issue numbers are positive and have no leading zeroes. Matching
// is case-sensitive and checks syntax only. Adjacent Unicode letters or numbers
// disqualify a match; punctuation and underscores separate keys.
func FindReferences(text string) []string {
	references := make([]string, 0)
	seen := make(map[string]bool)
	for _, match := range issueKey.FindAllStringIndex(text, -1) {
		// Empty edge slices decode as RuneError, which is neither a letter nor a number.
		before, _ := utf8.DecodeLastRuneInString(text[:match[0]])
		after, _ := utf8.DecodeRuneInString(text[match[1]:])
		if unicode.IsLetter(before) || unicode.IsNumber(before) ||
			unicode.IsLetter(after) || unicode.IsNumber(after) {
			continue
		}

		reference := text[match[0]:match[1]]
		if !seen[reference] {
			seen[reference] = true
			references = append(references, reference)
		}
	}
	return references
}
