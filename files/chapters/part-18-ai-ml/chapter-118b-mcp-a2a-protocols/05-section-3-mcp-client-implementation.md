## 118B.4 MCP Client Implementation

The MCP client launches the server as a subprocess and communicates with it over stdin and stdout using JSON-RPC framing, so no network port is required for local tool use. A pending-request map keyed by request ID correlates incoming responses to the goroutine waiting on each call, allowing concurrent in-flight requests over the single stdio channel.

That correlation map is where this code has historically gone wrong, and the bug is worth studying because it is invisible in review and fatal at runtime. The client generates IDs as `int64`. The response arrives as JSON and decodes into an `any`, where every number becomes a **`float64`**. A map keyed by `any` therefore stores `int64(1)` and looks up `float64(1)`, and those are different keys: different dynamic types compare unequal regardless of numeric value. The lookup misses every time, no response is ever delivered, and every call blocks until its context deadline. Nothing errors, nothing logs, and the client simply appears to hang against a server that is replying perfectly.

The fix is to key the map on a concrete `int64` and normalize the incoming ID once, on the way in.

```go
package mcpclient

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Client connects to an MCP server
type Client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Scanner

	mu sync.Mutex
	// pending is keyed by int64, NOT by any. Keying it by any invites the
	// float64 mismatch described above, because the ID coming back off the
	// wire is a float64 and the ID going out is an int64.
	pending   map[int64]chan *MCPResponse
	closed    bool
	idCounter atomic.Int64
}

type MCPResponse struct {
	Result any
	Error  *RPCError
}

type RPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    any `json:"data,omitempty"`
}

// NewStdioClient spawns an MCP server subprocess
func NewStdioClient(command string, args ...string) (*Client, error) {
	cmd := exec.Command(command, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	// Same 64KB default as on the server side, same fix. A tools/list response
	// from a rich server exceeds it easily, and the failure surfaces as the
	// client mysteriously going quiet.
	scanner.Buffer(make([]byte, 0, 64*1024), 16<<20)

	c := &Client{
		cmd:     cmd,
		stdin:   stdin,
		stdout:  scanner,
		pending: make(map[int64]chan *MCPResponse),
	}

	go c.readLoop()
	return c, nil
}

// normalizeID converts a JSON-RPC id from the wire into an int64.
//
// encoding/json decodes every JSON number into an any as float64, so a
// response to request id 1 arrives as float64(1). JSON-RPC also permits string
// ids, which this client never sends but a nonconforming server might echo, so
// handle that too rather than dropping the response silently.
func normalizeID(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case int64:
		return n, true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	case string:
		i, err := strconv.ParseInt(n, 10, 64)
		return i, err == nil
	default:
		return 0, false
	}
}

func (c *Client) readLoop() {
	// Whatever ends this loop (server exit, closed pipe, read error), every
	// caller still waiting must be woken with an error. Without this, a
	// crashed server leaves every in-flight call blocked until its context
	// expires, and any call made afterwards blocks forever. The section text
	// below calls this out as required - the code has to actually do it.
	defer c.failAllPending(fmt.Errorf("mcp server connection closed"))

	for c.stdout.Scan() {
		line := c.stdout.Bytes()

		var resp struct {
			JSONRPC string    `json:"jsonrpc"`
			ID      any       `json:"id"`
			Result  any       `json:"result,omitempty"`
			Error   *RPCError `json:"error,omitempty"`
		}

		if err := json.Unmarshal(line, &resp); err != nil {
			continue
		}

		if resp.ID == nil {
			continue // notification
		}

		id, ok := normalizeID(resp.ID)
		if !ok {
			continue
		}

		c.mu.Lock()
		ch, found := c.pending[id]
		if found {
			delete(c.pending, id)
		}
		c.mu.Unlock()

		if found {
			ch <- &MCPResponse{Result: resp.Result, Error: resp.Error}
		}
	}
}

// failAllPending wakes every waiting caller with err and marks the client dead
// so later calls fail fast instead of blocking.
func (c *Client) failAllPending(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.closed = true
	for id, ch := range c.pending {
		// The channel is buffered with capacity 1 and each has exactly one
		// waiter, so this send cannot block even if the waiter has already
		// given up on its context.
		ch <- &MCPResponse{Error: &RPCError{Code: -32000, Message: err.Error()}}
		delete(c.pending, id)
	}
}

func (c *Client) call(ctx context.Context, method string, params any) (*MCPResponse, error) {
	id := c.idCounter.Add(1)
	ch := make(chan *MCPResponse, 1)

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, fmt.Errorf("client is closed")
	}
	c.pending[id] = ch
	c.mu.Unlock()

	req := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}

	data, err := json.Marshal(req)
	if err != nil {
		c.forget(id)
		return nil, err
	}

	c.mu.Lock()
	_, err = fmt.Fprintf(c.stdin, "%s\n", data)
	c.mu.Unlock()
	if err != nil {
		// Remove the pending entry on write failure. Leaving it behind leaks
		// an entry that nothing will ever resolve.
		c.forget(id)
		return nil, err
	}

	select {
	case resp := <-ch:
		return resp, nil
	case <-ctx.Done():
		c.forget(id)
		return nil, ctx.Err()
	}
}

func (c *Client) forget(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// ProtocolVersion is the MCP revision this client proposes.
const ProtocolVersion = "2025-11-25"

// Initialize performs the MCP handshake: initialize request, then the
// notifications/initialized notification.
func (c *Client) Initialize(ctx context.Context) error {
	resp, err := c.call(ctx, "initialize", map[string]any{
		"protocolVersion": ProtocolVersion,
		"clientInfo": map[string]string{
			"name":    "go-mcp-client",
			"version": "1.0.0",
		},
		"capabilities": map[string]any{},
	})
	if err != nil {
		return err
	}
	if resp.Error != nil {
		return fmt.Errorf("initialize error: %s", resp.Error.Message)
	}

	// Inspect the negotiated version. The server may answer with a revision
	// different from the one proposed, and the client then decides whether it
	// can speak that revision or should disconnect. Ignoring this field means
	// proceeding on assumptions the server never agreed to.
	if result, ok := resp.Result.(map[string]any); ok {
		if v, ok := result["protocolVersion"].(string); ok && v != ProtocolVersion {
			return fmt.Errorf("server negotiated unsupported protocol version %q (client speaks %q)",
				v, ProtocolVersion)
		}
	}

	// Send the initialized notification. The method name is
	// "notifications/initialized". Sending the bare "initialized" is a
	// protocol error: the server never leaves the initializing state, and
	// because a notification has no id there is no error to come back. The
	// session just stalls.
	data, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "notifications/initialized",
	})
	if err != nil {
		return err
	}

	c.mu.Lock()
	_, err = fmt.Fprintf(c.stdin, "%s\n", data)
	c.mu.Unlock()
	return err
}

// ListTools returns available tools
func (c *Client) ListTools(ctx context.Context) ([]map[string]any, error) {
	resp, err := c.call(ctx, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("%s", resp.Error.Message)
	}

	result, _ := resp.Result.(map[string]any)
	tools, _ := result["tools"].([]any)

	var result2 []map[string]any
	for _, t := range tools {
		if tm, ok := t.(map[string]any); ok {
			result2 = append(result2, tm)
		}
	}
	return result2, nil
}

// CallTool invokes an MCP tool
func (c *Client) CallTool(ctx context.Context, name string, args map[string]any) (*ToolResult, error) {
	resp, err := c.call(ctx, "tools/call", map[string]any{
		"name":      name,
		"arguments": args,
	})
	if err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("%s", resp.Error.Message)
	}

	data, _ := json.Marshal(resp.Result)
	var result ToolResult
	json.Unmarshal(data, &result)
	return &result, nil
}

type ToolResult struct {
	Content []ContentItem `json:"content"`
	IsError bool          `json:"isError"`
}

type ContentItem struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// Close shuts down the client and subprocess.
//
// Closing stdin asks the server to exit on its own, which is the polite path.
// The timer is the impolite one: a server that ignores EOF, or is wedged, would
// otherwise make cmd.Wait block forever and leak the process. Ask first, then
// insist.
func (c *Client) Close() error {
	c.stdin.Close()

	done := make(chan error, 1)
	go func() { done <- c.cmd.Wait() }()

	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		if err := c.cmd.Process.Kill(); err != nil {
			return fmt.Errorf("kill unresponsive mcp server: %w", err)
		}
		<-done
		return fmt.Errorf("mcp server did not exit on stdin close; killed")
	}
}
```

