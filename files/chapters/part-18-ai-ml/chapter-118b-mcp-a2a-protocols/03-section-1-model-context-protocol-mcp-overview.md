## 118B.2 Model Context Protocol (MCP) Overview

MCP is an open standard that defines how AI models communicate with external tools, data sources, and services. It replaces ad-hoc function calling with a standardized protocol.

> **Pinned to MCP revision `2025-11-25`.** MCP revisions are date strings and the protocol has already made breaking changes between them. The types and method names below follow that revision. Before writing production code, check the current specification at modelcontextprotocol.io, and consider the official Go SDK (`github.com/modelcontextprotocol/go-sdk`) rather than hand-rolling the wire format: this section builds it by hand because understanding the protocol is the point, not because you should reimplement it.

### 1.1 MCP Architecture

MCP uses JSON-RPC 2.0 as its wire format, with a `method` field that dispatches to methods like `tools/call`, `resources/read`, and `prompts/get`. Note these are JSON-RPC method names, not URL paths: over Streamable HTTP every message is a POST to a single endpoint, and over stdio there are no URLs at all.

The types below mirror the specification's schema closely enough that `encoding/json` produces the right wire format without custom marshalers.

```go
package mcp

// MCP Core Types - matches the MCP JSON-RPC specification

// Request is a JSON-RPC 2.0 request
type Request struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      any `json:"id"`
	Method  string      `json:"method"`
	Params  any `json:"params,omitempty"`
}

// Response is a JSON-RPC 2.0 response
type Response struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      any `json:"id"`
	Result  any `json:"result,omitempty"`
	Error   *RPCError   `json:"error,omitempty"`
}

type RPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    any `json:"data,omitempty"`
}

// JSON-RPC 2.0 standard error codes, plus MCP's own.
//
// Note the range: -32768 to -32000 is reserved by JSON-RPC, and MCP's
// implementation-defined codes such as -32002 live inside the
// server-error band. Do not invent codes outside these ranges.
const (
	ErrParse          = -32700
	ErrInvalidRequest = -32600
	ErrMethodNotFound = -32601
	ErrInvalidParams  = -32602
	ErrInternal       = -32603
	ErrNotInitialized = -32002
)

// ProtocolVersion is the MCP revision this server implements.
//
// Revisions are dates, not semver, and the client proposes its own during
// initialize. The server must reply with a version it actually supports:
// echoing back whatever the client asked for is a protocol violation that
// promises capabilities the server may not have.
const ProtocolVersion = "2025-11-25"

// SupportedVersions are the revisions this server can speak, newest first.
var SupportedVersions = []string{"2025-11-25", "2025-06-18"}

// Tool represents an MCP tool capability
type Tool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema InputSchema `json:"inputSchema"`
}

type InputSchema struct {
	Type       string              `json:"type"`
	Properties map[string]Property `json:"properties"`
	Required   []string            `json:"required,omitempty"`
}

type Property struct {
	Type        string      `json:"type"`
	Description string      `json:"description"`
	Enum        []string    `json:"enum,omitempty"`
	Default     any `json:"default,omitempty"`
}

// ToolResult is returned after tool execution
type ToolResult struct {
	Content []ContentItem `json:"content"`
	IsError bool          `json:"isError,omitempty"`
}

type ContentItem struct {
	Type     string `json:"type"` // "text", "image", "resource"
	Text     string `json:"text,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	Data     string `json:"data,omitempty"` // base64 for images
	URI      string `json:"uri,omitempty"`  // for resources
}

