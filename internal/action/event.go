// Package action checks GitHub pull request traceability and runs the action.
package action

// Event contains only the GitHub webhook fields used by this action.
type Event struct {
	Action      string       `json:"action"`
	PullRequest *PullRequest `json:"pull_request"`
	Repository  struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
}

type PullRequest struct {
	Number  int64  `json:"number"`
	Title   string `json:"title"`
	HTMLURL string `json:"html_url"`
	User    struct {
		Type  string `json:"type"`
		Login string `json:"login"`
	} `json:"user"`
	Labels []struct {
		Name string `json:"name"`
	} `json:"labels"`
	Head struct {
		Ref string `json:"ref"`
	} `json:"head"`
}

type Result struct {
	Status     string
	Reason     string
	References []string
}

// Inputs uses strings so omitted and malformed action settings keep their
// existing defaults and fallback behavior.
type Inputs struct {
	ProjectKeys string
	JiraSecret  string
	JiraURL     string
	RemoteLinks string
	Components  string
}