---

### Junior → FAANG: MCP Client as Concurrent Go Programming Exercise

The MCP client implementation demonstrates several concurrent Go programming patterns that appear in FAANG Go technical interviews: a pending-request map with a mutex for thread-safe access, response routing from a single reader goroutine to multiple waiting goroutines via channels, subprocess lifecycle management with stdin/stdout pipes, and JSON-RPC request-response correlation using IDs. Each of these patterns is individually a common interview topic. The MCP client puts them together into a coherent system.

The request-response correlation pattern (generate a request ID, store a channel in a pending map under that ID, read responses in a background goroutine and route them to the correct channel) is a fundamental concurrency pattern for any system that multiplexes requests over a single connection. It appears in Redis client implementations, database connection pools, HTTP/2 multiplexing, and gRPC client implementations. Implementing it once in the MCP client context builds the pattern fluency to recognize and implement it in other contexts.

The subprocess management aspect (launching a subprocess, communicating over stdin/stdout, handling subprocess exit) is a less common but important Go skill. Practice the cleanup path: what happens when the subprocess exits unexpectedly? The reader goroutine gets an EOF from the stdout pipe, which it must detect and signal to all pending requests so they return with an error rather than blocking forever. Implementing this cleanup path correctly is the difference between a resilient client and one that hangs when the server crashes.

### Senior @ FAANG: MCP Client as Platform SDK Component

At senior level, the MCP client is a platform SDK component that every agent in the organization uses to communicate with MCP tools. As a shared component, it must be designed with reliability, observability, and configurability as first-class requirements. Reliability: the client must handle subprocess crashes, restart the subprocess with exponential backoff, and drain the pending request map with errors when the subprocess is unavailable. Observability: the client must emit metrics for request latency, request count, error rate, and subprocess restart count so that the reliability of each MCP tool can be monitored in production. Configurability: timeout per tool call, maximum concurrent requests, subprocess restart policy, and logging level must be configurable without code changes. Building these properties into the platform SDK, rather than into each agent's custom client code, is the platform engineering approach that prevents each agent team from independently solving the same reliability problems.