// Resource represents an MCP resource (data source)
type Resource struct {
	URI         string `json:"uri"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}

// Prompt represents an MCP prompt template
type Prompt struct {
	Name        string           `json:"name"`
	Description string           `json:"description,omitempty"`
	Arguments   []PromptArgument `json:"arguments,omitempty"`
}

type PromptArgument struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Required    bool   `json:"required,omitempty"`
}

// ServerCapabilities declares what the MCP server supports
type ServerCapabilities struct {
	Tools     *ToolsCapability     `json:"tools,omitempty"`
	Resources *ResourceCapability  `json:"resources,omitempty"`
	Prompts   *PromptsCapability   `json:"prompts,omitempty"`
	Logging   *LoggingCapability   `json:"logging,omitempty"`
}

type ToolsCapability struct {
	ListChanged bool `json:"listChanged,omitempty"`
}

type ResourceCapability struct {
	Subscribe   bool `json:"subscribe,omitempty"`
	ListChanged bool `json:"listChanged,omitempty"`
}

type PromptsCapability struct {
	ListChanged bool `json:"listChanged,omitempty"`
}

type LoggingCapability struct{}
```

### 1.2 MCP Server Implementation

An MCP server registers tools, resources, and prompts in a capability map and dispatches incoming JSON-RPC requests to the corresponding handler by method name. Each tool handler receives a typed argument map, validates the required parameters, executes the operation, and returns either a `ContentBlock` result or a structured error with an MCP error code.

```go
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sync"
)

// ToolHandler is the function signature for tool handlers
type ToolHandler func(ctx context.Context, params map[string]any) (*ToolResult, error)

// ResourceHandler returns the content of a resource
type ResourceHandler func(ctx context.Context, uri string) (*ResourceContent, error)

type ResourceContent struct {
	URI      string `json:"uri"`
	MimeType string `json:"mimeType,omitempty"`
	Text     string `json:"text,omitempty"`
	Blob     string `json:"blob,omitempty"` // base64
}

// Server is the MCP server
type Server struct {
	name    string
	version string
	logger  *slog.Logger

	mu              sync.RWMutex
	tools           map[string]*Tool
	toolHandlers    map[string]ToolHandler
	resources       map[string]*Resource
	resourceHandlers map[string]ResourceHandler
	prompts         map[string]*Prompt
	promptHandlers  map[string]func(context.Context, map[string]string) ([]Message, error)

	initialized bool
}

type Message struct {
	Role    string        `json:"role"` // "user" or "assistant"
	Content []ContentItem `json:"content"`
}

// NewServer creates a new MCP server.
//
// The logger writes to stderr, deliberately. Under the stdio transport stdout
// is the MCP message stream, so a logger that defaults to stdout silently
// interleaves log lines with protocol frames and breaks the session. This is
// the most common way a first MCP server fails, and the symptom (client says
// the server sent invalid JSON) points nowhere near the cause.
func NewServer(name, version string) *Server {
	return &Server{
		name:             name,
		version:          version,
		logger:           slog.New(slog.NewJSONHandler(os.Stderr, nil)),
		tools:            make(map[string]*Tool),
		toolHandlers:     make(map[string]ToolHandler),
		resources:        make(map[string]*Resource),
		resourceHandlers: make(map[string]ResourceHandler),
		prompts:          make(map[string]*Prompt),
		promptHandlers:   make(map[string]func(context.Context, map[string]string) ([]Message, error)),
	}
}

// RegisterTool registers a tool with its handler
func (s *Server) RegisterTool(tool Tool, handler ToolHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tools[tool.Name] = &tool
	s.toolHandlers[tool.Name] = handler
}

// RegisterResource registers a resource with its handler
func (s *Server) RegisterResource(resource Resource, handler ResourceHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.resources[resource.URI] = &resource
	s.resourceHandlers[resource.URI] = handler
}

// ServeStdio runs the MCP server over stdio (for local/subprocess mode).
//
// Three rules of the stdio transport are enforced here, and each is easy to
// break by accident:
//
//  1. stdout carries MCP messages and nothing else. Not a stray fmt.Println,
//     not a debug print, not a "null". Anything else corrupts the stream and
//     the client's parser gives up on a message it cannot attribute.
//  2. Diagnostics go to stderr, which the client may capture or ignore. This
//     is why the logger below must never be pointed at stdout.
//  3. Messages are newline-delimited and must not contain embedded newlines.
//     json.Encoder.Encode appends the newline and emits compact JSON, so it
//     satisfies this. An indented encoder would not.
func (s *Server) ServeStdio(ctx context.Context) error {
	scanner := bufio.NewScanner(os.Stdin)

	// Raise the line limit. bufio.Scanner defaults to a 64KB maximum token and
	// returns bufio.ErrTooLong beyond it. MCP messages routinely exceed that:
	// a tools/list response for a rich server, or a resources/read carrying a
	// base64 blob, will both blow past 64KB. The failure looks like the client
	// disconnecting mid-session for no reason.
	const maxMessage = 16 << 20 // 16MB
	scanner.Buffer(make([]byte, 0, 64*1024), maxMessage)

	encoder := json.NewEncoder(os.Stdout)

	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}

		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			s.sendError(encoder, nil, ErrParse, "Parse error", err.Error())
			continue
		}

		resp := s.handleRequest(ctx, &req)

		// A notification produces no response. Returning early is essential:
		// encoder.Encode(nil) writes the four bytes "null" to stdout, which is
		// not a valid MCP message, and the client will either error or resync
		// unpredictably. A typed nil *Response is also non-nil inside an
		// interface, so check the concrete pointer, not an any.
		if resp == nil {
			continue
		}

		if err := encoder.Encode(resp); err != nil {
			s.logger.Error("failed to encode response", "error", err)
		}
	}

	return scanner.Err()
}

// HandleRequest dispatches one JSON-RPC message and returns the response, or
// nil if the message was a notification. It is exported so transports other
// than stdio (see Section 118B.3) can reuse the same dispatcher: the protocol logic
// is transport-agnostic and should live in exactly one place.
func (s *Server) HandleRequest(ctx context.Context, req *Request) *Response {
	return s.handleRequest(ctx, req)
}

func (s *Server) handleRequest(ctx context.Context, req *Request) *Response {
	switch req.Method {
	case "initialize":
		return s.handleInitialize(req)

	// The notification is "notifications/initialized", NOT "initialized".
	// Every MCP notification is namespaced under notifications/, and a server
	// matching the bare name silently never marks itself initialized: the
	// message falls through to the default branch, and because a notification
	// carries no id there is nobody to return the method-not-found error to.
	// The handshake appears to hang for no visible reason.
	case "notifications/initialized":
		s.mu.Lock()
		s.initialized = true
		s.mu.Unlock()
		return nil // notification, no response

	case "notifications/cancelled":
		return nil // notification, no response

	case "ping":
		// Required by the spec: reply with an empty result.
		return &Response{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{}}

	case "tools/list":
		return s.handleToolsList(req)
	case "tools/call":
		return s.handleToolsCall(ctx, req)
	case "resources/list":
		return s.handleResourcesList(req)
	case "resources/read":
		return s.handleResourcesRead(ctx, req)
	case "prompts/list":
		return s.handlePromptsList(req)
	case "prompts/get":
		return s.handlePromptsGet(ctx, req)
	default:
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error: &RPCError{
				Code:    ErrMethodNotFound,
				Message: fmt.Sprintf("method not found: %s", req.Method),
			},
		}
	}
}

// handleInitialize performs version negotiation.
//
// The client proposes a protocolVersion - the server answers with one it
// actually supports. If it supports the client's proposal, it echoes it. If
// not, it responds with its own latest, and the client then decides whether to
// continue or disconnect. Hardcoding a version and ignoring the request, as an
// earlier draft of this code did, means a client asking for 2025-11-25 is told
// it is talking to a 2024-11-05 server, and capability negotiation proceeds on
// a false premise.
func (s *Server) handleInitialize(req *Request) *Response {
	negotiated := ProtocolVersion

	if params, ok := req.Params.(map[string]any); ok {
		if requested, ok := params["protocolVersion"].(string); ok {
			for _, v := range SupportedVersions {
				if v == requested {
					negotiated = requested
					break
				}
			}
		}
	}

	return &Response{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result: map[string]any{
			"protocolVersion": negotiated,
			"serverInfo": map[string]string{
				"name":    s.name,
				"version": s.version,
			},
			// Declare only what is actually implemented. A capability
			// advertised here is a promise: a client that sees "prompts" will
			// call prompts/list, and a server with no prompts registered has
			// just invited an error.
			"capabilities": ServerCapabilities{
				Tools:     &ToolsCapability{},
				Resources: &ResourceCapability{},
				Prompts:   &PromptsCapability{},
			},
		},
	}
}

func (s *Server) handleToolsList(req *Request) *Response {
	s.mu.RLock()
	defer s.mu.RUnlock()

	tools := make([]*Tool, 0, len(s.tools))
	for _, t := range s.tools {
		tools = append(tools, t)
	}

	return &Response{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  map[string]any{"tools": tools},
	}
}

func (s *Server) handleToolsCall(ctx context.Context, req *Request) *Response {
	params, ok := req.Params.(map[string]any)
	if !ok {
		return s.errorResponse(req.ID, ErrInvalidParams, "invalid params")
	}

	name, _ := params["name"].(string)
	args, _ := params["arguments"].(map[string]any)

	s.mu.RLock()
	handler, exists := s.toolHandlers[name]
	s.mu.RUnlock()

	if !exists {
		return s.errorResponse(req.ID, ErrInvalidParams, fmt.Sprintf("tool not found: %s", name))
	}

	result, err := handler(ctx, args)
	if err != nil {
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: &ToolResult{
				Content: []ContentItem{{Type: "text", Text: err.Error()}},
				IsError: true,
			},
		}
	}

	return &Response{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  result,
	}
}

func (s *Server) handleResourcesList(req *Request) *Response {
	s.mu.RLock()
	defer s.mu.RUnlock()

	resources := make([]*Resource, 0, len(s.resources))
	for _, r := range s.resources {
		resources = append(resources, r)
	}

	return &Response{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  map[string]any{"resources": resources},
	}
}

func (s *Server) handleResourcesRead(ctx context.Context, req *Request) *Response {
	params, ok := req.Params.(map[string]any)
	if !ok {
		return s.errorResponse(req.ID, ErrInvalidParams, "invalid params")
	}

	uri, _ := params["uri"].(string)

	s.mu.RLock()
	handler, exists := s.resourceHandlers[uri]
	s.mu.RUnlock()

	if !exists {
		return s.errorResponse(req.ID, ErrInvalidParams, fmt.Sprintf("resource not found: %s", uri))
	}

	content, err := handler(ctx, uri)
	if err != nil {
		return s.errorResponse(req.ID, ErrInternal, err.Error())
	}

	return &Response{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  map[string]any{"contents": []*ResourceContent{content}},
	}
}

func (s *Server) handlePromptsList(req *Request) *Response {
	s.mu.RLock()
	defer s.mu.RUnlock()

	prompts := make([]*Prompt, 0, len(s.prompts))
	for _, p := range s.prompts {
		prompts = append(prompts, p)
	}

	return &Response{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  map[string]any{"prompts": prompts},
	}
}

func (s *Server) handlePromptsGet(ctx context.Context, req *Request) *Response {
	params, ok := req.Params.(map[string]any)
	if !ok {
		return s.errorResponse(req.ID, ErrInvalidParams, "invalid params")
	}

	name, _ := params["name"].(string)
	args, _ := params["arguments"].(map[string]any)

	stringArgs := make(map[string]string)
	for k, v := range args {
		stringArgs[k] = fmt.Sprintf("%v", v)
	}

	s.mu.RLock()
	handler, exists := s.promptHandlers[name]
	s.mu.RUnlock()

	if !exists {
		return s.errorResponse(req.ID, ErrInvalidParams, fmt.Sprintf("prompt not found: %s", name))
	}

	messages, err := handler(ctx, stringArgs)
	if err != nil {
		return s.errorResponse(req.ID, ErrInternal, err.Error())
	}

	return &Response{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  map[string]any{"messages": messages},
	}
}

func (s *Server) sendError(enc *json.Encoder, id any, code int, msg, data string) {
	resp := &Response{
		JSONRPC: "2.0",
		ID:      id,
		Error: &RPCError{
			Code:    code,
			Message: msg,
			Data:    data,
		},
	}
	enc.Encode(resp)
}

func (s *Server) errorResponse(id any, code int, msg string) *Response {
	return &Response{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &RPCError{Code: code, Message: msg},
	}
}

```

### 1.3 Real-World MCP Server: Database + Filesystem Tools

This example implements an MCP server that exposes database queries and filesystem operations as tools.

Be precise about what secures it, because the obvious description is wrong. This server does **not** use parameterized queries and cannot: the model writes the query *structure*, and placeholders only parameterize values. The security boundary is therefore the database itself. Give this server a connection whose PostgreSQL role holds `SELECT` and nothing else, on only the tables you mean to expose, and run each query in a read-only transaction. Then a write is refused by the server regardless of what the model emitted or what the Go-side checks missed.

The same applies to the filesystem tools: containment comes from resolving the path and comparing by path element, not from a prefix test on a string. Both patterns are covered in depth in Chapter 117, Section 4. Notice also that this server registers a `write_file` tool, which means it is not a read-only server, and that tool deserves the approval gate treatment rather than autonomous invocation.

```go
package mcpserver

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/yourorg/mcp"
)

// DatabaseMCPServer exposes database operations as MCP tools
type DatabaseMCPServer struct {
	server *mcp.Server
	db     *sql.DB
	fsRoot string
}

func NewDatabaseMCPServer(db *sql.DB, fsRoot string) *DatabaseMCPServer {
	s := &DatabaseMCPServer{
		server: mcp.NewServer("database-assistant", "1.0.0"),
		db:     db,
		fsRoot: fsRoot,
	}
	s.registerTools()
	s.registerResources()
	return s
}

func (s *DatabaseMCPServer) registerTools() {
	// SQL Query tool
	s.server.RegisterTool(mcp.Tool{
		Name:        "query_database",
		Description: "Execute a read-only SQL query and return results",
		InputSchema: mcp.InputSchema{
			Type: "object",
			Properties: map[string]mcp.Property{
				"sql": {
					Type:        "string",
					Description: "The SQL SELECT query to execute",
				},
				"limit": {
					Type:        "integer",
					Description: "Maximum rows to return (default: 100, max: 1000)",
				},
			},
			Required: []string{"sql"},
		},
	}, s.handleQueryDatabase)

	// List tables tool
	s.server.RegisterTool(mcp.Tool{
		Name:        "list_tables",
		Description: "List all tables in the database with their schemas",
		InputSchema: mcp.InputSchema{
			Type:       "object",
			Properties: map[string]mcp.Property{},
		},
	}, s.handleListTables)

	// Read file tool
	s.server.RegisterTool(mcp.Tool{
		Name:        "read_file",
		Description: "Read the contents of a file",
		InputSchema: mcp.InputSchema{
			Type: "object",
			Properties: map[string]mcp.Property{
				"path": {
					Type:        "string",
					Description: "Relative path to the file within the allowed directory",
				},
			},
			Required: []string{"path"},
		},
	}, s.handleReadFile)

	// Write file tool
	s.server.RegisterTool(mcp.Tool{
		Name:        "write_file",
		Description: "Write content to a file",
		InputSchema: mcp.InputSchema{
			Type: "object",
			Properties: map[string]mcp.Property{
				"path":    {Type: "string", Description: "File path"},
				"content": {Type: "string", Description: "Content to write"},
			},
			Required: []string{"path", "content"},
		},
	}, s.handleWriteFile)
}

func (s *DatabaseMCPServer) registerResources() {
	// Database schema as a resource
	s.server.RegisterResource(mcp.Resource{
		URI:         "db://schema",
		Name:        "Database Schema",
		Description: "Complete database schema with all tables and columns",
		MimeType:    "application/json",
	}, s.handleSchemaResource)
}

func (s *DatabaseMCPServer) handleQueryDatabase(ctx context.Context, params map[string]any) (*mcp.ToolResult, error) {
	query, _ := params["sql"].(string)
	limit := 100
	if l, ok := params["limit"].(float64); ok {
		limit = min(int(l), 1000)
	}

	// Sanity checks. These are not the security boundary (the read-only role
	// and the read-only transaction below are), but they catch obvious
	// mistakes and give the model a clearer error than the driver would.
	normalized := strings.TrimSpace(strings.ToUpper(query))
	if !strings.HasPrefix(normalized, "SELECT") && !strings.HasPrefix(normalized, "WITH") {
		return &mcp.ToolResult{
			Content: []mcp.ContentItem{{Type: "text", Text: "Only SELECT queries are allowed"}},
			IsError: true,
		}, nil
	}

	// Reject stacked statements. A prefix check alone is not enough:
	// "SELECT 1; DROP TABLE users" starts with SELECT and passes it happily.
	// A trailing semicolon is fine - anything after one is a second statement.
	trimmed := strings.TrimSpace(query)
	if i := strings.Index(trimmed, ";"); i != -1 && strings.TrimSpace(trimmed[i+1:]) != "" {
		return &mcp.ToolResult{
			Content: []mcp.ContentItem{{Type: "text", Text: "Multiple statements are not allowed"}},
			IsError: true,
		}, nil
	}
	query = strings.TrimRight(trimmed, ";")

	// Add LIMIT to prevent runaway queries
	if !strings.Contains(strings.ToUpper(query), "LIMIT") {
		query = fmt.Sprintf("%s LIMIT %d", query, limit)
	}

	// The actual boundary: a read-only transaction on a read-only role.
	// PostgreSQL refuses any write in here whatever the model wrote.
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, fmt.Errorf("begin read-only tx: %w", err)
	}
	defer tx.Rollback()

	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return &mcp.ToolResult{
			Content: []mcp.ContentItem{{Type: "text", Text: fmt.Sprintf("Query error: %v", err)}},
			IsError: true,
		}, nil
	}
	defer rows.Close()

	cols, _ := rows.Columns()
	var result strings.Builder
	result.WriteString(strings.Join(cols, "\t") + "\n")
	result.WriteString(strings.Repeat("-", 80) + "\n")

	values := make([]any, len(cols))
	valuePtrs := make([]any, len(cols))
	for i := range values {
		valuePtrs[i] = &values[i]
	}

	rowCount := 0
	for rows.Next() {
		// Check the Scan error. Ignoring it leaves values holding whatever it
		// held before, so a failed scan silently emits the previous row again.
		if err := rows.Scan(valuePtrs...); err != nil {
			return nil, fmt.Errorf("scan row %d: %w", rowCount, err)
		}
		parts := make([]string, len(cols))
		for i, v := range values {
			// []byte columns render as a list of numbers under %v, so convert
			// them to text first.
			if b, ok := v.([]byte); ok {
				parts[i] = string(b)
				continue
			}
			parts[i] = fmt.Sprintf("%v", v)
		}
		result.WriteString(strings.Join(parts, "\t") + "\n")
		rowCount++
	}

	// rows.Err reports failures that ended the iteration early. Without it, a
	// query that died halfway reports partial results as complete.
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("row iteration: %w", err)
	}

	result.WriteString(fmt.Sprintf("\n%d rows returned", rowCount))

	return &mcp.ToolResult{
		Content: []mcp.ContentItem{{Type: "text", Text: result.String()}},
	}, nil
}

func (s *DatabaseMCPServer) handleListTables(ctx context.Context, params map[string]any) (*mcp.ToolResult, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT table_name, column_name, data_type, is_nullable
		 FROM information_schema.columns
		 WHERE table_schema = 'public'
		 ORDER BY table_name, ordinal_position`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tables := make(map[string][]string)
	for rows.Next() {
		var tableName, columnName, dataType, isNullable string
		rows.Scan(&tableName, &columnName, &dataType, &isNullable)
		tables[tableName] = append(tables[tableName],
			fmt.Sprintf("  %s %s %s", columnName, dataType, isNullable))
	}

	var result strings.Builder
	for table, cols := range tables {
		result.WriteString(fmt.Sprintf("TABLE: %s\n", table))
		for _, col := range cols {
			result.WriteString(col + "\n")
		}
		result.WriteString("\n")
	}

	return &mcp.ToolResult{
		Content: []mcp.ContentItem{{Type: "text", Text: result.String()}},
	}, nil
}

