## Comprehensive Architecture Diagram

The diagram below shows three distinct data planes that must be independently scalable: the UDP/DTLS-SRTP media path through the SFU (latency-critical, handled at the edge), the WebSocket signaling path (low-bandwidth but ordering-sensitive), and the HTTPS control path for meeting management (stateless, but not cacheable, since almost every call on it is a mutation). Separating these planes is what lets you redeploy the signaling service without touching a single media packet in flight, and each path terminates at its own layer of the edge PoP before fanning out over the low-latency internal backbone.

Read the STUN and TURN boxes carefully, because the two are routinely conflated. STUN only tells a client what its public address looks like from outside, and then gets out of the way: the media flows directly from client to SFU. TURN actually **relays** the media, doubling the bytes across your network and adding a hop of latency, and it exists only for the clients that cannot be reached any other way, typically symmetric NATs and strict corporate firewalls. That is 10-20% of sessions in the wild and higher on locked-down enterprise networks, which is why TURN capacity is provisioned for a minority of traffic but never zero.

```
┌─────────────────────────────────────────────────────────────┐
│                    Client Application                       │
│  (Browser / Desktop / Mobile)                               │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────────┐   │
│  │WebRTC    │ │WebSocket  │ │REST API  │ │Audio/Video   │   │
│  │(media)   │ │(signaling)│ │(meeting) │ │Processing    │   │
│  └────┬─────┘ └─────┬─────┘ └────┬─────┘ │(background,  │   │
│       │             │            │       │ noise cancel)│   │
└───────┼─────────────┼────────────┼───────┴──────────────┴───┘
        │             │            │
   UDP/DTLS-SRTP  WebSocket      HTTPS
        │             │            │
┌───────▼─────────────▼────────────▼──────────────────────────┐
│                   Edge PoP (30+ cities)                     │
│  ┌───────────────┐  ┌────────────────┐  ┌───────────────┐   │
│  │ STUN          │  │  WebSocket     │  │  API Gateway  │   │
│  │ (NAT discovery│  │  Termination   │  │  (authn,      │   │
│  │  only)        │  │                │  │   rate limit) │   │
│  │ TURN          │  │                │  │               │   │
│  │ (relays media,│  │                │  │               │   │
│  │  10-20% only) │  │                │  │               │   │
│  └──────┬────────┘  └──────┬─────────┘  └──────┬────────┘   │
└─────────┼──────────────────┼───────────────────┼────────────┘
          │                  │                   │
        Internal Backbone (low-latency fiber)    │
          │                  │                   │
┌─────────▼─────────┐ ┌──────▼────────┐ ┌────────▼──────┐
│  SFU (Media       │ │  Signaling    │ │  Meeting      │
│  Server)          │ │  Service      │ │  Service      │
│  - Simulcast      │ │  - SDP/ICE    │ │  - CRUD       │
│  - ABR selection  │ │  - Room mgmt  │ │  - AuthZ      │
│  - Recording tap  │ │  - Host ctrl  │ │  - Scheduling │
└────────┬──────────┘ └───────────────┘ └───────────────┘
         │
    ┌────┴────────────────┐
    ▼                     ▼
┌──────────┐       ┌──────────────┐
│ Quality  │       │ Recording    │
│ Monitor  │       │ Service      │
│ (RTCP    │       │ (capture ->  │
│  stats)  │       │  S3 -> mix   │
└──────────┘       │  -> S3 final)│
                   └──────────────┘
```

---
