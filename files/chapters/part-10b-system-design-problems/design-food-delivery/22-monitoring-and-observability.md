## Monitoring and Observability

A food delivery system has a very tight feedback loop: if something breaks, customers notice within minutes because their food is late or their tracking stops updating. Monitoring must cover both business metrics (order rates, ETA accuracy, cancellation rates) and technical metrics (latency, consumer lag, connection counts). Distributed tracing ties all of these together by assigning a single trace ID to each order, so you can follow a request across every service it touches when debugging production issues.

```
Distributed Tracing (Jaeger/Zipkin):
  Every order gets a trace ID at creation. All downstream services
  propagate this trace ID through HTTP headers and Kafka messages.

  Trace for a typical order:
    [API Gateway] -> [Order Service: PlaceOrder] -> [Payment Service: Charge]
                                                  -> [Restaurant Service: Notify]
                                                  -> [Dispatch Service: FindDriver]
                  -> [Location Service: UpdateLocation] (async, continuous)
                  -> [Tracking Service: WebSocket broadcast]
                  -> [Notification Service: Push notification]

  P99 latency targets:
    PlaceOrder:        < 2 seconds (payment dominates)
    DispatchDriver:    < 3 minutes
    LocationUpdate:    < 50ms
    WebSocket push:    < 100ms
    StatusUpdate:      < 200ms

Dashboards (Grafana):
  1. Order Flow Dashboard:
     - Orders/min (line chart by city)
     - Conversion funnel: browse -> cart -> order -> delivered
     - Average order value (rolling 1 hour)
     - Cancellation rate by reason

  2. Dispatch Dashboard:
     - Time to first driver offer (P50, P95, P99)
     - Driver acceptance rate by city
     - Average number of offers before acceptance
     - Unmatched orders (no driver found)

  3. ETA Accuracy Dashboard:
     - Predicted vs actual delivery time (scatter plot)
     - Mean absolute error by restaurant
     - Percentage of orders delivered within ETA window
     - ETA error distribution histogram

  4. Infrastructure Dashboard:
     - API latency percentiles (P50, P95, P99)
     - Kafka consumer lag by topic
     - Redis cluster memory usage and ops/sec
     - PostgreSQL connection pool utilization
     - WebSocket connection count

Alerting (PagerDuty integration):
  Critical (pages on-call):
    - Order placement failure rate > 5% for 5 minutes
    - Payment service circuit breaker open
    - Kafka consumer lag > 50K messages
    - Any Redis master node down

  Warning (Slack notification):
    - ETA error > 15 min for > 10% of orders
    - Driver acceptance rate < 50% in any city
    - API P99 latency > 1 second
    - Database replica lag > 30 seconds
```


---
