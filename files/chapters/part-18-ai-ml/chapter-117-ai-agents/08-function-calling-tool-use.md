## 117.7 Function Calling / Tool Use

Modern LLM APIs support structured function calling. Let's integrate with OpenAI's API.

```go
// pkg/agent/llm/openai.go
package llm

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "time"

    "agent/pkg/agent"
)

// OpenAIClient implements LLMClient for OpenAI API
type OpenAIClient struct {
    apiKey     string
    model      string
    httpClient *http.Client
    baseURL    string
}

// NewOpenAIClient creates an OpenAI client
func NewOpenAIClient(apiKey, model string) *OpenAIClient {
    return &OpenAIClient{
        apiKey: apiKey,
        model:  model,
        httpClient: &http.Client{
            Timeout: 60 * time.Second,
        },
        baseURL: "https://api.openai.com/v1",
    }
}

// Chat sends messages and receives response with tool calls
func (o *OpenAIClient) Chat(ctx context.Context, messages []agent.Message, tools []agent.Tool) (*agent.Message, error) {
    // Convert to OpenAI format
    reqMessages := o.convertMessages(messages)
    reqTools := o.convertTools(tools)

    requestBody := map[string]any{
        "model":    o.model,
        "messages": reqMessages,
    }

    if len(reqTools) > 0 {
        requestBody["tools"] = reqTools
        requestBody["tool_choice"] = "auto"
    }

    bodyBytes, err := json.Marshal(requestBody)
    if err != nil {
        return nil, fmt.Errorf("failed to marshal request: %w", err)
    }

    // Make API request
    req, err := http.NewRequestWithContext(ctx, "POST",
        o.baseURL+"/chat/completions", bytes.NewReader(bodyBytes))
    if err != nil {
        return nil, fmt.Errorf("failed to create request: %w", err)
    }

    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Bearer "+o.apiKey)

    resp, err := o.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("request failed: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        body, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
    }

    // Parse response
    var chatResp ChatCompletionResponse
    if err := json.NewDecoder(resp.Body).Decode(&chatResp); err != nil {
        return nil, fmt.Errorf("failed to decode response: %w", err)
    }

    if len(chatResp.Choices) == 0 {
        return nil, fmt.Errorf("no response choices")
    }

    // Convert back to agent.Message
    return o.convertResponse(chatResp.Choices[0].Message)
}

func (o *OpenAIClient) StreamChat(ctx context.Context, messages []agent.Message, tools []agent.Tool) (<-chan string, error) {
    // Streaming implementation would go here
    return nil, fmt.Errorf("streaming not implemented")
}

// convertMessages converts agent messages to OpenAI format
func (o *OpenAIClient) convertMessages(messages []agent.Message) []map[string]any {
    result := make([]map[string]any, len(messages))

    for i, msg := range messages {
        m := map[string]any{
            "role":    msg.Role,
            "content": msg.Content,
        }

        if len(msg.ToolCalls) > 0 {
            toolCalls := make([]map[string]any, len(msg.ToolCalls))
            for j, tc := range msg.ToolCalls {
                // The wire format for arguments is a JSON *string*, not a JSON
                // object. Our FunctionCall.Arguments is a map[string]any, so it
                // has to be marshalled back to a string on the way out.
                // Passing the map directly serialises it as a nested object,
                // which does not match the schema the API expects, and the
                // error it returns points at the message index rather than at
                // this line.
                argBytes, err := json.Marshal(tc.Function.Arguments)
                if err != nil {
                    argBytes = []byte("{}")
                }
                toolCalls[j] = map[string]any{
                    "id":   tc.ID,
                    "type": tc.Type,
                    "function": map[string]any{
                        "name":      tc.Function.Name,
                        "arguments": string(argBytes),
                    },
                }
            }
            m["tool_calls"] = toolCalls
        }

        if msg.ToolCallID != "" {
            m["tool_call_id"] = msg.ToolCallID
        }

        result[i] = m
    }

    return result
}

// convertTools converts agent tools to OpenAI function format
func (o *OpenAIClient) convertTools(tools []agent.Tool) []map[string]any {
    if len(tools) == 0 {
        return nil
    }

    result := make([]map[string]any, len(tools))

    for i, tool := range tools {
        result[i] = map[string]any{
            "type": "function",
            "function": map[string]any{
                "name":        tool.Name(),
                "description": tool.Description(),
                "parameters":  tool.Parameters(),
            },
        }
    }

    return result
}

// convertResponse converts OpenAI response to agent message.
//
// It returns an error because the arguments field is a JSON string generated by
// the model, and a model can emit malformed JSON. Discarding the Unmarshal
// error leaves args nil and hands the tool a nil argument map, so the tool sees
// every parameter as missing and reports a confusing validation failure that
// looks nothing like the actual cause.
func (o *OpenAIClient) convertResponse(msg ResponseMessage) (*agent.Message, error) {
    result := &agent.Message{
        Role:      msg.Role,
        Content:   msg.Content,
        Timestamp: time.Now(),
    }

    if len(msg.ToolCalls) > 0 {
        result.ToolCalls = make([]agent.ToolCall, len(msg.ToolCalls))
        for i, tc := range msg.ToolCalls {
            // Parse arguments JSON string to map. Note that every number in
            // here decodes to float64, which is what the tools must assert.
            var args map[string]any
            if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
                return nil, fmt.Errorf("tool call %s (%s): malformed arguments %q: %w",
                    tc.ID, tc.Function.Name, tc.Function.Arguments, err)
            }

            result.ToolCalls[i] = agent.ToolCall{
                ID:   tc.ID,
                Type: tc.Type,
                Function: agent.FunctionCall{
                    Name:      tc.Function.Name,
                    Arguments: args,
                },
            }
        }
    }

    return result, nil
}

// OpenAI API response types
type ChatCompletionResponse struct {
    ID      string   `json:"id"`
    Choices []Choice `json:"choices"`
    Usage   Usage    `json:"usage"`
}

type Choice struct {
    Index        int             `json:"index"`
    Message      ResponseMessage `json:"message"`
    FinishReason string          `json:"finish_reason"`
}

type ResponseMessage struct {
    Role      string             `json:"role"`
    Content   string             `json:"content"`
    ToolCalls []ResponseToolCall `json:"tool_calls,omitempty"`
}

type ResponseToolCall struct {
    ID       string                 `json:"id"`
    Type     string                 `json:"type"`
    Function ResponseFunctionCall   `json:"function"`
}

type ResponseFunctionCall struct {
    Name      string `json:"name"`
    Arguments string `json:"arguments"` // JSON string
}

type Usage struct {
    PromptTokens     int `json:"prompt_tokens"`
    CompletionTokens int `json:"completion_tokens"`
    TotalTokens      int `json:"total_tokens"`
}
```

