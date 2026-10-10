## Part 11: Testing

Testing a real-time chat application requires verifying both traditional request-response flows and asynchronous WebSocket behavior. In this section, you will write unit tests for the WebSocket hub using mock implementations of the message handler and Redis client, integration tests that spin up real connections, and load tests that simulate many concurrent users. The mock-based approach lets you test the hub logic in isolation without needing a running database or Redis instance. Pay attention to how channels and goroutines are tested, timing-sensitive concurrent code requires careful use of timeouts and synchronization in your test assertions.

### 11.1 Unit Tests (`internal/chat/hub_test.go`)

The unit tests use mock implementations of the message handler and Redis client to test the WebSocket hub in isolation. Each test creates a hub, registers mock clients, and verifies that messages are routed correctly.

```go
package chat

import (
	"context"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
)

// Mock implementations

type MockMessageHandler struct {
	mock.Mock
}

func (m *MockMessageHandler) SaveMessage(ctx context.Context, userID, channelID uuid.UUID, content string) (*models.Message, error) {
	args := m.Called(ctx, userID, channelID, content)
	return args.Get(0).(*models.Message), args.Error(1)
}

func (m *MockMessageHandler) GetMessages(ctx context.Context, channelID uuid.UUID, limit int, before *uuid.UUID) ([]*models.Message, error) {
	args := m.Called(ctx, channelID, limit, before)
	return args.Get(0).([]*models.Message), args.Error(1)
}

func (m *MockMessageHandler) DeleteMessage(ctx context.Context, messageID, userID uuid.UUID) error {
	args := m.Called(ctx, messageID, userID)
	return args.Error(0)
}

func (m *MockMessageHandler) AddReaction(ctx context.Context, messageID, userID uuid.UUID, emoji string) error {
	args := m.Called(ctx, messageID, userID, emoji)
	return args.Error(0)
}

func (m *MockMessageHandler) RemoveReaction(ctx context.Context, messageID, userID uuid.UUID, emoji string) error {
	args := m.Called(ctx, messageID, userID, emoji)
	return args.Error(0)
}

// Tests

func TestHub_RegisterClient(t *testing.T) {
	// Setup
	redisClient := redis.NewClient(&redis.Options{})
	mockMsgHandler := new(MockMessageHandler)
	mockPresence := new(MockPresenceService)

	hub := NewHub(redisClient, mockMsgHandler, mockPresence)

	// Create mock client
	client := &Client{
		ID:     uuid.New(),
		UserID: uuid.New(),
		Send:   make(chan []byte, 256),
		Rooms:  make(map[uuid.UUID]bool),
	}

	// Test
	hub.Register <- client

	// Give it time to process
	time.Sleep(10 * time.Millisecond)

	// Assert
	hub.mu.RLock()
	assert.Contains(t, hub.Clients, client.ID)
	hub.mu.RUnlock()
}

func TestHub_BroadcastMessage(t *testing.T) {
	// Setup
	redisClient := redis.NewClient(&redis.Options{})
	mockMsgHandler := new(MockMessageHandler)
	mockPresence := new(MockPresenceService)

	hub := NewHub(redisClient, mockMsgHandler, mockPresence)
	go hub.Run()

	roomID := uuid.New()

	// Create clients
	client1 := &Client{
		ID:     uuid.New(),
		UserID: uuid.New(),
		Send:   make(chan []byte, 256),
		Rooms:  map[uuid.UUID]bool{roomID: true},
	}

	client2 := &Client{
		ID:     uuid.New(),
		UserID: uuid.New(),
		Send:   make(chan []byte, 256),
		Rooms:  map[uuid.UUID]bool{roomID: true},
	}

	// Register clients
	hub.Register <- client1
	hub.Register <- client2
	time.Sleep(10 * time.Millisecond)

	// Join room
	hub.mu.Lock()
	room := NewRoom(roomID)
	room.AddClient(client1)
	room.AddClient(client2)
	hub.Rooms[roomID] = room
	hub.mu.Unlock()

	// Broadcast message
	msg := &BroadcastMessage{
		RoomID: roomID,
		Message: &models.Message{
			ID:        uuid.New(),
			Content:   "Test message",
			ChannelID: roomID,
		},
	}

	hub.Broadcast <- msg
	time.Sleep(10 * time.Millisecond)

	// Assert both clients received the message
	assert.True(t, len(client1.Send) > 0)
	assert.True(t, len(client2.Send) > 0)
}
```

