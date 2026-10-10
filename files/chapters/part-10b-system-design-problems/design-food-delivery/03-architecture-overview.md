## Architecture Overview

The system follows a microservices architecture where each service owns a single domain responsibility. The API Gateway acts as the single entry point for all three client types (customer app, driver app, restaurant tablet). Services communicate asynchronously through Kafka events for loose coupling, while Redis handles the real-time data like driver locations and dispatch state. This separation ensures that a failure in the surge pricing engine, for example, does not bring down order placement.

```
Customer/Driver/Restaurant App
         │  HTTPS + WebSocket
         ▼
┌──────────────────────────────────────────┐
│             API Gateway                  │
└──────────┬──────────────────┬────────────┘
           │                  │
    ┌──────▼──────┐    ┌──────▼──────┐
    │  Order      │    │  Dispatch   │
    │  Service    │    │  Service    │
    └──────┬──────┘    └──────┬──────┘
           │                  │
    ┌──────▼──────┐    ┌──────▼──────┐
    │  Restaurant │    │  Location   │
    │  Service    │    │  Service    │
    └─────────────┘    └─────────────┘
           │
    Payment + Notification Services
```

---
