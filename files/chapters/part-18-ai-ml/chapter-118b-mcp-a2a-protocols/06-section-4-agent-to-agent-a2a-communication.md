## 118B.5 Agent-to-Agent (A2A) Communication

### 4.1 A2A Protocol Design

**A2A (Agent2Agent)** is a specific protocol: published by Google in 2025, donated to the Linux Foundation the same year, and now at version 1.x. It solves a different problem from MCP. MCP connects a model *down* to its tools - A2A connects an agent *sideways* to peer agents, which are opaque to each other and may be built by different teams on different stacks.

Its real shape, in brief:

- **Transport bindings**: A2A defines several, including JSON-RPC 2.0, gRPC, and HTTP+JSON/REST. It reuses existing standards rather than inventing a wire format.
- **Agent Card**: a JSON document describing an agent's identity, skills, endpoint, and authentication requirements. Under the well-known URI discovery strategy it is served from **`/.well-known/agent-card.json`**. A client fetches this first, reads the skills and security requirements, and only then sends anything.
- **Task lifecycle**: work is a stateful, potentially long-running Task, not a request-response call. Tasks move through `submitted` and `working` to a terminal state (`completed`, `failed`, `canceled`, `rejected`), and may pause in `input-required` or `auth-required` when they need something from the caller. That lifecycle exists because agent work takes minutes or hours, and pretending otherwise is what forces people into polling hacks.
- **Core operations**: sending a message, sending a streaming message, getting, listing, subscribing to, and canceling a task, configuring push notifications, and fetching an extended Agent Card.

**What follows is a simplified sketch, not conformant A2A.** The types below (`AgentMessage`, `MessageType`, a bespoke `/a2a/message` endpoint) are a teaching model that isolates the ideas: capability discovery, correlation, and asynchronous delegation. Read it to understand the shape of the problem. Do **not** ship it and describe it as A2A, and do not treat these type names as spec vocabulary. For real interoperability, implement against the current specification at a2a-protocol.org or use an existing SDK.

```go
package a2a

import (
	"sync"
	"time"
)

// AgentMessage is the standard message format for A2A communication
type AgentMessage struct {
	ID          string                 `json:"id"`
	From        string                 `json:"from"`
	To          string                 `json:"to"`
	Type        MessageType            `json:"type"`
	Payload     map[string]any `json:"payload"`
	CorrelationID string              `json:"correlation_id,omitempty"`
	Timestamp   time.Time              `json:"timestamp"`
	TTL         time.Duration          `json:"ttl,omitempty"`
}

type MessageType string

const (
	MessageTypeTask       MessageType = "task"
	MessageTypeResult     MessageType = "result"
	MessageTypeError      MessageType = "error"
	MessageTypeEvent      MessageType = "event"
	MessageTypeQuery      MessageType = "query"
	MessageTypeSubscribe  MessageType = "subscribe"
)

// AgentCard describes an agent's capabilities.
//
// This is modelled on A2A's Agent Card but is NOT the spec's schema: the real
// one carries more (protocol version, transport bindings, security schemes,
// streaming and push-notification capabilities) and its field names are
// normative. Fetch the current specification before defining these types for
// real, and serve the document from /.well-known/agent-card.json.
type AgentCard struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Description  string       `json:"description"`
	URL          string       `json:"url"`
	Version      string       `json:"version"`
	Capabilities []string     `json:"capabilities"`
	Skills       []AgentSkill `json:"skills"`
	Auth         *AgentAuth   `json:"authentication,omitempty"`
}

type AgentSkill struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	InputModes  []string `json:"inputModes"`  // "text", "image", "file"
	OutputModes []string `json:"outputModes"`
}

type AgentAuth struct {
	Schemes []string `json:"schemes"` // "bearer", "apikey"
}

// AgentRegistry maintains a registry of known agents
type AgentRegistry struct {
	mu     sync.RWMutex
	agents map[string]*AgentCard
}

func NewAgentRegistry() *AgentRegistry {
	return &AgentRegistry{
		agents: make(map[string]*AgentCard),
	}
}

func (r *AgentRegistry) Register(card *AgentCard) {
	r.mu.Lock()
	r.agents[card.ID] = card
	r.mu.Unlock()
}

func (r *AgentRegistry) Lookup(id string) (*AgentCard, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	card, ok := r.agents[id]
	return card, ok
}

func (r *AgentRegistry) FindByCapability(capability string) []*AgentCard {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var results []*AgentCard
	for _, card := range r.agents {
		for _, cap := range card.Capabilities {
			if cap == capability {
				results = append(results, card)
				break
			}
		}
	}
	return results
}
```

