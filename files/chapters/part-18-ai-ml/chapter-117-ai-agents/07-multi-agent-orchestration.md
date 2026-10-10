## 117.6 Multi-Agent Orchestration

For complex tasks, multiple specialized agents can collaborate.

```go
// pkg/agent/orchestration/coordinator.go
package orchestration

import (
    "context"
    "fmt"
    "strings"
    "sync"

    "agent/pkg/agent"
)

// AgentRole defines a specialized agent
type AgentRole struct {
    Name        string
    Agent       *agent.Agent
    Expertise   string
    Priority    int
}

// Coordinator manages multiple agents
type Coordinator struct {
    agents map[string]*AgentRole
    // RoutingStrategy is an interface, so store it as an interface value.
    // *RoutingStrategy would be a pointer to an interface, which is almost
    // never what you want: it does not satisfy the interface, so the
    // assignment in NewCoordinator would not compile.
    router RoutingStrategy
    mu     sync.RWMutex
}

// RoutingStrategy decides which agent handles which task
type RoutingStrategy interface {
    Route(ctx context.Context, task string, agents map[string]*AgentRole) (*AgentRole, error)
}

// NewCoordinator creates a multi-agent coordinator
func NewCoordinator(router RoutingStrategy) *Coordinator {
    return &Coordinator{
        agents: make(map[string]*AgentRole),
        router: router,
    }
}

// RegisterAgent adds an agent to the coordinator
func (c *Coordinator) RegisterAgent(role *AgentRole) error {
    c.mu.Lock()
    defer c.mu.Unlock()

    if _, exists := c.agents[role.Name]; exists {
        return fmt.Errorf("agent %s already registered", role.Name)
    }

    c.agents[role.Name] = role
    return nil
}

// snapshot copies the agent map under the read lock. Returning c.agents itself
// would hand the caller a reference to a map that RegisterAgent may write to
// concurrently, and reading a map while another goroutine writes it is a data
// race that the runtime will abort the process for.
func (c *Coordinator) snapshot() map[string]*AgentRole {
    c.mu.RLock()
    defer c.mu.RUnlock()

    out := make(map[string]*AgentRole, len(c.agents))
    for k, v := range c.agents {
        out[k] = v
    }
    return out
}

// Execute routes task to appropriate agent
func (c *Coordinator) Execute(ctx context.Context, task string) (string, error) {
    agents := c.snapshot()

    // Route to appropriate agent
    selectedAgent, err := c.router.Route(ctx, task, agents)
    if err != nil {
        return "", fmt.Errorf("routing failed: %w", err)
    }

    // Execute with selected agent. The lock is not held here: an agent run
    // takes seconds to minutes, and blocking every registration behind it
    // would serialise the whole coordinator.
    return selectedAgent.Agent.Run(ctx, task)
}

// ExecuteParallel runs task with multiple agents in parallel.
//
// Note what is NOT held across the fan-out: the coordinator lock. Taking
// c.mu.RLock() with a deferred unlock at the top of this function would keep
// the read lock for the entire duration of every agent run. Any concurrent
// RegisterAgent then blocks for minutes behind an unrelated batch of LLM calls,
// and because Go's RWMutex blocks new readers once a writer is waiting, the
// next ExecuteParallel queues behind that. Resolve the names first, release,
// then run.
func (c *Coordinator) ExecuteParallel(ctx context.Context, task string, agentNames []string) (map[string]string, error) {
    all := c.snapshot()

    selected := make([]*AgentRole, 0, len(agentNames))
    for _, name := range agentNames {
        ar, exists := all[name]
        if !exists {
            return nil, fmt.Errorf("agent not found: %s", name)
        }
        selected = append(selected, ar)
    }

    results := make(map[string]string)
    failures := make(map[string]error)
    var wg sync.WaitGroup
    var mu sync.Mutex

    for _, ar := range selected {
        wg.Add(1)
        go func(ar *AgentRole) {
            defer wg.Done()

            result, err := ar.Agent.Run(ctx, task)

            mu.Lock()
            defer mu.Unlock()

            if err != nil {
                failures[ar.Name] = err
            } else {
                results[ar.Name] = result
            }
        }(ar)
    }

    wg.Wait()

    // Return the partial results alongside the error. A caller that fanned out
    // to four agents and got three answers can usually still proceed, and
    // throwing away three completed agent runs means paying for them twice.
    if len(failures) > 0 {
        return results, fmt.Errorf("some agents failed: %v", failures)
    }

    return results, nil
}

// KeywordRouter routes based on keywords in task
type KeywordRouter struct {
    keywords map[string]string // keyword -> agent name
}

func NewKeywordRouter() *KeywordRouter {
    return &KeywordRouter{
        keywords: make(map[string]string),
    }
}

func (k *KeywordRouter) AddKeyword(keyword, agentName string) {
    k.keywords[keyword] = agentName
}

func (k *KeywordRouter) Route(ctx context.Context, task string, agents map[string]*AgentRole) (*AgentRole, error) {
    taskLower := strings.ToLower(task)

    // Collect every keyword match, then pick deterministically.
    //
    // Returning from inside a range over a map would make routing depend on Go's
    // randomised map iteration order: a task matching both "search" and "code"
    // would go to a different agent on different runs, for the same input. That
    // is close to the worst possible bug to debug in an agent system, because it
    // reproduces only sometimes and looks like model nondeterminism.
    var best *AgentRole
    for keyword, agentName := range k.keywords {
        if !strings.Contains(taskLower, keyword) {
            continue
        }
        ar, exists := agents[agentName]
        if !exists {
            continue
        }
        if best == nil || ar.Priority > best.Priority ||
            (ar.Priority == best.Priority && ar.Name < best.Name) {
            best = ar
        }
    }
    if best != nil {
        return best, nil
    }

    // Default: highest priority agent, ties broken by name for stability.
    var selected *AgentRole
    for _, ar := range agents {
        if selected == nil || ar.Priority > selected.Priority ||
            (ar.Priority == selected.Priority && ar.Name < selected.Name) {
            selected = ar
        }
    }

    if selected == nil {
        return nil, fmt.Errorf("no agents available")
    }

    return selected, nil
}
```

