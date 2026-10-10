## 117.9 Production Agent Example

Let's build a complete production agent: a customer support assistant.

```go
// cmd/support-agent/main.go
package main

import (
    "context"
    "database/sql"
    "fmt"
    "log"
    "os"
    "time"

    "agent/pkg/agent"
    "agent/pkg/agent/llm"
    "agent/pkg/agent/memory"
    "agent/pkg/agent/safety"
    "agent/pkg/agent/tools"

    _ "github.com/lib/pq"
)

func main() {
    ctx := context.Background()

    // Initialize LLM client
    apiKey := os.Getenv("OPENAI_API_KEY")
    if apiKey == "" {
        log.Fatal("OPENAI_API_KEY not set")
    }

    // Take the model from configuration rather than hardcoding an identifier.
    // Model names are the fastest-rotting string in any AI codebase: they get
    // deprecated and retired on the provider's schedule, not yours, and a
    // literal here means a code change and a redeploy to follow that schedule.
    model := os.Getenv("OPENAI_MODEL")
    if model == "" {
        log.Fatal("OPENAI_MODEL not set")
    }

    llmClient := llm.NewOpenAIClient(apiKey, model)

    // Initialize database connection.
    //
    // The DSN must point at a role with SELECT on orders and shipments and
    // nothing else. That grant, not the tool code, is what stops a support
    // question from turning into a DELETE.
    db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        log.Fatalf("Failed to open database: %v", err)
    }
    defer db.Close()

    // sql.Open does not connect, it only validates the DSN. Without a ping the
    // first sign of a bad DATABASE_URL is a tool failure mid-conversation,
    // reported to the model as an observation and quietly retried.
    if err := db.PingContext(ctx); err != nil {
        log.Fatalf("Failed to connect to database: %v", err)
    }

    // Create support agent
    supportAgent, err := createSupportAgent(llmClient, db)
    if err != nil {
        log.Fatalf("Failed to create agent: %v", err)
    }

    // Example query
    query := "I ordered product #12345 three days ago but haven't received a shipping confirmation. Can you check the status?"

    fmt.Printf("User: %s\n\n", query)

    response, err := supportAgent.Run(ctx, query)
    if err != nil {
        log.Fatalf("Agent failed: %v", err)
    }

    fmt.Printf("Agent: %s\n", response)

    // Print metrics
    metrics := supportAgent.GetMetrics()
    fmt.Printf("\nMetrics:\n")
    fmt.Printf("  Iterations: %d\n", metrics.TotalIterations)
    fmt.Printf("  Tool Calls: %d\n", metrics.TotalToolCalls)
    fmt.Printf("  Duration: %s\n", metrics.AverageDuration)
}

func createSupportAgent(llmClient agent.LLMClient, db *sql.DB) (*agent.Agent, error) {
    // Configure agent
    config := agent.AgentConfig{
        Name: "SupportAgent",
        SystemPrompt: `You are a helpful customer support agent. You have access to:
- Order database: Check order status, shipping info, payment details
- Knowledge base: Product information, policies, FAQs

Always be polite and helpful. If you need to look up information, use the available tools.
When you have enough information to answer, provide a clear, friendly response.`,
        MaxIterations:     8,
        MaxToolCalls:      5,
        EnableParallelism: false,
        Timeout:          2 * time.Minute,
    }

    // Create agent with buffer memory
    agentMemory := memory.NewBufferMemory(100)
    supportAgent := agent.NewAgent(config, llmClient, agentMemory)

    // Create guardrails
    guardrails := safety.NewGuardrails()

    // Register order database tool. Both tools here are reads, so retries are
    // safe and the idempotent wrapper is the right one. Had this agent been
    // given an issue_refund tool, it would take plain WrapTool plus an
    // approval gate.
    orderTool := tools.NewDatabaseTool(db, []string{"orders", "shipments"})
    safeOrderTool := safety.WrapIdempotentTool(orderTool, guardrails)
    if err := supportAgent.RegisterTool(safeOrderTool); err != nil {
        return nil, fmt.Errorf("registering order tool: %w", err)
    }

    // Register knowledge base tool
    kbTool := tools.NewFileSystemTool("/var/support/knowledge-base")
    safeKBTool := safety.WrapIdempotentTool(kbTool, guardrails)
    if err := supportAgent.RegisterTool(safeKBTool); err != nil {
        return nil, fmt.Errorf("registering knowledge base tool: %w", err)
    }

    return supportAgent, nil
}
```

### Agent Monitoring and Logging

An agent's log is not a convenience, it is the only record of why the agent did what it did. A conventional service can be understood by reading its code, because the code is the decision. An agent's decisions are made by a model whose reasoning exists nowhere except in the trace you captured at the time. If you did not log the tool call and its arguments, that reasoning is simply gone, and no amount of rerunning reproduces it.

The logger below records each iteration and each tool call as a structured entry.

Two warnings about what you are writing to disk. Tool arguments and results routinely contain exactly the customer data your privacy policy governs: order details, addresses, whatever the model happened to read. That data is now in a log with a different retention window and a much wider set of readers than the database it came from. Scrub or redact before writing, and set a retention period deliberately rather than by default. Second, these logs record attacker-controlled text, since tool results are untrusted. Treat the log viewer as a place where hostile strings will appear, and escape accordingly.

