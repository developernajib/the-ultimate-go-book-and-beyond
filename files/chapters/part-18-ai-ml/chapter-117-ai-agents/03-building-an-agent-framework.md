## 117.2 Building an Agent Framework

This section builds a production-ready agent framework from first principles.

### Core Agent Types

Start with the vocabulary. These types are the contract between the four moving parts of an agent: the conversation, the tools, the memory, and the model. Nothing here executes anything yet. The point is to fix the shape of a message, a tool call, and a tool result before writing the loop that passes them around, because the loop is trivial once these are right.

```go
// pkg/agent/types.go
package agent

import (
    "context"
    "time"
)

// Message represents a single message in the conversation
type Message struct {
    Role      string    `json:"role"`      // "user", "assistant", "system", "tool"
    Content   string    `json:"content"`
    ToolCalls []ToolCall `json:"tool_calls,omitempty"`
    ToolCallID string   `json:"tool_call_id,omitempty"`
    Timestamp time.Time `json:"timestamp"`
}

// ToolCall represents a request to execute a tool
type ToolCall struct {
    ID       string                 `json:"id"`
    Type     string                 `json:"type"` // "function"
    Function FunctionCall           `json:"function"`
}

// FunctionCall contains the function name and arguments
type FunctionCall struct {
    Name      string                 `json:"name"`
    Arguments map[string]any `json:"arguments"`
}

// ToolResult represents the result of tool execution
type ToolResult struct {
    ToolCallID string      `json:"tool_call_id"`
    Content    string      `json:"content"`
    Error      error       `json:"error,omitempty"`
    Metadata   any `json:"metadata,omitempty"`
}

// Tool defines the interface all agent tools must implement
type Tool interface {
    // Name returns the tool's unique identifier
    Name() string

    // Description returns a description for the LLM
    Description() string

    // Parameters returns JSON schema for tool parameters
    Parameters() map[string]any

    // Execute runs the tool with given arguments
    Execute(ctx context.Context, args map[string]any) (string, error)
}

// Memory provides storage for agent context
type Memory interface {
    // Add stores a message in memory
    Add(ctx context.Context, msg Message) error

    // GetRecent retrieves the N most recent messages
    GetRecent(ctx context.Context, n int) ([]Message, error)

    // Search performs semantic search over memory
    Search(ctx context.Context, query string, limit int) ([]Message, error)

    // Clear removes all messages
    Clear(ctx context.Context) error
}

// LLMClient abstracts the language model interface
type LLMClient interface {
    // Chat sends messages and receives response
    Chat(ctx context.Context, messages []Message, tools []Tool) (*Message, error)

    // StreamChat streams response tokens
    StreamChat(ctx context.Context, messages []Message, tools []Tool) (<-chan string, error)
}

// AgentConfig configures agent behavior
type AgentConfig struct {
    Name              string
    SystemPrompt      string
    MaxIterations     int           // Prevent infinite loops
    MaxToolCalls      int           // Limit tool calls per iteration
    Timeout           time.Duration // Overall timeout
    ThinkingBudget    int           // Max tokens for reasoning
    EnableParallelism bool          // Execute tools in parallel
    RetryPolicy       *RetryPolicy
}

// RetryPolicy defines retry behavior for failed tool calls
type RetryPolicy struct {
    MaxRetries int
    BackoffMs  int
}

// Agent represents an autonomous AI agent
type Agent struct {
    config  AgentConfig
    llm     LLMClient
    memory  Memory
    tools   map[string]Tool
    metrics *AgentMetrics
}

// AgentMetrics tracks agent performance
type AgentMetrics struct {
    TotalIterations int
    TotalToolCalls  int
    SuccessRate     float64
    AverageDuration time.Duration
    TokensUsed      int
}
```

### Agent Implementation

Now the loop itself. `Run` is where observe, think, and act become a single bounded `for`. Two details in it carry most of the production weight. The iteration cap is not a nicety, it is the only thing standing between a confused model and an unbounded spend of your API budget, so it gets a default even when the caller forgets to set one. And a tool that fails must report its failure back to the model as an observation rather than vanishing, because an agent that cannot see its own errors will cheerfully retry the same broken call until the cap stops it.

