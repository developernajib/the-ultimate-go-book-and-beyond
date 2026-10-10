## Architecture Overview

The high-level architecture follows a layered approach. Users connect via persistent WebSocket connections to a Connection Service, which routes messages to the appropriate backend. The Chat Service handles message persistence and delivery logic, while the Media Service offloads large files to object storage with a CDN for fast downloads. An offline queue ensures that messages are never lost when a user is disconnected, and a Notification Service wakes up offline devices via push notifications.

```
User App (iOS/Android/Web)
        │
        ▼  WebSocket (persistent)
┌───────────────────────────────┐
│     Connection Service        │  (stateful, per-server routing)
│     1000 servers × 500K conns │
└────────────┬──────────────────┘
             │
    ┌────────┴──────────┐
    ▼                   ▼
Chat Service        Media Service
(Kafka, Cassandra)  (S3 + CDN)
    │
    ▼
Message Queue
(per-user inbox)
    │
    ▼
Notification Service
(APNs/FCM for offline)
```

---
