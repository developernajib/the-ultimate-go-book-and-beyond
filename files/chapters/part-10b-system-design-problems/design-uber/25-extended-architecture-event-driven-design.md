## Extended Architecture: Event-Driven Design

Kafka serves as the central nervous system connecting the microservices in this architecture. Trip state changes, payment completions, and driver lifecycle events are published to topics, and downstream services subscribe to what they care about and process independently. This decoupling means you can add a new analytics consumer or fraud detection system without modifying any existing service.

The first design question is what does *not* belong on the bus, and raw GPS is the answer. Putting every location fix through Kafka is the intuitive move and it is wrong twice over.

It is wrong on latency, because the location write is the hot path. A driver's fix has to be searchable in Redis within milliseconds for matching to work, and interposing a broker between the gateway and the Redis GEO index adds a hop and a consumer lag to the one write that cannot afford either. The gateway writes to Redis directly, exactly as the location service does in the core components section.

It is wrong on volume, and the arithmetic is worth doing:

```
1.25M fixes/sec x 86,400s        = 108 BILLION messages/day
across 100 partitions            = 12,500 msgs/sec/partition
at ~100 bytes/message            = 10.8 TB/day
with 24h retention at RF=3       = 32.4 TB resident on disk
```

That is a Kafka cluster larger than everything else in the design put together, existing to move data that Redis already has, so that a supply counter can count drivers. Publish the conclusion instead of the evidence: the supply reporter aggregates per H3 cell and emits a count every 30 seconds.

```
~200,000 active cells / 30s = ~6,700 msgs/sec
```

That is roughly 190x fewer messages for the same downstream answer. The general principle is worth more than the example: put derived, low-rate facts on the event bus and keep raw high-rate telemetry on a direct path to the store that needs it. An event bus is for things other services must *know*, not for everything your system happens to observe.

```
Kafka Topics:

1. trip-events (partitioned by trip_id, 64 partitions)
   - All trip state transitions
   - Partitioned by trip_id so one trip's transitions stay ordered on one
     partition. Kafka orders within a partition, not across them, and
     "completed" arriving before "on_trip" would corrupt every consumer.
   - Consumers: notification service, billing (charges the rider), analytics,
     fraud detection
   - Written by the trip service's transactional outbox relay, so an event
     exists if and only if the state change committed.

2. payment-events (partitioned by trip_id, 32 partitions)
   - Charge/refund/settlement events
   - Consumers: earnings calculator, accounting system, fraud detection

3. surge-signals (partitioned by h3_cell, 50 partitions)
   - Aggregated demand/supply counts per cell, NOT raw locations
   - Consumers: surge pricing engine

4. driver-events (partitioned by driver_id, 32 partitions)
   - Online/offline, acceptance, rating events
   - Consumers: driver scoring, dispatch fairness, quality monitoring

Retention: 7 days hot for events, then archived to object storage
Delivery: at-least-once. Every consumer must be idempotent, keyed on
          (trip_id, status) for trip events. A redelivered "completed" must
          not charge the rider a second time.
```

The delivery note is the one people skip. Kafka gives at-least-once, so duplicates are not an exotic failure, they are Tuesday: any consumer rebalance can replay the last uncommitted offsets. A billing consumer that treats redelivery as a new trip double-charges, which is why the charge path is keyed on the trip and backed by the `trip_id` unique constraint. Design consumers so that processing the same event twice is indistinguishable from processing it once, and the retry semantics stop being scary.

---
