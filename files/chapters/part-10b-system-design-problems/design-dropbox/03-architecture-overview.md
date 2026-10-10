## Architecture Overview

The high-level architecture separates file content storage from file metadata management, with a notification layer to keep devices in sync. This separation is critical because content (blocks) and metadata (file tree, versions) have very different access patterns and scaling requirements. Clients communicate through an API Gateway that routes requests to the appropriate backend service, and a notification service pushes change events so devices can sync in near-real-time.

```
Desktop/Mobile Client
        │
        │  HTTPS upload/download
        │  Long-poll or WebSocket for notifications
        ▼
┌──────────────────────────────────────────────────┐
│                  API Gateway                     │
└───────┬───────────────────┬──────────────────────┘
        │                   │
        ▼                   ▼
Metadata Service      Block Service
(file tree, versions) (content-addressed storage)
        │                   │
        ▼                   ▼
  PostgreSQL / MySQL    S3 (block storage)
  (file metadata)       + CDN
        │
        ▼
Notification Service
(sync trigger to other devices)
```

---