```go
// pkg/agent/agent.go
package agent

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// NewAgent creates a new agent instance
func NewAgent(config AgentConfig, llm LLMClient, memory Memory) *Agent {
    if config.MaxIterations == 0 {
        config.MaxIterations = 10 // Default limit
    }
    if config.MaxToolCalls == 0 {
        config.MaxToolCalls = 5
    }
    if config.Timeout == 0 {
        config.Timeout = 5 * time.Minute
    }

    return &Agent{
        config:  config,
        llm:     llm,
        memory:  memory,
        tools:   make(map[string]Tool),
        metrics: &AgentMetrics{},
    }
}

// RegisterTool adds a tool to the agent's toolkit
func (a *Agent) RegisterTool(tool Tool) error {
    if tool == nil {
        return fmt.Errorf("tool cannot be nil")
    }

    name := tool.Name()
    if name == "" {
        return fmt.Errorf("tool must have a name")
    }

    if _, exists := a.tools[name]; exists {
        return fmt.Errorf("tool %s already registered", name)
    }

    a.tools[name] = tool
    return nil
}

// Run executes the agent's main loop
func (a *Agent) Run(ctx context.Context, task string) (string, error) {
    start := time.Now()

    // Create timeout context
    ctx, cancel := context.WithTimeout(ctx, a.config.Timeout)
    defer cancel()

    // Add system prompt and user task to memory
    if a.config.SystemPrompt != "" {
        systemMsg := Message{
            Role:      "system",
            Content:   a.config.SystemPrompt,
            Timestamp: time.Now(),
        }
        if err := a.memory.Add(ctx, systemMsg); err != nil {
            return "", fmt.Errorf("failed to add system prompt: %w", err)
        }
    }

    userMsg := Message{
        Role:      "user",
        Content:   task,
        Timestamp: time.Now(),
    }
    if err := a.memory.Add(ctx, userMsg); err != nil {
        return "", fmt.Errorf("failed to add user message: %w", err)
    }

    // Main agent loop: observe -> think -> act
    var finalResponse string
    var done bool
    for i := 0; i < a.config.MaxIterations; i++ {
        a.metrics.TotalIterations++

        // Check context cancellation
        select {
        case <-ctx.Done():
            return "", ctx.Err()
        default:
        }

        // Get conversation history from memory
        messages, err := a.memory.GetRecent(ctx, 50) // Last 50 messages
        if err != nil {
            return "", fmt.Errorf("failed to retrieve memory: %w", err)
        }

        // Think: Ask LLM what to do next
        tools := a.getToolsList()
        response, err := a.llm.Chat(ctx, messages, tools)
        if err != nil {
            return "", fmt.Errorf("LLM call failed: %w", err)
        }

        // Store assistant's response in memory
        if err := a.memory.Add(ctx, *response); err != nil {
            return "", fmt.Errorf("failed to store response: %w", err)
        }

        // If no tool calls, agent has finished
        if len(response.ToolCalls) == 0 {
            finalResponse = response.Content
            done = true
            break
        }

        // Act: Execute tool calls
        if len(response.ToolCalls) > a.config.MaxToolCalls {
            return "", fmt.Errorf("too many tool calls: %d > %d",
                len(response.ToolCalls), a.config.MaxToolCalls)
        }

        var results []ToolResult
        if a.config.EnableParallelism {
            results = a.executeToolsParallel(ctx, response.ToolCalls)
        } else {
            results = a.executeToolsSequential(ctx, response.ToolCalls)
        }

        // Store tool results in memory. A failed tool must come back to the
        // model as an observation it can read and react to. Dropping the error
        // here would hand the model an empty result with no hint that anything
        // went wrong, and it would most likely repeat the same failing call.
        for _, result := range results {
            content := result.Content
            if result.Error != nil {
                content = fmt.Sprintf("tool error: %v", result.Error)
            }
            toolMsg := Message{
                Role:       "tool",
                Content:    content,
                ToolCallID: result.ToolCallID,
                Timestamp:  time.Now(),
            }
            if err := a.memory.Add(ctx, toolMsg); err != nil {
                return "", fmt.Errorf("failed to store tool result: %w", err)
            }
        }

        a.metrics.TotalToolCalls += len(results)
    }

    // Update metrics
    a.metrics.AverageDuration = time.Since(start)

    // Test the loop's own exit condition, not the text it produced. A model is
    // allowed to answer with an empty string, and that is a completed run, not
    // an exhausted budget.
    if !done {
        return "", fmt.Errorf("agent exceeded maximum iterations (%d)", a.config.MaxIterations)
    }

    return finalResponse, nil
}

// getToolsList converts tools map to slice
func (a *Agent) getToolsList() []Tool {
    tools := make([]Tool, 0, len(a.tools))
    for _, tool := range a.tools {
        tools = append(tools, tool)
    }
    return tools
}

// executeToolsSequential executes tools one after another
func (a *Agent) executeToolsSequential(ctx context.Context, calls []ToolCall) []ToolResult {
    results := make([]ToolResult, len(calls))

    for i, call := range calls {
        tool, exists := a.tools[call.Function.Name]
        if !exists {
            results[i] = ToolResult{
                ToolCallID: call.ID,
                Content:    "",
                Error:      fmt.Errorf("tool %s not found", call.Function.Name),
            }
            continue
        }

        content, err := tool.Execute(ctx, call.Function.Arguments)
        results[i] = ToolResult{
            ToolCallID: call.ID,
            Content:    content,
            Error:      err,
        }
    }

    return results
}

// executeToolsParallel executes tools concurrently
func (a *Agent) executeToolsParallel(ctx context.Context, calls []ToolCall) []ToolResult {
    results := make([]ToolResult, len(calls))
    var wg sync.WaitGroup

    for i, call := range calls {
        wg.Add(1)
        go func(idx int, tc ToolCall) {
            defer wg.Done()

            tool, exists := a.tools[tc.Function.Name]
            if !exists {
                results[idx] = ToolResult{
                    ToolCallID: tc.ID,
                    Content:    "",
                    Error:      fmt.Errorf("tool %s not found", tc.Function.Name),
                }
                return
            }

            content, err := tool.Execute(ctx, tc.Function.Arguments)
            results[idx] = ToolResult{
                ToolCallID: tc.ID,
                Content:    content,
                Error:      err,
            }
        }(i, call)
    }

    wg.Wait()
    return results
}

// GetMetrics returns agent performance metrics
func (a *Agent) GetMetrics() AgentMetrics {
    return *a.metrics
}
```

