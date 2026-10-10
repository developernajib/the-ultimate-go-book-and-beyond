## 115.9 Building a Complete Chat Application

Let's put everything together into a production-ready chat application.

### Conversation Manager

A conversation manager maintains the message history exchanged with an LLM, applying truncation strategies to keep total token count within the model's context window. The implementation below does sliding-window truncation that pins the system prompt and keeps the most recent exchanges, dropping the oldest turns in the middle.

Two constraints make this less trivial than "drop from the front". The system prompt lives at index 0 and carries the instructions that define the assistant's behaviour, so a truncator that blindly slices from the front will eventually amputate it, and the model's persona will change mid-conversation for reasons nobody can reproduce. And providers care about message structure: Anthropic requires the first message to be from the user, so a naive cut that leaves an `assistant` message at the head produces a 400 on the very next request.

```go
// chat/conversation.go
package chat

import (
	"fmt"
	"sync"
	"time"
)

type Message struct {
	ID        string
	Role      string
	Content   string
	Timestamp time.Time
	Tokens    int
}

type Conversation struct {
	ID        string
	Messages  []Message
	CreatedAt time.Time
	UpdatedAt time.Time
	mu        sync.RWMutex
}

func NewConversation(id string) *Conversation {
	now := time.Now()
	return &Conversation{
		ID:        id,
		Messages:  make([]Message, 0),
		CreatedAt: now,
		UpdatedAt: now,
	}
}

func (c *Conversation) AddMessage(role, content string, tokens int) Message {
	c.mu.Lock()
	defer c.mu.Unlock()

	msg := Message{
		ID:        fmt.Sprintf("msg_%d", len(c.Messages)),
		Role:      role,
		Content:   content,
		Timestamp: time.Now(),
		Tokens:    tokens,
	}

	c.Messages = append(c.Messages, msg)
	c.UpdatedAt = time.Now()

	return msg
}

func (c *Conversation) GetMessages() []Message {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Return a copy
	msgs := make([]Message, len(c.Messages))
	copy(msgs, c.Messages)
	return msgs
}

func (c *Conversation) TotalTokens() int {
	c.mu.RLock()
	defer c.mu.RUnlock()

	total := 0
	for _, msg := range c.Messages {
		total += msg.Tokens
	}
	return total
}

// TruncateToTokenLimit drops the oldest non-system messages until the history
// fits within limit, while always retaining a leading system message and
// leaving the first surviving conversational turn on a "user" message.
func (c *Conversation) TruncateToTokenLimit(limit int) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Pin a leading system prompt: it is instructions, not history, and it must
	// survive every truncation. Slicing it away is how an assistant silently
	// loses its persona twenty turns into a long conversation.
	var system *Message
	body := c.Messages
	if len(body) > 0 && body[0].Role == "system" {
		system = &body[0]
		body = body[1:]
		limit -= system.Tokens
	}

	// Walk backwards from the newest message, keeping what fits.
	keepFrom := len(body)
	total := 0
	for i := len(body) - 1; i >= 0; i-- {
		if total+body[i].Tokens > limit {
			break
		}
		total += body[i].Tokens
		keepFrom = i
	}
	body = body[keepFrom:]

	// A conversation must open on a user turn. If the cut landed on an
	// assistant reply, drop it too: an orphaned reply to a question the model
	// can no longer see is worse than useless, and Anthropic rejects it outright.
	if len(body) > 0 && body[0].Role == "assistant" {
		body = body[1:]
	}

	rebuilt := make([]Message, 0, len(body)+1)
	if system != nil {
		rebuilt = append(rebuilt, *system)
	}
	rebuilt = append(rebuilt, body...)
	c.Messages = rebuilt
}
```

Truncation is the cheapest context strategy and the bluntest: it silently forgets. That is acceptable for casual chat and unacceptable when an instruction from turn two must still bind at turn forty. When it stops being acceptable, the escalation path is summarization (fold the dropped span into a running summary that occupies a fraction of the tokens) and, beyond that, retrieval over the archived history. Note also that this method charges the full context cost on every request, since resending the window is what the stateless API requires. That is what makes provider-side prompt caching so valuable here: a stable prefix that never shifts is billed at a steep discount, which is a strong argument for truncating in coarse chunks rather than one message at a time, since every cut invalidates the cached prefix.

