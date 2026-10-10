// internal/plugin/plugin.go
package plugin

import (
    "context"
    "net/http"
)

// Plugin is the interface that all plugins must implement
type Plugin interface {
    // Name returns the plugin name
    Name() string

    // Priority returns the execution priority (lower runs first)
    Priority() int

    // Init initializes the plugin with configuration
    Init(config map[string]any) error

    // ProcessRequest processes the request before proxying
    ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error)

    // ProcessResponse processes the response after proxying
    ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error)
}

// Phase represents the plugin execution phase
type Phase int

const (
    PhasePreRequest Phase = iota
    PhaseRequest
    PhasePostRequest
    PhasePreResponse
    PhaseResponse
    PhasePostResponse
)

// Result represents the result of plugin execution
type Result struct {
    ShouldContinue bool
    StatusCode     int
    Body           []byte
    Headers        http.Header
    Error          error
}

// Stop returns a result that stops the plugin chain
func Stop(statusCode int, body []byte) *Result {
    return &Result{
        ShouldContinue: false,
        StatusCode:     statusCode,
        Body:           body,
    }
}

// Continue returns a result that continues the plugin chain
func Continue() *Result {
    return &Result{
        ShouldContinue: true,
    }
}

// Error returns a result with an error
func Error(err error) *Result {
    return &Result{
        ShouldContinue: false,
        Error:          err,
    }
}
