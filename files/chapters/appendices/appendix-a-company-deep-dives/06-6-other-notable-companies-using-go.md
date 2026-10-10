## 6. Other Notable Companies Using Go

### 6.1 Stripe - Payment Infrastructure

**What They Built:**
- Payment processing pipeline
- Webhook delivery system
- API gateway

**Key Pattern - Idempotency:**
```go
package payment

type PaymentProcessor struct {
    idempotency *IdempotencyStore
    db          *sql.DB
}

type IdempotencyStore struct {
    cache *redis.Client
}

func (pp *PaymentProcessor) ProcessPayment(ctx context.Context, key string, payment *Payment) (*PaymentResult, error) {
    // Check idempotency key
    if result, ok := pp.idempotency.Get(key); ok {
        return result, nil
    }

    // Start transaction
    tx, err := pp.db.BeginTx(ctx, nil)
    if err != nil {
        return nil, err
    }
    defer tx.Rollback()

    // Process payment
    result, err := pp.charge(ctx, tx, payment)
    if err != nil {
        return nil, err
    }

    // Store idempotency key
    pp.idempotency.Set(key, result, 24*time.Hour)

    // Commit transaction
    return result, tx.Commit()
}
```

**Interview Focus:**
- Distributed transactions
- Exactly-once semantics
- Financial data accuracy
- PCI compliance considerations

### 6.2 Twitch - Live Streaming

**What They Built:**
- Chat service (IRC-compatible)
- Video transcoding pipeline
- Real-time analytics

**Key Pattern - Fan-out:**
```go
package chat

type ChatRoom struct {
    subscribers map[string]chan *Message
    mu          sync.RWMutex
}

func (cr *ChatRoom) Broadcast(msg *Message) {
    cr.mu.RLock()
    defer cr.mu.RUnlock()

    for _, ch := range cr.subscribers {
        select {
        case ch <- msg:
        default:
            // Slow consumer, skip
        }
    }
}

func (cr *ChatRoom) Subscribe(userID string) <-chan *Message {
    ch := make(chan *Message, 100)

    cr.mu.Lock()
    cr.subscribers[userID] = ch
    cr.mu.Unlock()

    return ch
}
```

**Interview Focus:**
- Real-time systems
- WebSocket scaling
- Video streaming protocols

### 6.3 Meta (Facebook) - Infrastructure Tools

**What They Built:**
- Proxygen (HTTP proxy)
- Wangle (network framework)
- Internal deployment tools

**Key Pattern - Service Discovery:**
```go
package discovery

type ServiceDiscovery struct {
    consul *api.Client
    cache  map[string][]*ServiceInstance
    mu     sync.RWMutex
}

type ServiceInstance struct {
    ID      string
    Address string
    Port    int
    Health  string
}

func (sd *ServiceDiscovery) GetService(name string) (*ServiceInstance, error) {
    sd.mu.RLock()
    instances, ok := sd.cache[name]
    sd.mu.RUnlock()

    if !ok || len(instances) == 0 {
        // Query service registry
        services, _, err := sd.consul.Health().Service(name, "", true, nil)
        if err != nil {
            return nil, err
        }

        instances = make([]*ServiceInstance, len(services))
        for i, s := range services {
            instances[i] = &ServiceInstance{
                ID:      s.Service.ID,
                Address: s.Service.Address,
                Port:    s.Service.Port,
            }
        }

        sd.mu.Lock()
        sd.cache[name] = instances
        sd.mu.Unlock()
    }

    // Load balance
    return instances[rand.IntN(len(instances))], nil
}
```

**Interview Focus:**
- Large-scale distributed systems
- Service mesh architectures
- Infrastructure as code

---
