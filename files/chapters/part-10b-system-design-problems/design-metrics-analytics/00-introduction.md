# System Design: Metrics and Analytics System

> At scale, you can't afford to store every event, but you can't afford to miss the ones that matter. Time-series databases and streaming aggregation let you have both.

A metrics and analytics system is the nervous system of any large-scale infrastructure. When it fails, teams lose visibility into production, alerts stop firing, and incidents go undetected. Designing one that ingests 1 million data points per second from 100,000 hosts, stores a year of historical data, and answers dashboard queries in under 5 seconds is a fundamentally different problem from building a typical CRUD application.

The raw ingest rate of 1M metrics/sec produces 8.6TB of data per day before compression. Time-series data compresses roughly 10:1 with columnar storage, bringing daily storage to about 1TB, which would still mean 365TB if a full year were kept at raw resolution. The system must support 10 million distinct metric series (100K hosts each reporting 100 metrics), evaluate 10,000 alert rules per minute, and serve 1,000 concurrent dashboard queries per second, all while maintaining sub-second data freshness for real-time monitoring.

The three hardest engineering problems are: (1) bridging the gap between the ingest rate (1M points/sec) and what the time-series database can absorb, which requires heavily batched inserts plus a stream aggregation layer that collapses six 10-second points into one 1-minute rollup row, cutting long-term write volume roughly 6x, (2) managing the cardinality explosion that occurs when high-cardinality tags like user IDs are attached to metrics, which can blow up storage and query times by orders of magnitude, and (3) implementing a two-tier retention policy where high-resolution data (10-second granularity) is kept for 7 days and automatically downsampled to 1-minute resolution for long-term storage, with the query layer transparently selecting the right tier.

This chapter walks through the full design:

- **Problem Statement** defines the ingestion, querying, and alerting requirements.
- **Capacity Estimation** translates ingest rate and retention into storage and bandwidth numbers.
- **Architecture Overview** shows the pipeline from host-level agents through Kafka, stream processing, and into ClickHouse.
- **Core Components** implements the ingest service, time-series storage with ClickHouse, the alert engine, and stream aggregation in Go.
- **Database Schema** covers the two-tier ClickHouse tables (raw and aggregated) plus PostgreSQL for alert rules.
- **Key Design Decisions** explains the choice of ClickHouse, two-tier retention, pre-aggregation, and alert deduplication.
- **Interview Follow-Ups** addresses high-cardinality tags, percentile computation, and clock skew.
- **Deep Dives** explore the query optimizer, agent-side pre-aggregation, dashboard query service, SLO monitoring, tag management, and composite alerting.
- **Scaling Strategy, Failure Handling, and Cost Analysis** cover production deployment concerns.