### 4.2 Agent Implementation

The agent below both serves and consumes: it publishes its own card, accepts tasks from peers, and delegates tasks outward. That symmetry is what distinguishes A2A from MCP. An MCP server is a tool and never initiates - an A2A participant is a peer and does both.

The asynchronous shape is the part worth studying. `Send` does not block on an HTTP response carrying the answer, because agent work can take minutes and no sane HTTP timeout accommodates that. Instead the caller registers a channel under the message ID, the peer acknowledges with `202 Accepted`, and the answer arrives later as a *separate inbound message* correlated back by `CorrelationID`. Real A2A formalizes this with its task lifecycle and subscription methods. The sketch below shows the underlying mechanic.

```go
package a2a

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Agent is a self-contained AI agent with A2A communication
type Agent struct {
	card     AgentCard
	registry *AgentRegistry
	logger   *slog.Logger

	mu       sync.RWMutex
	handlers map[string]TaskHandler
	pending  map[string]chan *AgentMessage
}

// TaskHandler processes a task and returns a result
type TaskHandler func(ctx context.Context, msg *AgentMessage) (*AgentMessage, error)

func NewAgent(card AgentCard, registry *AgentRegistry) *Agent {
	a := &Agent{
		card:     card,
		registry: registry,
		logger:   slog.Default(),
		handlers: make(map[string]TaskHandler),
		pending:  make(map[string]chan *AgentMessage),
	}
	// Register self
	registry.Register(&card)
	return a
}

// Card returns a copy of this agent's card.
//
// Exported because other packages (the platform in Section 118B.7) need the agent's
// identity, and the field itself stays unexported so nobody can mutate an
// agent's published identity from the outside. Returning a copy rather than a
// pointer keeps that guarantee.
func (a *Agent) Card() AgentCard {
	return a.card
}

// RegisterHandler registers a handler for a skill
func (a *Agent) RegisterHandler(skillID string, handler TaskHandler) {
	a.mu.Lock()
	a.handlers[skillID] = handler
	a.mu.Unlock()
}

// Send sends a message to another agent and waits for response
func (a *Agent) Send(ctx context.Context, to string, skill string, payload map[string]any) (*AgentMessage, error) {
	targetCard, ok := a.registry.Lookup(to)
	if !ok {
		return nil, fmt.Errorf("agent not found: %s", to)
	}

	// Copy the payload rather than mutating the caller's map, and handle nil.
	// Assigning into a nil map panics, so a caller passing nil for a
	// no-argument skill would take the agent down. Mutating the caller's map
	// is separately rude: it makes Send visibly modify its own argument.
	p := make(map[string]any, len(payload)+1)
	for k, v := range payload {
		p[k] = v
	}
	p["skill"] = skill

	msg := &AgentMessage{
		ID:        uuid.New().String(),
		From:      a.card.ID,
		To:        to,
		Type:      MessageTypeTask,
		Payload:   p,
		Timestamp: time.Now(),
	}

	// Set up response channel
	respCh := make(chan *AgentMessage, 1)
	a.mu.Lock()
	a.pending[msg.ID] = respCh
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.pending, msg.ID)
		a.mu.Unlock()
	}()

	// Send via HTTP
	if err := a.sendHTTP(ctx, targetCard.URL, msg); err != nil {
		return nil, err
	}

	// Wait for response
	select {
	case resp := <-respCh:
		return resp, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (a *Agent) sendHTTP(ctx context.Context, url string, msg *AgentMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url+"/a2a/message",
		bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Agent-ID", a.card.ID)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted {
		return fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}
	return nil
}

// Routes returns the HTTP handlers for this agent.
//
// The Agent Card path is "/.well-known/agent-card.json". Not "agent.json":
// that name appears in older drafts and in a great deal of copied sample code,
// and a client following the current spec will simply 404 and conclude your
// agent does not exist. Discovery failures look like the agent being down.
func (a *Agent) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/agent-card.json", a.handleAgentCard)
	mux.HandleFunc("POST /a2a/message", a.handleMessage)
	return mux
}

func (a *Agent) handleAgentCard(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(a.card)
}

func (a *Agent) handleMessage(w http.ResponseWriter, r *http.Request) {
	var msg AgentMessage
	if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
		http.Error(w, "invalid message", http.StatusBadRequest)
		return
	}

	w.WriteHeader(http.StatusAccepted)

	go func() {
		// Do NOT inherit r.Context(): it is cancelled the moment this handler
		// returns, which is immediately, so the work would be killed before it
		// started. Do not use a bare context.Background() either, as the
		// original did, because that gives the task no deadline at all and a
		// wedged handler pins a goroutine forever. Detach with a budget.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Minute)
		defer cancel()

		if msg.Type == MessageTypeResult || msg.Type == MessageTypeError {
			// Route to the waiting caller.
			a.mu.RLock()
			ch, ok := a.pending[msg.CorrelationID]
			a.mu.RUnlock()
			if ok {
				ch <- &msg
			}
			return
		}

		// Dispatch task to handler
		skillID, _ := msg.Payload["skill"].(string)
		a.mu.RLock()
		handler, ok := a.handlers[skillID]
		a.mu.RUnlock()

		var resp *AgentMessage
		var err error
		if ok {
			resp, err = handler(ctx, &msg)
		} else {
			err = fmt.Errorf("skill not found: %s", skillID)
		}

		// Treat a nil response with a nil error as a handler bug rather than
		// dereferencing it. resp.CorrelationID on a nil *AgentMessage panics,
		// and that panic is in a bare goroutine with no recover, so it takes
		// the whole agent process down with it.
		if err == nil && resp == nil {
			err = fmt.Errorf("handler for skill %q returned no response", skillID)
		}

		if err != nil {
			resp = &AgentMessage{
				ID:            uuid.New().String(),
				From:          a.card.ID,
				To:            msg.From,
				Type:          MessageTypeError,
				CorrelationID: msg.ID,
				Payload:       map[string]any{"error": err.Error()},
				Timestamp:     time.Now(),
			}
		} else {
			resp.CorrelationID = msg.ID
		}

		// Send response back
		targetCard, ok := a.registry.Lookup(msg.From)
		if !ok {
			a.logger.Error("cannot reply: unknown sender", "from", msg.From, "msg", msg.ID)
			return
		}
		if err := a.sendHTTP(ctx, targetCard.URL, resp); err != nil {
			a.logger.Error("failed to deliver reply", "to", msg.From, "error", err)
		}
	}()
}
```

