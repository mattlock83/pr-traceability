package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCommand(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "pr-traceability")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if output, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	var baseEnv []string
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		key = strings.ToUpper(key)
		if !strings.HasPrefix(key, "GITHUB_") && !strings.HasPrefix(key, "INPUT_") {
			baseEnv = append(baseEnv, entry)
		}
	}
	for _, tc := range []struct {
		name, pr, kind, projects, want string
		code                           int
	}{
		{"pass", `"title":"TEAM-123"`, "pull_request", "", "passed:", 0},
		{"skip bot", `"user":{"type":"Bot"}`, "pull_request", "", "skipped:", 0},
		{"missing reference", `"title":"Fix"`, "pull_request", "", "::error::No issue reference found", 1},
		{"unsupported event", `"title":"TEAM-1"`, "push", "", "::error::This action requires", 1},
		{"allowed project", `"title":"TEAM-123"`, "pull_request", "TEAM", "passed:", 0},
		{"unlisted project", `"title":"OTHER-123"`, "pull_request", "TEAM", "allowed project (TEAM)", 1},
		{"invalid projects", `"title":"TEAM-123"`, "pull_request", "TEAM,", "::error::Invalid project-keys", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			directory := t.TempDir()
			eventPath, outputPath := filepath.Join(directory, "event.json"), filepath.Join(directory, "outputs")
			if err := os.WriteFile(eventPath, []byte(`{"pull_request":{"number":42,`+tc.pr+`}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(binary)
			cmd.Env = append(append([]string{}, baseEnv...), "GITHUB_EVENT_NAME="+tc.kind, "GITHUB_EVENT_PATH="+eventPath, "GITHUB_OUTPUT="+outputPath, "INPUT_PROJECT-KEYS="+tc.projects)
			output, err := cmd.CombinedOutput()
			code := 0
			if err != nil {
				exit, ok := err.(*exec.ExitError)
				if !ok {
					t.Fatal(err)
				}
				code = exit.ExitCode()
			}
			if code != tc.code || !strings.Contains(string(output), tc.want) {
				t.Fatalf("exit %d, output %q; want exit %d containing %q", code, output, tc.code, tc.want)
			}
			outputs, err := os.ReadFile(outputPath)
			if code == 0 {
				if err != nil || !strings.Contains(string(outputs), "jira-references=") {
					t.Fatalf("missing success outputs: %q, %v", outputs, err)
				}
			} else if !os.IsNotExist(err) {
				t.Fatalf("failure wrote success outputs: %q, %v", outputs, err)
			}
		})
	}
}