// safePath resolves a client-supplied relative path against the server's root
// and confirms it stayed inside.
//
// It compares by path element via filepath.Rel rather than with
// strings.HasPrefix. The prefix test is the classic wrong answer: with a root
// of "/srv/data", the path "/srv/data-secrets/keys" has "/srv/data" as a
// string prefix and passes, despite being an entirely different directory. It
// also resolves symlinks first, since a link inside the root pointing outside
// it satisfies every purely lexical check.
func (s *DatabaseMCPServer) safePath(rel string) (string, error) {
	if filepath.IsAbs(rel) {
		return "", fmt.Errorf("path must be relative")
	}

	root, err := filepath.EvalSymlinks(s.fsRoot)
	if err != nil {
		return "", fmt.Errorf("resolve root: %w", err)
	}

	target, err := filepath.EvalSymlinks(filepath.Join(root, rel))
	if err != nil {
		// A file that does not exist yet is legitimate for write_file, so fall
		// back to checking the parent directory instead of rejecting outright.
		parent, perr := filepath.EvalSymlinks(filepath.Dir(filepath.Join(root, rel)))
		if perr != nil {
			return "", fmt.Errorf("resolve path: %w", err)
		}
		target = filepath.Join(parent, filepath.Base(rel))
	}

	r, err := filepath.Rel(root, target)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("access denied: path outside allowed directory")
	}
	return target, nil
}