### Chat Service

The chat service layer encapsulates conversation state management, LLM request construction, and response streaming behind a clean interface that HTTP handlers depend on. The following implementation wires together the conversation manager, LLM client, and streaming response writer into a cohesive service.

```go
// chat/service.go
package chat

import (
	"context"
	"fmt"
	"sync"

	"yourproject/anthropic"
	"yourproject/cost"
	"yourproject/openai"
)

type Provider string

const (
	ProviderOpenAI    Provider = "openai"
	ProviderAnthropic Provider = "anthropic"
)

// maxResponseTokens bounds each reply. It is also the upper bound used to
// pre-authorize spend, which is why it must be an enforced ceiling and not a
// hope: an unbounded response is an unbounded charge.
const maxResponseTokens = 1024

// estimateTokens is a deliberately crude guard rail (see the tokenization
// section). It is used for budgeting headroom only. Never reconcile billing
// against it; reconcile against the usage the provider returns.
func estimateTokens(text string) int {
	return (len([]rune(text)) + 3) / 4
}

// contextLimit reports the usable history budget for the configured model.
// Hardcoding one number for every model is wrong in both directions: too small
// and you truncate history the model could have used, too large and the
// provider rejects the request outright.
func (s *Service) contextLimit() int {
	if limit, ok := contextWindows[s.model]; ok {
		return limit - maxResponseTokens // leave room for the reply
	}
	return 8000 - maxResponseTokens // conservative fallback
}

// contextWindows belongs in configuration alongside the price table. Both are
// per-model facts that change when the model changes.
var contextWindows = map[string]int{
	"gpt-4o-mini":       128_000,
	"claude-sonnet-4-6": 200_000,
}

type Service struct {
	provider        Provider
	model           string
	openaiClient    *openai.Client
	anthropicClient *anthropic.Client

	conversations sync.Map
	costTracker   *cost.Tracker
	budget        *cost.Budget
}

func NewService(provider Provider, apiKey, model string, budgetLimit float64) *Service {
	s := &Service{
		provider:    provider,
		model:       model,
		costTracker: cost.NewTracker(),
		budget:      cost.NewBudget(budgetLimit),
	}

	switch provider {
	case ProviderOpenAI:
		s.openaiClient = openai.NewClient(apiKey)
	case ProviderAnthropic:
		s.anthropicClient = anthropic.NewClient(apiKey)
	}

	// Budget alerts. These run on their own goroutine (see cost.Budget.Check),
	// so they must not call back into the budget while it may still hold its
	// lock. Capture the limit here instead of interrogating the budget later.
	limit := budgetLimit
	s.budget.OnSoftLimit(func() {
		fmt.Printf("WARNING: 80%% of $%.2f budget consumed\n", limit)
	})
	s.budget.OnHardLimit(func() {
		fmt.Printf("ALERT: $%.2f budget limit reached\n", limit)
	})

	return s
}

// GetConversation returns the conversation for id, creating it if absent.
//
// LoadOrStore, not Load-then-Store: with the latter, two concurrent requests
// for the same new session both miss, both construct a Conversation, and the
// second Store silently replaces the first. Whichever request held the losing
// pointer then writes messages into an orphaned object and the user watches
// half their conversation disappear.
func (s *Service) GetConversation(id string) *Conversation {
	if conv, ok := s.conversations.Load(id); ok {
		return conv.(*Conversation)
	}
	actual, _ := s.conversations.LoadOrStore(id, NewConversation(id))
	return actual.(*Conversation)
}

func (s *Service) SendMessage(
	ctx context.Context,
	conversationID string,
	userMessage string,
) (string, error) {
	conv := s.GetConversation(conversationID)

	// Pre-authorize against an upper bound, then reconcile with real usage
	// after the call (output tokens are unknowable in advance).
	inputEstimate := estimateTokens(userMessage) + conv.TotalTokens()
	estimatedCost, err := s.costTracker.Estimate(s.model, inputEstimate, maxResponseTokens)
	if err != nil {
		return "", fmt.Errorf("cannot price model %q: %w", s.model, err)
	}
	if err := s.budget.Check(estimatedCost); err != nil {
		return "", fmt.Errorf("budget check failed: %w", err)
	}

	// Add user message
	conv.AddMessage("user", userMessage, estimateTokens(userMessage))

	// Truncate conversation to fit the context window. The limit belongs in
	// the model config next to the price, not as a literal here: it is the one
	// number that changes every time someone swaps the model.
	conv.TruncateToTokenLimit(s.contextLimit())

	// Call LLM based on provider
	var response string
	var inputTokens, outputTokens int

	switch s.provider {
	case ProviderOpenAI:
		response, inputTokens, outputTokens, err = s.callOpenAI(ctx, conv)
	case ProviderAnthropic:
		response, inputTokens, outputTokens, err = s.callAnthropic(ctx, conv)
	default:
		return "", fmt.Errorf("unsupported provider: %s", s.provider)
	}

	if err != nil {
		return "", err
	}

	// Settle the real cost against the pre-authorized estimate.
	actualCost, err := s.costTracker.Track(s.model, inputTokens, outputTokens)
	if err != nil {
		return "", fmt.Errorf("track usage: %w", err)
	}
	s.budget.Reconcile(estimatedCost, actualCost)

	// Add assistant message
	conv.AddMessage("assistant", response, outputTokens)

	fmt.Printf("Request cost: $%.4f (Total: $%.4f)\n", actualCost, s.costTracker.TotalCost())

	return response, nil
}

func (s *Service) callOpenAI(ctx context.Context, conv *Conversation) (string, int, int, error) {
	// Snapshot once under the lock. Reading conv.Messages directly here (for
	// example to size this slice with len(conv.Messages)) races with any other
	// goroutine calling AddMessage, and `go test -race` will say so.
	history := conv.GetMessages()

	messages := make([]openai.Message, 0, len(history))
	for _, msg := range history {
		// OpenAI carries the system prompt as an ordinary message in the array,
		// so it passes through unchanged.
		messages = append(messages, openai.Message{
			Role:    msg.Role,
			Content: msg.Content,
		})
	}

	resp, err := s.openaiClient.CreateChatCompletion(ctx, openai.ChatCompletionRequest{
		Model:               s.model,
		Messages:            messages,
		MaxCompletionTokens: maxResponseTokens,
	})
	if err != nil {
		return "", 0, 0, err
	}
	if len(resp.Choices) == 0 {
		return "", 0, 0, fmt.Errorf("openai returned no choices")
	}

	return resp.Choices[0].Message.Content,
		resp.Usage.PromptTokens,
		resp.Usage.CompletionTokens,
		nil
}

func (s *Service) callAnthropic(ctx context.Context, conv *Conversation) (string, int, int, error) {
	history := conv.GetMessages()

	// Anthropic takes the system prompt as a TOP-LEVEL field, not as a message
	// in the array. Hoist it rather than dropping it: skipping system messages
	// with a "handle separately" comment and never handling them is how the
	// assistant quietly loses its instructions on one provider but not the other.
	var system string
	messages := make([]anthropic.Message, 0, len(history))
	for _, msg := range history {
		if msg.Role == "system" {
			system = msg.Content
			continue
		}
		messages = append(messages, anthropic.NewTextMessage(msg.Role, msg.Content))
	}

	resp, err := s.anthropicClient.CreateMessage(ctx, anthropic.MessageRequest{
		Model:     s.model,
		System:    system,
		Messages:  messages,
		MaxTokens: maxResponseTokens,
	})
	if err != nil {
		return "", 0, 0, err
	}

	// Do not assume Content[0] is text. A response may lead with a non-text
	// block (thinking, tool use), and indexing blindly hands the user the
	// model's scratchpad, or panics on an empty slice.
	var text string
	for _, block := range resp.Content {
		if block.Type == "text" {
			text += block.Text
		}
	}
	if text == "" {
		return "", 0, 0, fmt.Errorf("anthropic returned no text block (stop_reason=%s)", resp.StopReason)
	}

	return text, resp.Usage.InputTokens, resp.Usage.OutputTokens, nil
}

func (s *Service) GetCostReport() string {
	return s.costTracker.UsageReport()
}
```