---

### Junior → FAANG: A2A Protocol as Distributed Systems Interview Topic

The A2A communication pattern introduces distributed systems concepts that are core to FAANG infrastructure interviews: service discovery (the agent registry where agents register their capabilities), message routing (sending tasks to the agent best equipped to handle them), asynchronous response handling (the delegating agent sends a task and receives a result through a callback or polling mechanism), and protocol versioning (agents must negotiate protocol compatibility). Each of these concepts has associated interview questions about failure modes and mitigations.

The agent card pattern (a structured description of an agent's capabilities, URL, and supported protocols) is a service discovery mechanism similar to how microservices register themselves with a service registry like Consul or etcd. The key difference is that agent cards describe capabilities in semantic terms (what tasks the agent can handle) rather than just network endpoints (where to reach the agent). Understanding this distinction is important for designing agent routing logic: routing to a specific URL is static configuration. Routing based on capability matching against the task description is dynamic discovery. Practice explaining the trade-offs of each approach.

**A peer agent's response is untrusted input, and A2A makes this sharper than MCP does.** With an MCP tool you at least wrote the tool. An A2A peer is an autonomous agent, quite possibly operated by another team or another company, whose output is generated by a model that reads *its* tool results, which may in turn be attacker-controlled. Text arriving from a peer therefore reaches your model with everything from the far end of that chain riding along, and injected instructions traverse agent boundaries as happily as legitimate results do. Everything from Chapter 117 Section 9 applies with an extra hop: authenticate peers, validate their responses against a schema before use, never let a peer's text reach your model as instruction, and keep your enforcement boundaries outside the model where a persuasive peer gets no vote. An Agent Card's `description` and skill text are themselves attacker-supplied strings if you fetch cards from agents you do not control.

### Senior @ FAANG: A2A Protocol Design as Service Mesh Architecture

At senior level, the A2A protocol is the agent layer of the service mesh. It sits above the infrastructure-level service mesh (Istio, Linkerd) which handles network-level concerns (mTLS, circuit breaking, retries), and it handles semantic-level concerns (capability discovery, task routing, result aggregation). The A2A protocol design must specify: message format versioning, authentication between agents, task idempotency (what happens when the same task is delivered twice?), task status tracking (can the delegating agent query the status of a delegated task?), and cancellation propagation (when the delegating agent cancels a task, does the sub-agent's work stop?). Addressing all of these concerns in the protocol design, before implementation begins, is the systems design rigor that staff engineers apply when architecting agent communication infrastructure.
