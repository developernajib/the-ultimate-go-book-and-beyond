## Architecture Overview

The following diagram shows RabbitMQ's core topology: exchanges receive published messages, apply routing rules based on exchange type and binding keys, and forward matching messages to one or more queues where consumers subscribe. Grasping this flow is prerequisite to understanding why exchange type selection and binding configuration have such a large impact on message routing correctness and performance.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         RabbitMQ Broker                                     │
│                                                                             │
│  Virtual Host: /production                                                  │
│                                                                             │
│  ┌──────────┐    ┌────────────────────────────────────────────────────┐     │
│  │          │    │                  Exchanges                         │     │
│  │ Producer │───►│                                                    │     │
│  │  (Go)    │    │  [direct:orders]  [topic:logs]  [fanout:events]    │     │
│  │          │    │       │               │               │            │     │
│  └──────────┘    └───────┼───────────────┼───────────────┼────────────┘     │
│                          │               │               │                  │
│              Routing Key │         Wildcard #/*    All Bindings             │
│                          ▼               ▼               ▼                  │
│                    ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│                    │ orders.q │  │ error.q  │  │ email.q  │                 │
│                    │ (quorum) │  │(classic) │  │ push.q   │                 │
│                    │          │  │          │  │ webhook.q│                 │
│                    └────┬─────┘  └────┬─────┘  └────┬─────┘                 │
│                         │             │              │                      │
│                    Dead Letter        │              │                      │
│                    Exchange (DLX)     │              │                      │
│                         │             │              │                      │
│                    ┌────▼──────────────────────────────────┐                │
│                    │           Dead Letter Queue            │               │
│                    └───────────────────────────────────────┘                │
│                                                                             │
│  TCP Connection (one per service instance)                                  │
│  └── Channel 1 (producer goroutine)                                         │
│  └── Channel 2 (consumer goroutine)                                         │
│  └── Channel N (...)                                                        │
└─────────────────────────────────────────────────────────────────────────────┘

  Consumer Pool (Go)
  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │ Worker 1 │  │ Worker 2 │  │ Worker N │
  │ (gorout) │  │ (gorout) │  │ (gorout) │
  └──────────┘  └──────────┘  └──────────┘
```

### Junior → FAANG: Reading Architecture Diagrams in Interviews

The diagram above is the kind of topology diagram you will be asked to draw on a whiteboard at FAANG. Most junior candidates cannot reproduce it from memory because they learned the API without internalizing the component relationships. Fix this before your interview.

**How to read the diagram top-down:**

Start with the producer. It holds one TCP connection per process instance, not one per goroutine. Over that connection it opens channels. Each goroutine gets its own channel. The producer publishes to an exchange, never directly to a queue. The exchange applies routing rules and copies the message to zero or more queues. A consumer subscribes to a queue, not to an exchange. This separation of routing logic from consumption logic is the architectural reason RabbitMQ can handle fan-out, filtering, and priority in the broker without any application code.

**The dead-letter path is mandatory, not optional:**

The diagram shows a Dead Letter Queue as a first-class component, not an afterthought. At FAANG, any design that omits the DLQ path is rejected. The interviewer will ask: "what happens when a consumer rejects a message?" If you cannot answer "it routes to the DLX, which forwards it to the dead-letter queue for inspection and replay," you have missed a production-critical concern.

**Channel count is a resource, not a free variable:**

Each channel in the diagram is a lightweight virtual connection, but "lightweight" does not mean free. The broker tracks channel state per channel. A service that creates a new channel per published message exhausts broker resources under load. The correct model: one channel per long-lived goroutine, pooled and reused.

### Senior @ FAANG: Architecture Topology as a Contract

At the senior level, the architecture diagram is not descriptive, it is contractual. The topology (exchange names, queue names, binding keys, DLX routing) is the interface between producer services and consumer services. Changing it requires coordinated deployment, not a simple rollback.

**Topology as a versioned contract:**

In a microservices environment, the exchange name `orders` and the routing key `new` are as much a public API as an HTTP endpoint. If the payment service renames its exchange, every downstream consumer breaks. The governance answer is treating topology declarations as versioned infrastructure-as-code, provisioned via Terraform or a dedicated topology service, not ad hoc in application startup code.

**Vhost boundaries as blast-radius control:**

The diagram shows a single vhost `/production`. At scale, the correct model is one vhost per bounded context or team, not one global vhost. A consumer crash in the notifications domain should not contend for resources with the orders pipeline. Vhost isolation gives you independent memory alarms, connection quotas, and permission boundaries at zero additional broker cost.

**The DLX as an observability point:**

Senior engineers instrument the DLX path as a first-class metrics source. Every message that flows to the dead-letter queue is a signal: it either represents a bug in the consumer, a schema mismatch between producer and consumer, or a capacity problem. Alerting on DLQ depth above a threshold is a leading indicator of consumer health, often firing minutes before users report errors. This is why the diagram treats the Dead Letter Queue as a peer component to the work queue, not an edge case.

**Connection-per-process topology:**

The diagram shows one TCP connection per service instance. This is the correct model. The common mistake is one connection per goroutine or one connection per request. At 100 goroutines per service instance and 50 service instances, that is 5,000 TCP connections to a 3-node cluster. RabbitMQ defaults to a 128K connection limit, but even approaching 10K connections degrades performance due to Erlang process scheduling overhead. The connection-per-process model with channel multiplexing keeps connection count proportional to instance count, not to concurrency.

---