### CLI Chat Interface

The CLI chat interface reads user input from `bufio.Scanner` in a REPL loop, sends it through the conversation manager to accumulate message history, and prints the reply. It calls the blocking `SendMessage`, so the whole response appears at once after a pause. That is the simplest thing that works and it is exactly the experience the next section fixes by streaming. Local commands are intercepted before reaching the LLM, so they cost nothing and return instantly.

```go
// cmd/chat/main.go
package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"yourproject/chat"
)

func main() {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("OPENAI_API_KEY environment variable required")
	}

	// Create chat service with a $10 budget. Model comes from the environment
	// so that swapping it never requires a rebuild.
	model := os.Getenv("LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}
	service := chat.NewService(chat.ProviderOpenAI, apiKey, model, 10.00)

	conversationID := "cli_session"

	fmt.Println("Chat Application (type 'exit' to quit, 'report' for cost report)")
	fmt.Println("================================================================")

	scanner := bufio.NewScanner(os.Stdin)
	ctx := context.Background()

	for {
		fmt.Print("\nYou: ")
		if !scanner.Scan() {
			break
		}

		input := strings.TrimSpace(scanner.Text())

		if input == "" {
			continue
		}

		if input == "exit" {
			fmt.Println("\nGoodbye!")
			fmt.Println(service.GetCostReport())
			break
		}

		if input == "report" {
			fmt.Println("\n" + service.GetCostReport())
			continue
		}

		// Send message
		response, err := service.SendMessage(ctx, conversationID, input)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			continue
		}

		fmt.Printf("\nAssistant: %s\n", response)
	}
}
```

