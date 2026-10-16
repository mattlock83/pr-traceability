// Package jira provides the Jira Cloud operations used by the action.
package jira

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

const missingIssueMessage = "Issue does not exist or you do not have permission to see it."

// Issue contains validation and component metadata. A nil Components slice means
// Jira did not return usable component metadata; an empty slice is valid.
type Issue struct {
	StatusCategory string
	Project        string
	Components     []Component
}

// Client authenticates with an email and API token against Jira Cloud REST v3.
// Calls are sequential; component results are shared across issues in each run.
type Client struct {
	endpoint      string
	authorization string
	redactions    []string
	http          *http.Client
	log           func(string)
	components    map[string]componentResult
}

// New reads the JSON secret and uses baseURL when supplied, otherwise the
// secret's baseUrl. The supplied HTTP client is copied and redirects disabled.
func New(secret, baseURL string, httpClient *http.Client, log func(string)) (*Client, error) {
	var config struct {
		Email    string `json:"email"`
		APIToken string `json:"apiToken"`
		BaseURL  string `json:"baseUrl"`
	}
	invalid := errors.New("Invalid Jira URL or credentials")
	if json.Unmarshal([]byte(secret), &config) != nil || !nonempty(config.Email) || strings.Contains(config.Email, ":") || !nonempty(config.APIToken) {
		return nil, invalid
	}
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		baseURL = strings.TrimSpace(config.BaseURL)
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return nil, invalid
	}
	client := http.Client{}
	if httpClient != nil {
		client = *httpClient
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if log == nil {
		log = func(string) {}
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(config.Email + ":" + config.APIToken))
	return &Client{
		endpoint:      strings.TrimRight(parsed.String(), "/") + "/rest/api/3",
		authorization: "Basic " + encoded,
		redactions:    []string{secret, encoded, config.APIToken, config.Email},
		http:          &client,
		log:           log,
		components:    make(map[string]componentResult),
	}, nil
}

func nonempty(value string) bool { return strings.TrimSpace(value) != "" }

var errRequest = errors.New("Jira request failed or returned an invalid response")

func (c *Client) request(ctx context.Context, method, path string, body any, statuses ...int) (status int, data json.RawMessage, err error) {
	detail := "Response body unavailable"
	defer func() {
		if err != nil || status < 200 || status >= 300 {
			c.logResponseFailure(method, path, status, detail)
		}
	}()
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, nil, errRequest
		}
		payload = bytes.NewReader(encoded)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if ctx.Err() != nil {
		return 0, nil, errRequest
	}
	request, err := http.NewRequestWithContext(ctx, method, c.endpoint+path, payload)
	if err != nil {
		return 0, nil, errRequest
	}
	request.Header.Set("Authorization", c.authorization)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept-Language", "en-US")
	request.Header.Set("X-Force-Accept-Language", "true")
	response, err := c.http.Do(request)
	if err != nil {
		return 0, nil, errRequest
	}
	defer response.Body.Close()
	status = response.StatusCode
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return status, nil, errRequest
	}
	detail = string(responseBody)
	if !slices.Contains(statuses, status) {
		return status, nil, errRequest
	}
	if status == http.StatusNoContent {
		return status, nil, nil
	}
	if !json.Valid(responseBody) {
		return status, nil, errRequest
	}
	return status, responseBody, nil
}

func (c *Client) logResponseFailure(method, path string, status int, detail string) {
	for _, value := range c.redactions {
		detail = strings.ReplaceAll(detail, value, "[REDACTED]")
	}
	var quoted bytes.Buffer
	encoder := json.NewEncoder(&quoted)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(detail)
	code := "request failed"
	if status != 0 {
		code = strconv.Itoa(status)
	}
	c.log(fmt.Sprintf("Jira %s %s: %s; body: %s", method, path, code, strings.TrimSuffix(quoted.String(), "\n")))
}

// GetIssue returns nil for Jira's canonical missing-or-inaccessible response.
// Other request failures and malformed responses return a sanitized error.
func (c *Client) GetIssue(ctx context.Context, reference string) (*Issue, error) {
	status, data, err := c.request(ctx, http.MethodGet, "/issue/"+url.PathEscape(reference)+"?fields=status,project,components", nil, 200, 404)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		var response struct {
			ErrorMessages []json.RawMessage `json:"errorMessages"`
		}
		if json.Unmarshal(data, &response) == nil {
			for _, raw := range response.ErrorMessages {
				var message string
				if json.Unmarshal(raw, &message) == nil && message == missingIssueMessage {
					return nil, nil
				}
			}
		}
		return nil, errors.New("Unrecognized Jira issue-not-found response")
	}
	var response struct {
		Fields struct {
			Status struct {
				StatusCategory struct {
					Key string `json:"key"`
				} `json:"statusCategory"`
			} `json:"status"`
			Project    json.RawMessage `json:"project"`
			Components json.RawMessage `json:"components"`
		} `json:"fields"`
	}
	err = json.Unmarshal(data, &response)
	category := response.Fields.Status.StatusCategory.Key
	if err != nil || category != "new" && category != "indeterminate" && category != "done" {
		return nil, errors.New("Jira response is missing a recognized status category")
	}
	issue := &Issue{StatusCategory: category}
	c.readComponentMetadata(issue, response.Fields.Project, response.Fields.Components)
	return issue, nil
}

var pullRequestPath = regexp.MustCompile(`^/([^/]+)/([^/]+)/pull/([1-9][0-9]*)/?$`)

// UpsertPullRequestLink uses org/repo/number as the stable remote link identity.
func (c *Client) UpsertPullRequestLink(ctx context.Context, reference, prURL string, prNumber int64, prTitle string) error {
	parsed, err := url.Parse(prURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || prNumber <= 0 {
		return errors.New("Invalid pull request link")
	}
	match := pullRequestPath.FindStringSubmatch(parsed.EscapedPath())
	if match == nil || match[3] != strconv.FormatInt(prNumber, 10) {
		return errors.New("Invalid pull request link")
	}
	body := map[string]any{
		"globalId":     match[1] + "/" + match[2] + "/" + match[3],
		"application":  map[string]string{"type": "net.phrond.pr-traceability", "name": "GitHub"},
		"relationship": "implemented by",
		"object":       map[string]string{"url": parsed.String(), "title": fmt.Sprintf("PR #%d: %s", prNumber, prTitle)},
	}
	_, _, err = c.request(ctx, http.MethodPost, "/issue/"+url.PathEscape(reference)+"/remotelink", body, 200, 201)
	return err
}