func (s *DatabaseMCPServer) handleReadFile(ctx context.Context, params map[string]any) (*mcp.ToolResult, error) {
	path, _ := params["path"].(string)

	cleanPath, err := s.safePath(path)
	if err != nil {
		return &mcp.ToolResult{
			Content: []mcp.ContentItem{{Type: "text", Text: err.Error()}},
			IsError: true,
		}, nil
	}

	data, err := os.ReadFile(cleanPath)
	if err != nil {
		return &mcp.ToolResult{
			Content: []mcp.ContentItem{{Type: "text", Text: fmt.Sprintf("Error: %v", err)}},
			IsError: true,
		}, nil
	}

	return &mcp.ToolResult{
		Content: []mcp.ContentItem{{Type: "text", Text: string(data)}},
	}, nil
}

func (s *DatabaseMCPServer) handleWriteFile(ctx context.Context, params map[string]any) (*mcp.ToolResult, error) {
	path, _ := params["path"].(string)
	content, _ := params["content"].(string)

	cleanPath, err := s.safePath(path)
	if err != nil {
		return &mcp.ToolResult{
			Content: []mcp.ContentItem{{Type: "text", Text: err.Error()}},
			IsError: true,
		}, nil
	}

	// 0600, not 0644. This file's content came from a model, which got it from
	// a prompt, which may have come from a user. There is no reason for every
	// account on the host to be able to read it.
	if err := os.WriteFile(cleanPath, []byte(content), 0o600); err != nil {
		return nil, err
	}

	return &mcp.ToolResult{
		Content: []mcp.ContentItem{{Type: "text", Text: fmt.Sprintf("Written %d bytes to %s", len(content), path)}},
	}, nil
}

