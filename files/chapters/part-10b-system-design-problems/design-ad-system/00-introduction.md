# System Design: Ad System - Real-Time Bidding Platform

> The entire ad auction, fanning bid requests out to DSPs, selecting the winner, logging the impression, must complete in 100ms. The internet economy runs on this constraint.

An ad system is one of the most demanding real-time distributed systems you can design. At 1 trillion impressions per day (11.6 million auctions per second), every architectural decision has measurable financial impact. A 10ms increase in auction latency reduces bid participation, lowering revenue. A 0.1% increase in fraud goes undetected, costing advertisers millions. A budget pacing bug that spends a campaign's daily budget in the first hour destroys advertiser trust.

The three hardest engineering problems in this system are: (1) completing a full RTB auction, fan out bid requests to multiple DSPs, collect responses, select a winner, log the event, within a strict 100ms end-to-end budget, which requires aggressive parallelism and careful timeout management, (2) enforcing real-time budget constraints across millions of concurrent auctions without introducing a global bottleneck, since every impression must atomically check and deduct from a campaign's remaining budget, and (3) detecting fraudulent clicks and impressions in real time while minimizing false positives that would block legitimate revenue.

At this scale, you are processing 100TB of raw impression data per day, handling 116 million bid requests per second across all DSPs, and tracking 58,000 clicks per second with sub-second deduplication. The system must support multiple ad formats (display, video, native, search), multi-currency billing, and a complete event pipeline from impression to conversion attribution.

This chapter walks through the full design:

- **Problem Statement** defines the functional and non-functional requirements.
- **Capacity Estimation** translates business requirements into concrete engineering numbers.
- **Architecture Overview** shows the end-to-end pipeline from publisher request to billing.
- **Core Components** implements the auction engine, budget service, ad targeting, and click tracking in Go.
- **Database Schema** covers PostgreSQL for campaign configuration and ClickHouse for event logs.
- **Key Design Decisions** explains why second-price auctions, budget pacing, and impression validation work the way they do.
- **Interview Follow-Ups** addresses common deep-dive questions.
- **API Design** defines the REST endpoints for advertisers, publishers, and the auction system.
- **Deep Dives** explore fraud detection, the ad serving pipeline, frequency capping, viewability tracking, creative rendering, and real-time reporting.
- **Scaling Strategy, Failure Handling, and Cost Analysis** round out the production concerns.
