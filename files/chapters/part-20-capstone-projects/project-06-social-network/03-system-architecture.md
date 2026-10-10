## System Architecture

A social network backend requires multiple specialized services working together to handle user interactions, content delivery, and real-time communication. The architecture follows a microservices pattern where each service owns its data and communicates through well-defined APIs. This separation allows each service to scale independently based on its specific load characteristics, which is critical when some operations like feed generation are far more resource-intensive than others.

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Load Balancer (nginx)                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ├─────────────────────┬──────────────────────┐
                              ▼                     ▼                      ▼
                    ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
                    │   API Gateway    │  │  WebSocket API   │  │   GraphQL API    │
                    │   (Chi Router)   │  │   (Gorilla WS)   │  │   (gqlgen)       │
                    └──────────────────┘  └──────────────────┘  └──────────────────┘
                              │                     │                      │
         ┌────────────────────┼─────────────────────┼──────────────────────┤
         │                    │                     │                      │
         ▼                    ▼                     ▼                      ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  User Service   │  │  Post Service   │  │  Feed Service   │  │ Notification    │
│                 │  │                 │  │                 │  │   Service       │
└─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘
         │                    │                     │                      │
         └────────────────────┴─────────────────────┴──────────────────────┘
                              │
         ┌────────────────────┼─────────────────────┬──────────────────────┐
         ▼                    ▼                     ▼                      ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   PostgreSQL    │  │   Redis Cache   │  │    Neo4j        │  │  Elasticsearch  │
│   (Primary DB)  │  │   (Feed Cache)  │  │  (Social Graph) │  │    (Search)     │
└─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘

         ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
         │   Kafka/NATS    │  │   S3/MinIO      │  │   Prometheus    │
         │  (Event Stream) │  │  (Media Store)  │  │   (Metrics)     │
         └─────────────────┘  └─────────────────┘  └─────────────────┘
```

### Service Breakdown

#### 1. User Service
- User registration and authentication
- Profile management (CRUD)
- Avatar upload and processing
- Privacy settings
- Account verification
- User search

#### 2. Social Graph Service
- Follow/unfollow operations
- Follower/following lists
- Friend recommendations (2nd degree connections)
- Graph queries (shortest path, mutual followers)
- Graph analytics

#### 3. Post Service
- Create/edit/delete posts
- Like/unlike posts
- Comment on posts
- Media attachment handling
- Hashtag extraction and indexing
- Mention detection and notifications
- Post analytics (views, engagement)

#### 4. Feed Service
- Generate personalized feeds
- Rank posts by relevance
- Pagination (cursor-based)
- Feed caching and invalidation
- Hot/trending feed
- Fan-out on write vs read

#### 5. Notification Service
- Real-time notifications via WebSocket
- Notification types (likes, comments, follows, mentions)
- Notification preferences
- Read/unread tracking
- Notification history
- Push notification integration

#### 6. Media Service
- Image upload (S3/MinIO)
- Image resizing and thumbnails
- Video upload (basic)
- CDN integration
- Media metadata storage
- URL signing for private media

#### 7. Search Service
- User search (autocomplete)
- Post search (full-text)
- Hashtag search
- Trending topics
- Elasticsearch integration

---

### Junior → FAANG: Microservice Responsibilities as Interview Vocabulary

Each service in the social network architecture owns a specific domain: User Service owns identity and authentication, Social Graph Service owns follow relationships, Post Service owns content, Feed Service owns news feed generation, Notification Service owns event delivery. Knowing these boundaries and being able to state them clearly in an interview demonstrates systems thinking.

The most commonly asked question about social network architecture is "how do you generate the news feed?" The architecture shows two strategies: fan-out on write (Feed Service pre-computes each user's feed when a post is created) and fan-out on read (Feed Service builds the feed on request by fetching the user's following list and their recent posts). Know both and know the tradeoff: write time (celebrity problem, where a celebrity with 10M followers causes 10M feed updates per post) versus read time (slow for users following many active accounts).

### Senior @ FAANG: Service Boundaries as Team Ownership Map

At senior level, the service boundary diagram is simultaneously a technical boundary and an organizational boundary. Each service is owned by a team. The User Service team is on-call when authentication fails. The Feed Service team is on-call when feeds are slow. These ownership boundaries must be clear before the system goes to production.

The Feed Service is the most architecturally complex because it depends on User Service (for following list), Post Service (for post content), and Social Graph Service (for relationship weights). Any latency spike in any of these dependencies propagates to feed generation latency. Circuit breakers at each dependency, with graceful degradation (serve a slightly stale feed rather than timing out), are required for production resilience.

Cross-service data consistency is the hardest operational challenge in this architecture. When a user deletes their account, their posts must disappear from all followers' feeds, their follow relationships must be removed from the social graph, and their identity must be anonymized in the user service. This cascade requires a coordinated multi-service operation with appropriate rollback if any step fails. The ADR for account deletion must define the consistency guarantee (immediate consistency versus eventual consistency with a maximum delay) and the mechanism (Saga pattern, distributed transaction, or background reconciliation job).

---
