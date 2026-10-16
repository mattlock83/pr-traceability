package action

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// Run reads GitHub's event and input environment, checks traceability, and
// appends outputs only after success. Dependencies are explicit for offline tests.
func Run(ctx context.Context, env func(string) string, log io.Writer, httpClient *http.Client) (Result, error) {
	if name := env("GITHUB_EVENT_NAME"); name != "pull_request" && name != "pull_request_target" {
		return Result{}, errors.New("This action requires a pull_request or pull_request_target event")
	}
	data, err := os.ReadFile(env("GITHUB_EVENT_PATH"))
	if err != nil {
		return Result{}, errors.New("Cannot read GITHUB_EVENT_PATH")
	}
	var event Event
	if err := json.Unmarshal(data, &event); err != nil {
		return Result{}, errors.New("Cannot decode pull request event")
	}
	inputs := Inputs{
		ProjectKeys: env("INPUT_PROJECT-KEYS"),
		JiraSecret:  env("INPUT_JIRA-SECRET"),
		JiraURL:     env("INPUT_JIRA-URL"),
		RemoteLinks: env("INPUT_JIRA-REMOTE-LINKS"),
		Components:  env("INPUT_JIRA-COMPONENTS"),
	}
	result, err := Check(event, inputs.ProjectKeys)
	if err != nil {
		return Result{}, err
	}
	result, err = ApplyJira(ctx, result, event, inputs, httpClient, func(message string) { fmt.Fprintln(log, message) })
	if err != nil {
		return Result{}, err
	}
	refs, _ := json.Marshal(result.References) // A slice of strings always marshals.
	if output := env("GITHUB_OUTPUT"); output != "" {
		file, err := os.OpenFile(output, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return Result{}, errors.New("Cannot write GITHUB_OUTPUT")
		}
		_, writeErr := fmt.Fprintf(file, "result=%s\njira-references=%s\n", result.Status, refs)
		closeErr := file.Close()
		if writeErr != nil || closeErr != nil {
			return Result{}, errors.New("Cannot write GITHUB_OUTPUT")
		}
	}
	fmt.Fprintf(log, "%s: %s\nJira references: %s\n", result.Status, result.Reason, refs)
	return result, nil
}

// EscapeAnnotation prevents an error message from injecting workflow commands.
func EscapeAnnotation(message string) string {
	return strings.NewReplacer("%", "%25", "\r", "%0D", "\n", "%0A").Replace(message)
}
