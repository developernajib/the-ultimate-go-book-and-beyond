## The Message Queue Landscape

Message queues occupy a critical role in distributed systems, decoupling producers from consumers to improve resilience and throughput. The following table maps the major systems (Kafka, RabbitMQ, NATS, and Redis Streams) across the dimensions that most influence architectural decisions: throughput, latency, delivery guarantees, and operational complexity.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Message Queue Decision Matrix                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  High Throughput          │  Complex Routing         │          │
│  Event Streaming          │  Task Queues             │          │
│  ┌──────────────┐         │  ┌──────────────┐        │          │
│  │    Kafka     │         │  │  RabbitMQ    │        │          │
│  │  1M+ msg/s   │         │  │  AMQP        │        │          │
│  │  Persistent  │          │  │  Flexible    │        │         │
│  └──────────────┘         │  └──────────────┘        │          │
│                           │                          │          │
│  Lightweight              │  Cloud-Native            │          │
│  Low Latency              │  Managed                 │          │
│  ┌──────────────┐         │  ┌──────────────┐        │          │
│  │    NATS      │         │  │  SQS/SNS     │        │          │
│  │  Simple      │          │  │  Serverless  │        │         │
│  │  Fast        │          │  │  AWS-native  │        │         │
│  └──────────────┘         │  └──────────────┘        │          │
│                                                                 │
│  Delivery Guarantees:                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐          │
│  │ At-Most-Once│  │At-Least-Once │  │ Exactly-Once   │          │
│  │Fire & forget│  │ With retries │  │ Idempotent +   │          │
│  │ UDP-style   │  │ Most common  │  │ Transactional  │          │
│  └─────────────┘  └──────────────┘  └────────────────┘          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---
