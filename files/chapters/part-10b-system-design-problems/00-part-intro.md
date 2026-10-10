# Part 10B: System Design Interview Problems

*System design interviews don't test if you know the answer. They test if you can think through the problem.*

---

FAANG system design interviews draw from a pool of 50+ design problems, and you will face one to two design rounds in every on-site interview. At senior level (L5+), these rounds carry more weight than coding: a strong system design performance can compensate for a mediocre coding round, but the reverse is rarely true. Each problem tests different distributed systems concepts: fan-out patterns for social media feeds, geospatial indexing for ride-sharing services, real-time collaboration protocols for document editors, and low-latency order matching for trading systems. The breadth of topics means you cannot afford to encounter a problem category for the first time during an interview.

This part provides twenty complete system design solutions, each implemented with Go code for the critical components. These are not surface-level overviews. Each design walks through requirements gathering, back-of-the-envelope estimation, high-level architecture, deep dives into three to four critical components, Go implementation of key algorithms and data structures, bottleneck analysis, and the specific tips that interviewers use to differentiate candidates. The problems span social media, messaging, streaming, logistics, payments, search, collaboration, and emerging domains like LLM serving.

The value of practicing system design is not memorizing solutions, it is building the structured thinking that lets you decompose any unfamiliar problem. After working through twenty designs, you will have internalized the recurring patterns, trade-offs, and estimation techniques.

**What this part covers:**
- Design Instagram/TikTok - feed generation, media storage, CDN, and recommendation engines
- Design Twitter/X - fan-out on write versus read, timeline assembly, trending topics, and the celebrity problem
- Design YouTube/Netflix - video transcoding pipelines, adaptive bitrate streaming, CDN delivery, and recommendation
- Design Uber/Lyft - geospatial indexing, driver-rider matching, real-time tracking, and ETA prediction
- Design WhatsApp - real-time messaging, end-to-end encryption, presence indicators, and read receipts
- Design Google Search - web crawling, inverted index construction, PageRank, and query serving
- Design Google Docs - real-time collaboration with OT/CRDTs, conflict resolution, and operational transformation
- Design Payment System - distributed transactions, idempotency, reconciliation, and ledger design
- Design Dropbox - file synchronization, chunking, deduplication, and conflict resolution
- Design Airbnb - search and availability, booking transactions, pricing algorithms, and review systems
- Design Spotify - audio streaming, playlist management, recommendation, and offline sync
- Design Autocomplete - trie-based prefix matching, ranking algorithms, and personalized suggestions
- Design Web Crawler - politeness policies, URL frontier management, deduplication, and distributed crawling
- Design Metrics Platform - time-series data ingestion, aggregation pipelines, and alerting systems
- Design Food Delivery - logistics optimization, ETA prediction, dispatch algorithms, and surge pricing
- Design Stock Exchange - order matching engines, low-latency design, market data distribution, and compliance
- Design Zoom - WebRTC architecture, SFU versus MCU topologies, recording, and quality adaptation
- Design Ad System - real-time bidding, targeting, click tracking, and auction mechanisms
- Design Ticket Booking - seat locking with distributed transactions, waitlist management, and fairness
- Design LLM Serving - model serving infrastructure, RAG pipelines, vector databases, and inference caching

**How to use this part:**
Each design follows a consistent seven-step framework: requirements, estimation, high-level design, deep dive, Go implementation, bottlenecks and trade-offs, and interview tips. Practice by attempting each design on your own for 35-40 minutes before reading the solution. Focus on three to four designs per week, and revisit earlier designs after completing later ones, you will find new insights as your knowledge grows. Prioritize the problems most relevant to your target companies.

**FAANG relevance:**
These twenty problems cover the most frequently asked system design questions at Google, Meta, Amazon, Netflix, Microsoft, and Uber. Interviewers at each company have preferred problems: Google favors search and infrastructure designs, Meta emphasizes social and real-time systems, Amazon focuses on e-commerce and logistics, and Netflix asks about streaming and recommendation. Completing this part prepares you for the specific questions you are most likely to encounter, while building design fluency that transfers to unfamiliar problems.

---