```go
// pkg/agent/monitoring/logger.go
package monitoring

import (
    "encoding/json"
    "fmt"
    "os"
    "time"
)

// AgentLogger logs agent activities
type AgentLogger struct {
    logFile string
    verbose bool
}

func NewAgentLogger(logFile string, verbose bool) *AgentLogger {
    return &AgentLogger{
        logFile: logFile,
        verbose: verbose,
    }
}

// LogIteration logs each agent iteration
func (a *AgentLogger) LogIteration(iteration int, thought, action string) {
    entry := LogEntry{
        Timestamp: time.Now(),
        Type:      "iteration",
        Iteration: iteration,
        Data: map[string]any{
            "thought": thought,
            "action":  action,
        },
    }

    a.write(entry)
}

// LogToolCall logs tool executions
func (a *AgentLogger) LogToolCall(toolName string, args map[string]any, result string, err error) {
    data := map[string]any{
        "tool":   toolName,
        "args":   args,
        "result": result,
    }

    // Convert the error to a string. Storing the error value directly is a
    // silent data-loss bug: error is an interface, and the concrete type behind
    // it (errors.errorString, fmt.wrapError) has no exported fields, so
    // encoding/json renders it as {} and the message is gone. It does not fail,
    // it just logs an empty object where the cause should be, and you find out
    // during the incident you needed it for.
    if err != nil {
        data["error"] = err.Error()
    }

    entry := LogEntry{
        Timestamp: time.Now(),
        Type:      "tool_call",
        Data:      data,
    }

    a.write(entry)
}

// LogError logs errors
func (a *AgentLogger) LogError(err error, context string) {
    entry := LogEntry{
        Timestamp: time.Now(),
        Type:      "error",
        Data: map[string]any{
            "error":   err.Error(),
            "context": context,
        },
    }

    a.write(entry)
}

func (a *AgentLogger) write(entry LogEntry) {
    // Handle the marshal error rather than discarding it. Data holds arbitrary
    // tool arguments, and an unmarshalable value there (a channel, a func, a
    // cycle) would otherwise drop the entry on the floor without a trace.
    jsonBytes, err := json.Marshal(entry)
    if err != nil {
        fmt.Fprintf(os.Stderr, "agent logger: cannot marshal %s entry: %v\n", entry.Type, err)
        return
    }

    if a.verbose {
        fmt.Printf("[%s] %s: %s\n", entry.Timestamp.Format(time.RFC3339), entry.Type, string(jsonBytes))
    }

    f, err := os.OpenFile(a.logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
    if err != nil {
        fmt.Fprintf(os.Stderr, "agent logger: cannot open %s: %v\n", a.logFile, err)
        return
    }
    defer f.Close()

    if _, err := fmt.Fprintf(f, "%s\n", jsonBytes); err != nil {
        fmt.Fprintf(os.Stderr, "agent logger: cannot write %s: %v\n", a.logFile, err)
    }
}

type LogEntry struct {
    Timestamp time.Time      `json:"timestamp"`
    Type      string         `json:"type"`
    Iteration int            `json:"iteration,omitempty"`
    Data      map[string]any `json:"data"`
}
```

### Junior → FAANG: Customer Support Agent as Portfolio Artifact

The customer support agent example is one of the strongest portfolio projects you can build for an AI infrastructure interview. It demonstrates: tool use (query customer database, submit ticket, send email), memory (conversation history with context management), safety guardrails (rate limiting, PII detection, action validation), and observability (structured logging of every tool call and LLM interaction). Present this project in interviews by walking through the most interesting engineering decision you made, not by describing every component sequentially.

The most interview-worthy engineering decision in this example is the escalation logic: when should the agent escalate to a human agent? Implement this as a configurable set of conditions: if the customer has been marked as VIP, escalate immediately. If the agent has made more than N tool calls without resolving the issue, escalate. If the customer's sentiment (detected by a simple sentiment analysis tool) is strongly negative, escalate. If the request involves a refund above a threshold dollar amount, escalate for human approval. This escalation logic demonstrates product-minded engineering that goes beyond pure technical implementation.

For production deployment of this example, add a session recovery mechanism: if the agent crashes mid-conversation, the next invocation should restore the conversation history from persistent storage and continue from where it left off. Implementing this requires persisting the conversation history to Redis or a database with each message, and loading it from storage at the start of each session. This session recovery capability makes the agent reliable for long conversations and demonstrates understanding of stateful service production concerns.

### Senior @ FAANG: Production Agent Reliability and Compliance

Customer support agents at FAANG scale (handling millions of interactions per day) require a different reliability posture than a demo implementation. The agent must be horizontally scalable (any instance can handle any conversation, with conversation state in external storage), the tool calls must be idempotent or have explicit deduplication to prevent double-ticket-creation on retry, and the human escalation workflow must be integrated with the support team's ticketing and routing system for seamless handoff.

Compliance requirements for customer support agents include: recording every interaction with a customer for regulatory audit purposes (in financial services, healthcare, and telecommunications, this is often a legal requirement), ensuring that agent actions comply with customer consent (if the customer has not consented to automated processing, the agent must escalate to a human), and providing customers with the ability to opt out of AI-powered support and speak to a human. These compliance requirements must be designed into the agent architecture from the start and verified through automated compliance tests in the CI pipeline.

At L6, customer support agent governance includes quality measurement through customer satisfaction scores correlated with agent interaction characteristics. Correlating CSAT scores with factors like: number of tool calls made, whether the issue was resolved without escalation, response latency, and which tools were used in successful versus unsuccessful resolutions enables continuous improvement of the agent's tool set and prompting strategy. Building this analytics pipeline is a senior-level platform investment that enables evidence-based agent improvement.
