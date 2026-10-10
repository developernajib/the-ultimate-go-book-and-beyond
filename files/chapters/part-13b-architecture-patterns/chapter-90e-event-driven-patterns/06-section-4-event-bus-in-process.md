## 90E.5 Event Bus (In-Process)

An in-process event bus decouples components within a single service by routing events to registered handlers without requiring a message broker. This is valuable for wiring together application layers. For example, a domain event emitted deep inside a use case can trigger an audit logger or a cache invalidator in a completely separate package. The bus uses reflection to match events to handlers by their concrete type, so handlers are strongly typed and do not need to perform a type assertion on a generic `interface{}`. Handlers can be registered as synchronous (blocking the caller until completion) or asynchronous (running in a goroutine), which makes the bus suitable for both transactional side effects and fire-and-forget notifications.

```go
package eventbus

import (
	"context"
	"fmt"
	"log/slog"
	"reflect"
	"sync"
)

// EventBus provides in-process event pub/sub
type EventBus struct {
	mu          sync.RWMutex
	handlers    map[string][]handlerEntry
	middleware  []Middleware
	logger      *slog.Logger
}

type handlerEntry struct {
	fn      any
	async   bool
}

type Middleware func(eventType string, event any, next func())

func NewEventBus() *EventBus {
	return &EventBus{
		handlers: make(map[string][]handlerEntry),
		logger:   slog.Default(),
	}
}

// Subscribe registers a typed handler for an event type
// Handler must be: func(context.Context, *EventType) error
func (bus *EventBus) Subscribe(handler any) error {
	handlerType := reflect.TypeOf(handler)
	if handlerType.Kind() != reflect.Func {
		return fmt.Errorf("handler must be a function")
	}

	if handlerType.NumIn() != 2 {
		return fmt.Errorf("handler must accept (context.Context, *EventType)")
	}

	eventType := handlerType.In(1)
	if eventType.Kind() == reflect.Ptr {
		eventType = eventType.Elem()
	}

	key := eventType.String()
	bus.mu.Lock()
	bus.handlers[key] = append(bus.handlers[key], handlerEntry{fn: handler})
	bus.mu.Unlock()

	return nil
}

// SubscribeAsync registers an asynchronous handler
func (bus *EventBus) SubscribeAsync(handler any) error {
	if err := bus.Subscribe(handler); err != nil {
		return err
	}

	handlerType := reflect.TypeOf(handler)
	eventType := handlerType.In(1)
	if eventType.Kind() == reflect.Ptr {
		eventType = eventType.Elem()
	}
	key := eventType.String()

	bus.mu.Lock()
	entries := bus.handlers[key]
	entries[len(entries)-1].async = true
	bus.mu.Unlock()
	return nil
}

// Publish dispatches an event to all registered handlers
func (bus *EventBus) Publish(ctx context.Context, event any) []error {
	eventType := reflect.TypeOf(event)
	if eventType.Kind() == reflect.Ptr {
		eventType = eventType.Elem()
	}
	key := eventType.String()

	bus.mu.RLock()
	entries := make([]handlerEntry, len(bus.handlers[key]))
	copy(entries, bus.handlers[key])
	bus.mu.RUnlock()

	var errs []error
	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, entry := range entries {
		if entry.async {
			wg.Add(1)
			go func(e handlerEntry) {
				defer wg.Done()
				if err := bus.invoke(ctx, e.fn, event); err != nil {
					mu.Lock()
					errs = append(errs, err)
					mu.Unlock()
				}
			}(entry)
		} else {
			if err := bus.invoke(ctx, entry.fn, event); err != nil {
				errs = append(errs, err)
			}
		}
	}

	wg.Wait()
	return errs
}

func (bus *EventBus) invoke(ctx context.Context, fn any, event any) error {
	fnVal := reflect.ValueOf(fn)
	eventVal := reflect.ValueOf(event)

	// Handle pointer vs value receiver
	fnType := fnVal.Type()
	paramType := fnType.In(1)
	if paramType.Kind() == reflect.Ptr && eventVal.Kind() != reflect.Ptr {
		// Create pointer to event
		ptr := reflect.New(eventVal.Type())
		ptr.Elem().Set(eventVal)
		eventVal = ptr
	}

	results := fnVal.Call([]reflect.Value{
		reflect.ValueOf(ctx),
		eventVal,
	})

	if len(results) > 0 && !results[0].IsNil() {
		return results[0].Interface().(error)
	}
	return nil
}
```

---
