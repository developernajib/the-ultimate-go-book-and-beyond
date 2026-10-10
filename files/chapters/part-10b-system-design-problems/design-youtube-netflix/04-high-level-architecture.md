## High-Level Architecture

This diagram shows how all the major components connect. Video bytes and API calls travel two different paths, and keeping them separate in your head is the key to the whole design. Segments go client → CDN edge → origin object store, and over 95% of them stop at the edge. They never touch a service you wrote. API calls (upload initiation, metadata, playback authorization, recommendations) go client → API gateway → services, and they carry no video at all. That split is why a platform serving 208 Tbps can run its control plane on an unremarkable number of servers: the expensive path has no application logic on it.

```
                    DATA PLANE                     CONTROL PLANE
                (segments, ~all bytes)      (JSON, ~none of the bytes)

  Clients ──────────────┐                             ┌────────────► ┌──────────────────┐
  (Smart TV,            │                             │              │   API Gateway    │
   Mobile, Web) ────────┼─────────────────────────────┘              │ auth, rate limit │
                        │                                            └────────┬─────────┘
                        ▼                                                     │
        ┌────────────────────────────────────┐              ┌─────────────────┼──────────────────┐
        │  CDN Edge Network (200+ PoPs)      │              │                 │                  │
        │  CloudFront / Akamai / Netflix OC  │              ▼                 ▼                  ▼
        └──────────────┬─────────────────────┘     ┌─────────────┐  ┌──────────────────┐  ┌──────────────┐
                       │ cache miss (~5%)          │ Upload API  │  │ Streaming Service│  │Recommendation│
                       ▼                           │             │  │ authorize + sign │  │   Service    │
        ┌────────────────────────────────────┐     └──────┬──────┘  └────────┬─────────┘  └──────────────┘
        │  Origin: Object Store (S3/GCS)     │◄───────────┘                  │
        │  videos/{id}/{quality}/seg_N.m4s   │                               ▼
        └──────────────▲─────────────────────┘                  ┌────────────────────┐
                       │ writes                                 │ Video Metadata DB  │
        ┌──────────────┴─────────────────────┐                  │  (MySQL + Redis)   │
        │       Transcoding Pipeline         │                  └────────────────────┘
        │  raw/{id}/original → SQS → Workers │
        │  FFmpeg → 6 rungs → CMAF segments  │
        └────────────────────────────────────┘
```

Trace a playback: the client asks the streaming service for authorization, gets a manifest URL plus signed cookies, and from that moment on every byte it fetches comes from the CDN. A cache miss reaches the object store directly. The streaming service is never in the path of a segment, which is exactly why it can be a small service while the delivery path is planetary.

---
