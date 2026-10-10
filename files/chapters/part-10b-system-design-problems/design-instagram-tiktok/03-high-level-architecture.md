## High-Level Architecture

This diagram shows how requests flow from mobile and web clients through the system. The load balancer and CDN sit at the edge, handling traffic distribution and serving cached media. Behind them, three core service groups handle distinct responsibilities: the API Gateway manages authentication and rate limiting, the Feed Service builds personalized timelines, and the Upload Service ingests new media. Each service talks to its own data store, which prevents one concern from overwhelming another. This separation of concerns is essential at scale because it lets you independently scale the read path (feeds) and the write path (uploads).

```
                         ┌─────────────────────────────────────┐
  Mobile/Web             │         Load Balancer / CDN         │
  Clients  ─────────────►│    (CloudFront/Akamai + L7 LB)      │
                         └──────────────────┬──────────────────┘
                                            │
               ┌────────────────────────────┼───────────────────────────┐
               │                            │                           │
               ▼                            ▼                           ▼
     ┌───────────────────┐        ┌───────────────────┐       ┌───────────────────┐
     │    API Gateway    │        │   Feed Service    │       │  Upload Service   │
     │(Auth, Rate Limits)│        │(Algorithm, Social)│       │  (Media Ingest)   │
     └─────────┬─────────┘        └─────────┬─────────┘       └─────────┬─────────┘
               │                            │                           │
     ┌─────────┴─────────┐        ┌─────────┴─────────┐       ┌─────────┴─────────┐
     │   User Service    │        │   Post Service    │       │ Media Processing  │
     │  (Profile/Follow) │        │  (Likes/Comments) │       │ (FFmpeg Transcode)│
     └─────────┬─────────┘        └─────────┬─────────┘       └─────────┬─────────┘
               │                            │                           │
     ┌─────────┴─────────┐        ┌─────────┴─────────┐       ┌─────────┴─────────┐
     │      User DB      │        │      Post DB      │       │   Object Store    │
     │    (Cassandra)    │        │    (Cassandra)    │       │    (S3 / GCS)     │
     └───────────────────┘        └─────────┬─────────┘       └───────────────────┘
                                            │
                                  ┌─────────┴─────────┐
                                  │    Cache Layer    │
                                  │  (Redis Cluster)  │
                                  └───────────────────┘
```

---
