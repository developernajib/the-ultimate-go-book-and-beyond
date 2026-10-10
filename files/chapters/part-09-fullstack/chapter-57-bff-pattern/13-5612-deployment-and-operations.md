## 57.12 Deployment and Operations

### Docker Compose for Development

The development Docker Compose file starts all three BFF services alongside their downstream stubs and a shared Redis instance, giving developers a realistic topology that mirrors staging without requiring cloud credentials. Using `depends_on` with health checks prevents BFF containers from starting before their dependencies are ready, eliminating the race conditions that cause flaky `docker compose up` runs. The configuration below mounts source directories as volumes and sets `GOPROXY` to a local Athens instance to speed up repeated builds.

```yaml
# docker-compose.yml
version: '3.8'

services:
  # BFF Services
  web-bff:
    build:
      context: ./services/web-bff
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    environment:
      - USER_SERVICE_URL=http://user-service:8080
      - PRODUCT_SERVICE_URL=http://product-service:8080
      - ORDER_SERVICE_URL=http://order-service:8080
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis
      - user-service
      - product-service
      - order-service

  mobile-bff:
    build:
      context: ./services/mobile-bff
      dockerfile: Dockerfile
    ports:
      - "8081:8080"
    environment:
      - USER_SERVICE_URL=http://user-service:8080
      - PRODUCT_SERVICE_URL=http://product-service:8080
      - ORDER_SERVICE_URL=http://order-service:8080
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis
      - user-service
      - product-service
      - order-service

  admin-bff:
    build:
      context: ./services/admin-bff
      dockerfile: Dockerfile
    ports:
      - "8082:8080"
    environment:
      - USER_SERVICE_URL=http://user-service:8080
      - PRODUCT_SERVICE_URL=http://product-service:8080
      - ORDER_SERVICE_URL=http://order-service:8080
      - ANALYTICS_SERVICE_URL=http://analytics-service:8080
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis
      - user-service
      - product-service
      - order-service
      - analytics-service

  # Backend Services
  user-service:
    build: ./backend-services/user-service
    ports:
      - "8090:8080"

  product-service:
    build: ./backend-services/product-service
    ports:
      - "8091:8080"

  order-service:
    build: ./backend-services/order-service
    ports:
      - "8092:8080"

  analytics-service:
    build: ./backend-services/analytics-service
    ports:
      - "8093:8080"

  # Infrastructure
  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"
```

### Junior -> FAANG: Understanding the Deployment Topology

The Docker Compose file above defines a development topology that mirrors production. Understanding it helps you reason about failure modes before they become incidents.

The `depends_on` field prevents a BFF container from starting before its dependencies are healthy, but it does not guarantee that the dependency is fully ready to serve traffic when the BFF starts. In production, BFFs implement startup probes that poll downstream service health endpoints before the BFF's readiness probe returns true. This prevents the "BFF starts, immediately receives traffic, fails because product service is still starting" race condition.

The separate port mapping for each BFF (8080, 8081, 8082) reflects the production pattern where each BFF is deployed as an independent service with its own load balancer and scaling group. Web traffic peaks during business hours. Mobile traffic peaks in the morning and evening. Admin traffic is relatively flat. Independent scaling lets you add web BFF instances during the business-hours peak without adding cost to the mobile or admin deployments.

A first-job habit: when you join a team, run `docker compose up` and verify that all services reach a healthy state before making any code changes. A broken local environment is a productivity sink that costs hours and creates self-doubt about whether your code changes are actually breaking things.

### Senior @ FAANG: Production Deployment Standards for BFF Services

At senior level, BFF deployment is governed by the same production standards as any other customer-facing service: canary deployments, health probes, SLOs, and runbooks.

Canary deployment is non-negotiable for BFF services that serve production traffic. A change to the web BFF response shape can break the web client immediately for all users if deployed all at once. Canary deployments route a small percentage (typically 1-5%) of traffic to the new version, monitor error rates and latency for a soak period (15-30 minutes), and promote automatically if the metrics are within bounds. The BFF deployment pipeline should integrate with your canary controller (Argo Rollouts, Spinnaker, AWS CodeDeploy) and halt automatically if the error rate on the canary exceeds the SLO threshold.

SLO definition for BFF services: a production web BFF should have a latency SLO (e.g., p99 response time under 500ms), an error rate SLO (e.g., less than 0.1% of requests return 5xx), and an availability SLO (e.g., 99.9% uptime). These SLOs must be tracked with real-time dashboards and alerts, and must be defined before the service launches, not after the first incident. The SLO targets should be aligned with the downstream client's user experience expectations: a mobile BFF with a 500ms p99 is likely causing user-visible delays on cellular connections.

Runbooks for BFF services should cover four scenarios: partial upstream failure (one service down, BFF serving degraded responses), full upstream failure (circuit breakers open, BFF serving fallbacks), BFF itself is slow (identify which upstream call is the bottleneck using per-service latency histograms), and BFF is OOM (identify which aggregator is allocating large intermediate structures). These runbooks should be written before the service launches and tested in a game day simulation before the first production traffic.

At staff level, you also define the on-call rotation model for BFF services. A BFF owned by a frontend team should be in that team's on-call rotation, not the platform team's. This is the ownership principle in action: if you own the service you are accountable for its availability. Establishing this norm organizationally is harder than implementing the technical deployment pipeline, but it is the difference between a healthy BFF ecosystem and one where frontend teams file tickets to the platform team when their BFF has an incident.

---