### Junior → FAANG: Framework Design as Interface Design

The agent framework in Go is fundamentally an interface design exercise. The `Tool` interface (`Name`, `Description`, `Parameters`, `Execute`) is the contract that allows the agent runtime to call any tool without knowing its implementation. The `LLMClient` interface (`Chat`, `StreamChat`) allows the agent to work with any LLM provider. The `Memory` interface (`Add`, `GetRecent`, `Search`, `Clear`) allows the agent to use any storage backend for its context. Designing these interfaces cleanly and minimally is the skill that makes the framework composable and testable.

A common junior mistake in agent framework design is encoding too much business logic in the framework and too little in the tool implementations. The framework should be generic: it should not know what any particular tool does. All domain-specific logic belongs in the tool implementations. If you find yourself adding if-statements to the agent loop that check for specific tool names, you have broken this abstraction and made the framework non-reusable.

For interview purposes, practice designing the agent framework interface from scratch on a whiteboard: start with the Tool interface, then the Memory interface, then the LLM client interface, then the Agent struct that wires them together. The resulting design should be generic enough to support any tool set and any LLM provider, and the Run method should fit on a single whiteboard panel. If your design requires more than one panel for the Run method, it has too much framework logic.

### Senior @ FAANG: Framework Governance and Extensibility

At senior level, an agent framework is a platform product with multiple consumers. Different teams use different tools, different LLM providers, and different memory backends. The framework must be extensible without modification: new tools are added by implementing the Tool interface, new LLM providers by implementing the LLM client interface, and new memory backends by implementing the Memory interface. This open-closed design principle is not just a software engineering best practice: it is a platform team requirement, because the alternative (requiring the framework team to implement every new tool and LLM provider) creates a bottleneck that does not scale.

Versioning the framework API is a senior-level governance concern. When the Tool interface changes (for example, adding a required Validate method), all existing tool implementations break. The framework team must manage this with semantic versioning and a migration guide. For major breaking changes, the framework should provide adapter utilities that wrap old-style tool implementations in the new interface, allowing teams to migrate gradually rather than all at once. This migration support is the difference between a platform team that enables velocity and one that creates migration crises.

At L6, framework governance includes the policy for who can contribute new tools to the standard library (the set of tools that all agent deployments can use by default). Tools in the standard library must meet specific requirements: they must be safe by default (no destructive actions without explicit enable flag), well-documented (schema with description and parameter documentation), tested (unit tests with mock LLM responses and mock tool results), and reviewed by the platform team for blast radius implications. This governance process ensures that the standard tool library is trustworthy and maintains the safety posture of the agent platform.
