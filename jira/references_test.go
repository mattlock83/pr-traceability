package jira_test

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/mattlock83/pr-traceability/jira"
)

func ExampleFindReferences() {
	for _, reference := range jira.FindReferences("feature/TEAM-123-fix-OPS-456-TEAM-123") {
		fmt.Println(reference)
	}
	// Output:
	// TEAM-123
	// OPS-456
}

func TestFindReferences(t *testing.T) {
	tests := []struct {
		name string
		text string
		want []string
	}{
		{"empty", "", []string{}},
		{"none", "Nothing to see here", []string{}},
		{"entire text", "TEAM-123", []string{"TEAM-123"}},
		{"start of title", "TEAM-123: Fix login", []string{"TEAM-123"}},
		{"end of title", "Fix login for TEAM-123", []string{"TEAM-123"}},
		{"title", "[TEAM-123] Fix login", []string{"TEAM-123"}},
		{"conventional commit title", "fix(TEAM-123): login", []string{"TEAM-123"}},
		{"multiple title references", "[TEAM-123, OPS-456] Fix login", []string{"TEAM-123", "OPS-456"}},
		{"branch", "feature/TEAM-123-fix-login", []string{"TEAM-123"}},
		{"branch without prefix", "TEAM-123-fix-login", []string{"TEAM-123"}},
		{"nested branch", "matt/bugfix/TEAM-123/fix-login", []string{"TEAM-123"}},
		{"underscore separators", "feature_TEAM-123_fix", []string{"TEAM-123"}},
		{"adjacent branch references", "feature/TEAM-123-OPS-456-fix", []string{"TEAM-123", "OPS-456"}},
		{"multiple adjacent", "AB-1,CD-2;EF-3/AB-1", []string{"AB-1", "CD-2", "EF-3"}},
		{"first-seen order", "ZZ-9 AB-1 ZZ-9 CD-2 AB-1", []string{"ZZ-9", "AB-1", "CD-2"}},
		{"multiline", "Fix login\n\nRelates to TEAM-123 and OPS-456", []string{"TEAM-123", "OPS-456"}},
		{"URL", "https://example.atlassian.net/browse/TEAM-123", []string{"TEAM-123"}},
		{"digits in project", "A2-45 TEAM2-123", []string{"A2-45", "TEAM2-123"}},
		{"zeroes inside project key", "A0-1 TEAM00-123", []string{"A0-1", "TEAM00-123"}},
		{"zeroes inside issue number", "TEAM-10 TEAM-1001", []string{"TEAM-10", "TEAM-1001"}},
		{"large issue number is preserved as text", "TEAM-900719925474099312345", []string{"TEAM-900719925474099312345"}},
		{"uppercase prefix and trailing digits belong to the full key", "XTEAM-123 TEAM-1230", []string{"XTEAM-123", "TEAM-1230"}},
		{"valid reference after invalid candidates", "A-1 TEAM-012 TEAM-123suffix OPS-4", []string{"OPS-4"}},
		{"Unicode separators", "✨TEAM-123—OPS-456", []string{"TEAM-123", "OPS-456"}},
		{"incident is not Jira", "INC123456", []string{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := jira.FindReferences(tt.text); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("FindReferences(%q) = %#v, want %#v", tt.text, got, tt.want)
			}
		})
	}
}

func TestProjectKeyLength(t *testing.T) {
	for _, length := range []int{2, 10, 11, 254, 255} {
		t.Run(fmt.Sprintf("accepts %d characters", length), func(t *testing.T) {
			reference := strings.Repeat("A", length) + "-123"
			if got := jira.FindReferences(reference); !reflect.DeepEqual(got, []string{reference}) {
				t.Fatalf("FindReferences(%q) = %#v, want the complete reference", reference, got)
			}
		})
	}
	for _, length := range []int{256, 300} {
		t.Run(fmt.Sprintf("rejects %d characters without matching suffix", length), func(t *testing.T) {
			reference := strings.Repeat("A", length) + "-123"
			if got := jira.FindReferences(reference); !reflect.DeepEqual(got, []string{}) {
				t.Fatalf("FindReferences(%q) = %#v, want no matches", reference, got)
			}
			if got := jira.FindReferences("feature/" + reference + "-OPS-4"); !reflect.DeepEqual(got, []string{"OPS-4"}) {
				t.Fatalf("reference after overlong key = %#v, want OPS-4", got)
			}
		})
	}
	t.Run("digits count toward length", func(t *testing.T) {
		reference := "A" + strings.Repeat("0", 254) + "-1"
		if got := jira.FindReferences(reference); !reflect.DeepEqual(got, []string{reference}) {
			t.Fatalf("FindReferences(%q) = %#v, want the complete reference", reference, got)
		}
		if got := jira.FindReferences("A" + strings.Repeat("0", 255) + "-1"); !reflect.DeepEqual(got, []string{}) {
			t.Fatalf("overlong key containing digits = %#v, want no matches", got)
		}
	})
}

func TestInvalidReferences(t *testing.T) {
	for _, text := range []string{
		"A-1", "-123", "0TEAM-123", "2TEAM-123", "123-456",
		"team-123", "Team-123", "tEAM-123",
		"TEAM-0", "TEAM-00", "TEAM-01", "TEAM-0123",
		"TEAM-", "TEAM--123", "TEAM-+123", "TEAM -123", "TEAM- 123",
		"TEAM–123", "TEAM−123", "TEAM-１２３", "TEAM-١٢٣",
		"prefixTEAM-123", "TEAM-123suffix", "TEAM-123ABC",
	} {
		t.Run(text, func(t *testing.T) {
			if got := jira.FindReferences(text); !reflect.DeepEqual(got, []string{}) {
				t.Fatalf("FindReferences(%q) = %#v, want no matches", text, got)
			}
		})
	}
}

func TestUnicodeAdjacentLettersAndNumbers(t *testing.T) {
	// Unicode Number includes Roman numerals and superscripts, not only digits.
	for _, adjacent := range []string{"a", "é", "漢", "１", "٢", "𝒜", "Ⅳ", "²"} {
		t.Run(adjacent, func(t *testing.T) {
			for _, text := range []string{adjacent + "TEAM-123", "TEAM-123" + adjacent} {
				if got := jira.FindReferences(text); !reflect.DeepEqual(got, []string{}) {
					t.Fatalf("FindReferences(%q) = %#v, want no matches", text, got)
				}
			}
		})
	}
}

func TestReferenceSeparators(t *testing.T) {
	for _, separator := range []string{" ", "\t", "\n", "\r\n", "/", "-", "_", ".", ",", ":", "#", "—", "✨"} {
		t.Run(fmt.Sprintf("%q", separator), func(t *testing.T) {
			text := separator + "TEAM-123" + separator + "OPS-4" + separator
			if got := jira.FindReferences(text); !reflect.DeepEqual(got, []string{"TEAM-123", "OPS-4"}) {
				t.Fatalf("FindReferences(%q) = %#v, want TEAM-123 and OPS-4", text, got)
			}
		})
	}
}

func TestReferencesAreIndependent(t *testing.T) {
	first := jira.FindReferences("TEAM-123 OPS-456 TEAM-123")
	first[0] = "EXTRA-1"
	if got := jira.FindReferences("No reference"); !reflect.DeepEqual(got, []string{}) {
		t.Fatalf("no reference = %#v, want an empty non-nil slice", got)
	}
	if got := jira.FindReferences("TEAM-123 OPS-456 TEAM-123"); !reflect.DeepEqual(got, []string{"TEAM-123", "OPS-456"}) {
		t.Fatalf("repeated call = %#v, want original references", got)
	}
}