Usage comes back on every response, and it is the only honest source for what a run actually cost. Thread it into the agent's metrics rather than estimating from message lengths. Cost tracking that is reconstructed after the fact is always wrong, and it is wrong in the expensive direction on exactly the runs you most want to understand.

### Junior → FAANG: Function Calling as Type-Safe Agent Interfaces

Function calling (also called tool use) is the LLM API feature that replaces prose parsing with structured data. Instead of scraping the model's free-form text to extract tool invocations (fragile and error-prone), function calling returns a JSON object naming the tool and its parameter values. Your Go code unmarshals that JSON, validates it against the schema, and calls the tool. This is the correct production approach: never parse natural language tool invocations from LLM output.

Be precise about what this does and does not guarantee, because the phrase "type-safe" is doing less work here than it appears to. The schema is a request, not a constraint. A model can and does emit arguments that violate its own declared schema: wrong types, missing required fields, invented enum values, occasionally malformed JSON. Some providers offer a strict or constrained-decoding mode that raises the floor considerably, but the boundary is still your validation code, not the schema declaration. Type safety begins where you decode and check, and everything upstream of that check is a suggestion the model was under no obligation to follow.

The JSON schema for function parameters is the contract between the LLM's understanding of the tool and your code's implementation. A schema that requires a `date` parameter of type string with format `YYYY-MM-DD` will produce different LLM behavior than one that requires a Unix timestamp integer. Match your schema to your implementation: if your Go code expects a time.Time parsed from RFC3339, your schema should specify a string in RFC3339 format. The schema is documentation for the LLM, and vague documentation produces unreliable tool invocations.

Parallel function calling (where the LLM returns multiple tool invocations to be executed simultaneously) is a latency optimization that many junior engineers are unaware of. Instead of executing tools one at a time in sequence, if the LLM identifies multiple independent tools to call, it can return them all at once and your code executes them in parallel using goroutines. This reduces the total latency for the agent's thinking step significantly. Know how to handle parallel function calls in Go: launch a goroutine for each tool call, collect results with a channel or WaitGroup, and return all results to the LLM in the next message.

### Senior @ FAANG: Function Calling Schema Design for Reliability

Tool schema design at senior level is a reliability engineering exercise. Poor schemas produce LLM hallucinations (the model calls the tool with parameter values that do not satisfy the schema constraints, causing runtime errors). Good schemas have: precise types (use number for floating-point, integer for integers, not string for everything), explicit required versus optional parameters (optional parameters should have clear documentation of what happens when they are omitted), constrained values where appropriate (use enum for parameters with a fixed set of valid values), and examples in the description (showing the LLM exactly what valid inputs look like).

Schema versioning is required when tool interfaces change. If your code changes the parameter names or types of a tool and you update the schema accordingly, any agent that has the old schema cached will produce incompatible tool calls. Tool schemas should be versioned as part of the agent configuration, and agents should be restarted when schemas change to ensure they are using the current schema. The agent platform should track schema versions and alert when an agent is using a schema version that has been deprecated.

At L6, function calling governance includes the audit requirement that every tool invocation is logged with the full parameter values. This audit log serves three purposes: debugging (when an agent fails, the audit log shows exactly what tool calls were made and with what arguments), security (detecting tool calls with unusual patterns that may indicate prompt injection or misuse), and compliance (for regulated industries where every action taken on behalf of a user must be recorded). Designing the audit logging system to be tamper-evident (using an append-only log with cryptographic linking) is the appropriate level of rigor for production agent deployments.