### Example: Research + Code + Writing Team

Here is the coordinator wired up with two specialists: a research agent that can search the web, and a code agent that reads code and databases. Each gets its own memory, its own iteration budget, and only the tools its role needs.

That last point is the design rule worth taking away. The research agent can reach the internet, so it is the agent most likely to ingest attacker-controlled text, and it is therefore precisely the agent that must not also hold database or filesystem tools. Splitting agents by role is not only about prompt focus. It bounds what any single compromised context can reach.

```go
// pkg/agent/examples/agent_team.go
package examples

import (
    "context"
    "fmt"
    "os"

    "agent/pkg/agent"
    "agent/pkg/agent/memory"
    "agent/pkg/agent/orchestration"
    "agent/pkg/agent/tools"
)

// CreateAgentTeam sets up a multi-agent system
func CreateAgentTeam(llm agent.LLMClient) (*orchestration.Coordinator, error) {
    coordinator := orchestration.NewCoordinator(orchestration.NewKeywordRouter())

    // Research Agent - expert at web search and fact-finding
    researchAgent := agent.NewAgent(
        agent.AgentConfig{
            Name:         "ResearchAgent",
            SystemPrompt: "You are a research specialist. Use web search to find accurate, up-to-date information.",
            MaxIterations: 5,
        },
        llm,
        memory.NewBufferMemory(50),
    )

    // Read the key from the environment. A literal key in source is a key in
    // your git history, and agent tool keys are often billable.
    apiKey := os.Getenv("BRAVE_SEARCH_API_KEY")
    if apiKey == "" {
        return nil, fmt.Errorf("BRAVE_SEARCH_API_KEY is not set")
    }

    searchTool := tools.NewWebSearchTool(apiKey, "https://api.search.brave.com/res/v1/web/search")
    if err := researchAgent.RegisterTool(searchTool); err != nil {
        return nil, fmt.Errorf("registering search tool: %w", err)
    }

    if err := coordinator.RegisterAgent(&orchestration.AgentRole{
        Name:      "research",
        Agent:     researchAgent,
        Expertise: "Web research, fact-checking, current events",
        Priority:  1,
    }); err != nil {
        return nil, fmt.Errorf("registering research agent: %w", err)
    }

    // Code Agent - expert at reading code and databases
    codeAgent := agent.NewAgent(
        agent.AgentConfig{
            Name:         "CodeAgent",
            SystemPrompt: "You are a code analysis specialist. Examine codebases and databases to answer technical questions.",
            MaxIterations: 8,
        },
        llm,
        memory.NewBufferMemory(100),
    )

    // Add code-related tools (filesystem, database)
    // codeAgent.RegisterTool(...)

    if err := coordinator.RegisterAgent(&orchestration.AgentRole{
        Name:      "code",
        Agent:     codeAgent,
        Expertise: "Code analysis, database queries, technical investigation",
        Priority:  2,
    }); err != nil {
        return nil, fmt.Errorf("registering code agent: %w", err)
    }

    return coordinator, nil
}

// RunTeamExample wires the team to a real client and routes one task.
func RunTeamExample(ctx context.Context, llm agent.LLMClient) {
    team, err := CreateAgentTeam(llm)
    if err != nil {
        fmt.Printf("Failed to create team: %v\n", err)
        return
    }

    // Route automatically based on task
    result, err := team.Execute(ctx, "What are the latest features in Go 1.27?")
    if err != nil {
        fmt.Printf("Task failed: %v\n", err)
        return
    }

    fmt.Printf("Result: %s\n", result)
}
```