### 11.2 Integration Tests (`internal/api/handlers_test.go`)

The integration tests use `httptest.NewServer` to spin up the full HTTP handler stack and send real HTTP requests against the registration, login, and channel endpoints.

```go
package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/yourusername/gochat/internal/models"
)

func TestRegisterHandler(t *testing.T) {
	// Setup test database and handlers
	// ... setup code ...

	req := models.CreateUserRequest{
		Username: "testuser",
		Email:    "test@example.com",
		Password: "password123",
	}

	body, _ := json.Marshal(req)
	request := httptest.NewRequest("POST", "/api/register", bytes.NewBuffer(body))
	request.Header.Set("Content-Type", "application/json")

	recorder := httptest.NewRecorder()

	// Execute
	handlers.Register(recorder, request)

	// Assert
	assert.Equal(t, http.StatusCreated, recorder.Code)

	var response models.LoginResponse
	json.NewDecoder(recorder.Body).Decode(&response)

	assert.NotEmpty(t, response.Token)
	assert.Equal(t, "testuser", response.User.Username)
}
```

### 11.3 Load Tests (`tests/load_test.go`)

The load test spawns hundreds of concurrent WebSocket connections, sends messages in parallel, and measures throughput and latency to identify bottlenecks under high concurrency.

```go
package tests

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestWebSocketLoadSimulation(t *testing.T) {
	const (
		numClients      = 100
		messagesPerClient = 10
		serverURL       = "ws://localhost:8080/ws?token=test-token"
	)

	var wg sync.WaitGroup
	errors := make(chan error, numClients)

	for i := 0; i < numClients; i++ {
		wg.Add(1)
		go func(clientID int) {
			defer wg.Done()

			conn, _, err := websocket.DefaultDialer.Dial(serverURL, nil)
			if err != nil {
				errors <- fmt.Errorf("client %d dial error: %w", clientID, err)
				return
			}
			defer conn.Close()

			// Send messages
			for j := 0; j < messagesPerClient; j++ {
				msg := map[string]any{
					"type": "chat_message",
					"data": map[string]any{
						"room_id": "test-room",
						"content": fmt.Sprintf("Message %d from client %d", j, clientID),
					},
				}

				if err := conn.WriteJSON(msg); err != nil {
					errors <- fmt.Errorf("client %d write error: %w", clientID, err)
					return
				}

				time.Sleep(100 * time.Millisecond)
			}
		}(i)
	}

	wg.Wait()
	close(errors)

	// Check for errors
	for err := range errors {
		t.Error(err)
	}
}
```

### Junior → FAANG: Testing Concurrent Code Without Flakiness

Testing WebSocket behavior is harder than testing REST endpoints because WebSocket interactions are inherently asynchronous. The common mistake is to use `time.Sleep` to wait for goroutines to complete. This produces flaky tests: they pass on fast machines and fail under load. The correct approach is to use channels or `sync.WaitGroup` for synchronization, and to use `require.Eventually` with a timeout for assertions that depend on asynchronous state.

Testing the Hub in isolation with mock dependencies is the most important test category. If the Hub's routing logic has a bug, every message delivery fails. Covering hub registration, deregistration, and broadcast with unit tests catches those bugs before they reach production.

Load testing with concurrent goroutines simulating WebSocket connections is the only way to catch race conditions that do not appear under single-user testing. Run your load tests with `go test -race` to enable the race detector.

### Senior @ FAANG: Testing as a Reliability Investment

At senior level, the testing strategy for a real-time system must cover failure modes that do not appear in happy-path tests: network partitions (simulate by closing a connection mid-message), slow consumers (simulate by adding artificial delay in the client's read loop), Redis unavailability (simulate by stopping the Redis container during a test), and graceful shutdown (verify that active connections are properly closed when the server receives SIGTERM).

Chaos testing is the production version of failure simulation. Tools like Chaos Monkey or Chaos Toolkit can randomly terminate pods, inject network latency, or drop packets in a staging environment. A chat system that passes chaos testing is demonstrably more resilient than one that has only been load-tested under happy-path conditions.

Test coverage metrics are necessary but not sufficient. 80% line coverage says nothing about whether the 20% of uncovered code contains race conditions. For concurrent code specifically, mutation testing (introducing bugs and verifying tests catch them) is a more reliable quality indicator than line coverage. At FAANG, teams report both coverage and flakiness rates as test health metrics.

---