The CLI prose above mentions `/clear` and `/history` - this loop implements `exit` and `report`. Wiring the remaining two up is left as an exercise, and the shape is the same: intercept the command before it reaches `SendMessage`.

### Junior → FAANG: Chat Application Architecture as Interview Foundation

A complete chat application is the canonical LLM integration project because it requires solving all the fundamental challenges simultaneously: conversation state management (where is the history stored?), context window management (what do you do when the history exceeds the context limit?), streaming response handling (how does the client receive partial responses?), cost control (how do you prevent runaway spending?), and error handling (what does the user see when the LLM API fails?). Building this application end-to-end, even at toy scale, gives you concrete answers to each of these questions in an interview.

Context management strategy is the question interviewers probe most deeply. The naive approach, sending the entire conversation history with every request, is simple but breaks when histories get long. The three alternatives are: truncation (drop the oldest messages when the context limit is approached), summarization (compress the oldest messages into a summary and replace them with the summary), and sliding window (always include the last N messages plus the system prompt). Each strategy has a different cost and quality tradeoff. Know when each is appropriate and be able to explain the tradeoff in two minutes.

Conversation persistence is a state management challenge: the conversation history must survive application restarts, be accessible from any server instance in a horizontally scaled deployment, and be retrievable quickly enough to not add significant latency to the first message in a session. Redis with a TTL-based expiration is a common solution: store the serialized conversation history as a JSON string in Redis, keyed by session ID, with a 24-hour expiration. Practice implementing this pattern in Go, including the serialization, the TTL management, and the fallback behavior when Redis is unavailable.

### Senior @ FAANG: Chat Application as Organizational Platform

At senior level, a chat application is a platform that multiple product teams build on rather than a single application. The platform provides: session management and conversation persistence, LLM provider abstraction with automatic fallback, rate limiting and cost control per user and per feature, streaming infrastructure, and conversation analytics. Product teams provide: the system prompt for their specific use case, the response post-processing logic for their domain, and the user interface. This platform-versus-product-team split enables multiple chat-based features (customer support, document Q&A, code assistant) to share infrastructure without duplicating it.

Conversation analytics is a data product that senior engineers design alongside the chat platform. Every conversation contains valuable signals: which questions users ask, where conversations stall or receive negative feedback, which responses are rated helpful versus unhelpful, and which sessions lead to the desired business outcome (a purchase, a resolved support ticket, a code commit). Capturing this data in a structured event stream, making it accessible to product and data teams, and building feedback loops that improve the system prompt and model selection over time is the flywheel that makes chat applications improve continuously rather than stagnating after launch.

At L6, conversation safety and moderation is a governance concern. For applications where users can ask arbitrary questions, the system must have explicit policies for: how to handle requests for harmful content (which the LLM should refuse), what user behavior triggers a human review or account action, how conversation data is retained and for how long, and whether conversation data is used to improve models (and if so, what the user consent mechanism is). These policies must be documented, implemented in code, and reviewed by legal and trust-and-safety teams before launch.