### Junior → FAANG: Multi-Agent Architecture as Distributed Systems

Multi-agent orchestration is a distributed systems problem. When agent A delegates a subtask to agent B, you have created a distributed computation with all the associated failure modes: agent B may fail, timeout, produce incorrect results, or take longer than expected. Your orchestration logic must handle each of these failure modes explicitly: retry failed agents with different inputs, timeout long-running agents and handle the partial completion, validate agents B's outputs before using them in agent A's reasoning, and prevent cascading failures where one agent's failure takes down the entire workflow.

The orchestrator pattern (one agent delegates to many specialized sub-agents) is the cleanest multi-agent architecture for interview discussions because it has clear responsibilities: the orchestrator decides the decomposition and integration strategy, and each specialist agent handles a specific domain. The alternatives (fully decentralized peer-to-peer agents, shared-state agents) are harder to reason about and harder to debug. For interview design questions involving multi-agent systems, default to the orchestrator pattern and be prepared to justify it.

The most common multi-agent failure mode is circular delegation: orchestrator asks research agent to find information, research agent asks orchestrator for context, orchestrator asks research agent again, creating an infinite loop. Preventing this requires explicit loop detection (track which agent called which other agent in the current session) and a maximum delegation depth (refuse to delegate if the current chain depth exceeds N). Both of these safeguards belong in the agent platform, not in individual agent implementations.

### Senior @ FAANG: Multi-Agent Systems at Production Scale

At FAANG scale, multi-agent systems are the architecture for complex, long-running workflows: a product research workflow that delegates to a search agent, a summarization agent, a competitive analysis agent, and an output formatting agent, with the orchestrator synthesizing all results. Designing this architecture for production reliability requires: explicit workflow state management (the orchestrator saves its progress so it can restart from the last successful step after a failure), agent isolation (each sub-agent runs independently so a failure in one does not corrupt the state of others), and human checkpoints (the orchestrator pauses after completing each major phase and waits for human review before proceeding to the next phase for high-stakes workflows).

Cost management for multi-agent workflows is significantly more complex than for single-agent workflows. Each delegation call is itself an LLM call, and the orchestrator may make many delegation calls in a complex workflow. Implementing per-workflow cost budgets (the entire workflow is aborted if the total LLM cost exceeds the budget) and per-agent cost budgets (each sub-agent is given a token budget and must complete within it) prevents cost runaway in complex workflows. Designing cost tracking that aggregates across all agents in a workflow and attributes the total to the originating user or service is a senior-level observability requirement.

At L7, multi-agent system design intersects with organizational process design. The most valuable multi-agent systems automate workflows that previously required coordination across multiple human specialists: research, analysis, drafting, review, and publishing. Designing these systems requires deep understanding of the human workflow being automated, the failure modes that require human intervention rather than automated handling, and the quality thresholds that determine when the automated output is ready for production use versus when it needs human review. Staff engineers lead this human-AI workflow design process as a collaboration between engineering, product, and the domain experts whose work is being augmented.
