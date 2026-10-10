## 115.10 Streaming Response Implementation

For better user experience, implement streaming for real-time responses. Three details in the code below are easy to omit and each one is a production bug:

1. **Cancel the upstream call on every exit path.** The client's producer goroutine holds the HTTP response body open. Return early (on error, on a disconnected client) without cancelling and that goroutine can block forever trying to send into a channel nobody reads, leaking the goroutine *and* the connection. Leak enough of them and the connection pool is exhausted, at which point every request in the process hangs.
2. **Flush.** Writing to an `http.ResponseWriter` buffers. Without flushing after each chunk, the bytes sit in the buffer until it fills or the handler returns, which delivers the whole response at once and reproduces exactly the blocking behaviour streaming was meant to eliminate. The tell is a streaming implementation that "works" but shows no visible difference.
3. **Charge for the stream.** A streaming path that skips the budget check is an unmetered hole straight through your cost controls.

```go
// chat/streaming.go
package chat

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"

	"yourproject/openai"
)

func (s *Service) StreamMessage(
	ctx context.Context,
	conversationID string,
	userMessage string,
	writer io.Writer,
) error {
	conv := s.GetConversation(conversationID)

	// The streaming path costs money exactly like the blocking one. Authorize
	// before opening the stream, not after.
	inputEstimate := estimateTokens(userMessage) + conv.TotalTokens()
	estimatedCost, err := s.costTracker.Estimate(s.model, inputEstimate, maxResponseTokens)
	if err != nil {
		return fmt.Errorf("cannot price model %q: %w", s.model, err)
	}
	if err := s.budget.Check(estimatedCost); err != nil {
		return fmt.Errorf("budget check failed: %w", err)
	}

	conv.AddMessage("user", userMessage, estimateTokens(userMessage))
	conv.TruncateToTokenLimit(s.contextLimit())

	history := conv.GetMessages()
	messages := make([]openai.Message, 0, len(history))
	for _, msg := range history {
		messages = append(messages, openai.Message{
			Role:    msg.Role,
			Content: msg.Content,
		})
	}

	// Derive a cancellable context so that every return below tears the
	// upstream request down. Without this, an early return strands the
	// client's reader goroutine and its HTTP body.
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	stream, err := s.openaiClient.StreamChatCompletion(streamCtx, openai.ChatCompletionRequest{
		Model:               s.model,
		Messages:            messages,
		MaxCompletionTokens: maxResponseTokens,
	})
	if err != nil {
		return err
	}

	// Flush after each chunk if the writer supports it. An http.ResponseWriter
	// buffers, so an unflushed "stream" arrives as one lump at the end.
	flusher, _ := writer.(http.Flusher)

	var fullResponse strings.Builder

	for event := range stream {
		if event.Error != nil {
			// Partial output has already reached the user. Signal the break
			// rather than returning silently, or they will read a truncated
			// answer as a complete one.
			return fmt.Errorf("stream failed after %d bytes: %w",
				fullResponse.Len(), event.Error)
		}
		if event.Done {
			break
		}

		if _, err := io.WriteString(writer, event.Delta.Content); err != nil {
			// The client hung up. cancel() (deferred) stops the upstream call
			// so we stop paying for tokens nobody will read.
			return fmt.Errorf("write to client: %w", err)
		}
		if flusher != nil {
			flusher.Flush()
		}
		fullResponse.WriteString(event.Delta.Content)
	}

	response := fullResponse.String()
	conv.AddMessage("assistant", response, estimateTokens(response))

	// Reconcile against the estimate. Note the caveat: a streamed response
	// carries no usage object unless you request one, so this settles against
	// an estimate rather than metered truth. Enable the provider's streaming
	// usage option and reconcile against the real counts when it matters.
	actualEstimate, err := s.costTracker.Estimate(s.model, inputEstimate, estimateTokens(response))
	if err == nil {
		s.budget.Reconcile(estimatedCost, actualEstimate)
	}

	return nil
}
```

### Junior → FAANG: Streaming as a Go Concurrency Exercise

Server-Sent Events (SSE) streaming in Go is a clean exercise in concurrent I/O. The HTTP handler creates a goroutine that reads from the LLM streaming API, writes each chunk to the HTTP response using the flusher interface, and exits when the stream ends or the client disconnects. The key challenge is detecting client disconnection: Go's `http.Request.Context()` is canceled when the client disconnects, which you detect with a select on the context's Done channel in the streaming loop. Practice implementing this pattern until it is automatic, because streaming response handling appears frequently in LLM infrastructure interviews.

Token streaming from the LLM API is an SSE stream: each event contains a delta (the new text content for this chunk), and the stream ends with a special done event. Parsing this stream correctly requires: handling events with no data (heartbeat events that keep the connection alive), handling events with partial UTF-8 characters that span chunk boundaries, handling errors mid-stream where the API sends an error event before closing the connection, and handling client disconnection where you must cancel the upstream API call to avoid paying for tokens that are never returned to the user.

The user experience implication of streaming is the most important thing to internalize. Without streaming, a multi-second response creates a blank wait that feels broken and prompts users to refresh or abandon. With streaming, the user sees text appear after the time-to-first-token, which is typically a small fraction of the total, and gets continuous evidence of progress. The total time to the complete answer is unchanged, and can even be marginally worse. Only the perception changes, and the perception is what users actually experience, which is why streaming is the default for consumer-facing LLM applications. It follows that time-to-first-token, not total latency, is the metric to put on the dashboard for these endpoints.

### Senior @ FAANG: Streaming Infrastructure at Scale

Streaming LLM responses at FAANG scale requires careful infrastructure design. A streaming connection is a long-lived HTTP connection (typically 2 to 30 seconds) that holds a goroutine, a TCP connection, and memory for the response buffer for its entire duration. At 10,000 concurrent streaming users, this means 10,000 goroutines, 10,000 TCP connections, and significant memory for in-flight buffers. Capacity planning for streaming services must account for connection duration (average and worst-case), not just requests per second.

Caching streaming responses is architecturally complex. A cached response for a streaming request should replay the original stream with realistic inter-chunk timing to maintain the streaming user experience, not deliver all chunks simultaneously. This requires storing the full response with chunk timing metadata, and replaying it on cache hit with the original timing. The additional storage and complexity may not be justified for streaming responses with high content variance, but is valuable for responses that are frequently requested.

At L6, streaming response infrastructure intersects with the gateway's observability requirements. For a non-streaming response, cost and quality metrics are available at the end of the request. For a streaming response, the total token count is only available when the stream completes, but latency metrics (time-to-first-token, streaming rate in tokens per second, total streaming duration) should be emitted throughout the stream. Designing the observability pipeline to handle the different event timing for streaming versus non-streaming requests requires careful data model design and is a senior-level platform engineering task.