func (s *DatabaseMCPServer) handleSchemaResource(ctx context.Context, uri string) (*mcp.ResourceContent, error) {
	// Return database schema as JSON
	return &mcp.ResourceContent{
		URI:      uri,
		MimeType: "application/json",
		Text:     `{"tables": ["users", "orders", "products"]}`, // Simplified
	}, nil
}

func (s *DatabaseMCPServer) Serve(ctx context.Context) error {
	return s.server.ServeStdio(ctx)
}
```

---

### Junior → FAANG: MCP Server Implementation as Go Systems Interview Topic

Implementing an MCP server in Go is a concrete Go systems programming exercise that covers: JSON-RPC request parsing and routing, struct-based tool schema definitions with JSON serialization, context-aware request handling, and error response formatting. The Go implementation in this section demonstrates how an MCP server maps tool schemas to handler functions using a registry pattern (map from tool name to handler) and how JSON-RPC method dispatch works. Understanding this implementation at the code level, not just the concept level, is the technical depth required for FAANG Go systems interviews.

The tool schema definition pattern (InputSchema with type, properties, required fields) maps directly to OpenAPI schema definitions and JSON Schema, which are standard API contract formats. Engineers who understand JSON Schema can define MCP tool contracts precisely, which prevents runtime argument errors and enables client-side validation before calling the tool. Practice writing tool schemas for common tool types: a database query tool (SQL string, parameters as array), a web search tool (query string, max results), a file read tool (path string, encoding).

### Senior @ FAANG: MCP Server Design as Platform API Contract

At senior level, an MCP server is a platform API whose contract (tool schemas, error formats, authentication requirements) must be versioned, documented, and maintained with the same discipline as a public API. Breaking changes to a tool schema (removing a required field, changing a field's type) break every agent that uses that tool. The versioning strategy (version in the tool name like "query_database_v2", version in the URL path, or semantic versioning of the MCP server) must be decided at design time and applied consistently. Senior engineers who design MCP servers with API versioning as a first-class concern prevent the migration pain that occurs when tool schemas need to change after agents are in production.
