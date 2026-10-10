# Chapter 96E: Legacy Modernization - Strangler Fig, Database Migration, and Incremental Rewrites

> "The only way to go fast, is to go well." - Robert C. Martin. And the only way to go well with a legacy system is to go incrementally.

Every sufficiently successful software system eventually becomes its own legacy. The monolith that shipped the first version of your product - perhaps a Ruby on Rails app, a Java EE application, or a PHP codebase - has accumulated years of business logic, implicit assumptions, and tribal knowledge that no one fully understands anymore. The temptation is a big-bang rewrite: stand up a new Go service, migrate everything at once, cut over on a weekend, and celebrate. The reality of big-bang rewrites is a graveyard of canceled projects, blown timelines, and production outages that destroyed more business value than the old system ever could. The patterns in this chapter exist because the industry learned this lesson the hard way, repeatedly.

The Strangler Fig pattern - named after the tropical fig tree that grows around and gradually replaces a host tree - is the foundational technique for incremental modernization. A Go reverse proxy sits in front of the legacy system. Initially, it forwards all traffic to the old service unchanged. As new Go implementations are proven in production, the proxy routes individual endpoints, user segments, or feature flags to the new service instead, while the legacy system handles everything else. The legacy system is never "migrated" in a single event. It is strangled over months or years as each route transfers ownership. At the end, the proxy routes nothing to the old system, and it is decommissioned silently.

Database migration is the hardest part of any modernization. Application code can be blue-green deployed, but databases cannot. The expand-contract pattern provides a safe path: first expand the schema to support both old and new code simultaneously (add new columns, never remove old ones), then migrate the application to use the new schema, then contract by removing the old columns after the old code is fully decommissioned. Dual-write patterns keep two data stores in sync during the transition. Shadow mode runs the new service against production traffic without serving its responses, validating correctness before any user is affected. This chapter equips you with every tool needed to modernize a production system without taking it down.

**What you'll learn in this chapter:**

- Implement the Strangler Fig pattern with a Go reverse proxy that incrementally routes traffic from a legacy system to new Go services based on feature flags and routing rules
- Apply branch-by-abstraction to introduce seams into a legacy codebase that allow new implementations to be swapped in without modifying call sites
- Build a feature flag system in Go that enables per-user, per-tenant, and percentage-based rollout of new service behavior with instant rollback capability
- Implement dual-write patterns that keep a legacy data store and a new data store synchronized during the migration window, with consistency verification
- Run new services in shadow mode - receiving production request copies and comparing responses against the legacy system without affecting live users
- Execute online database schema migrations using the expand-contract pattern, avoiding downtime and maintaining backward compatibility throughout
- Version APIs during migration so legacy clients continue working while new clients adopt the modernized interface without a forced cutover
- Instrument migration progress with structured metrics - percentage of traffic routed to new services, error rate deltas, latency comparisons, data consistency checks

**Why this matters at scale:**

Shopify's migration from their Rails monolith to modular Go services has been ongoing for years, using exactly the proxy-based routing and feature flag approach described here - their engineering blog documents the Strangler Fig application in detail. LinkedIn rewrote their entire backend incrementally over five years using shadow mode and dual-write patterns, never taking the service down while migrating hundreds of millions of user records. Amazon's decomposition of their original Perl monolith into what became AWS used the same incremental extraction: two-pizza teams took ownership of individual services one at a time, with the strangler proxy ensuring zero disruption to the consumer-facing monolith during the transition.

**Prerequisites:** Solid Go HTTP server knowledge, familiarity with reverse proxies and load balancers, and basic understanding of database migrations and SQL schema management.

### Junior → FAANG: Legacy Modernization as an Engineering Maturity Signal

Early-career engineers often encounter legacy modernization work and treat it as a problem to solve as quickly as possible: "let's just rewrite it." Understanding why incremental migration is vastly preferable to big-bang rewrites is one of the clearest signals of engineering maturity that exists, and being able to articulate this clearly in an interview or design discussion is a meaningful differentiator.

The core reason incremental migration beats big-bang rewrites: the business logic embedded in a successful legacy system is a large part of the value of that system. Big-bang rewrites routinely miss subtle behaviors that users depend on, edge cases that the original engineers learned the hard way, and implicit business rules that are not written in any specification. The Strangler Fig pattern preserves the ability to fall back to the legacy system at any point because the legacy system is never decommissioned until the replacement has been proven in production at full traffic.

The Go-specific advantage in modernization projects: Go's performance characteristics (low memory footprint, fast startup, predictable latency) make it an excellent language for the proxy layer that sits in front of a legacy system. A Go reverse proxy adds minimal overhead to each request, making it invisible to users while providing the routing and feature flag control that drives the migration.

For early-career engineers working on a modernization project for the first time: your most valuable contribution is often not writing the new service code but writing the observability and comparison infrastructure that validates that the new service matches the legacy service's behavior. Shadow mode testing, response comparison, and metric collection require careful implementation and are the foundation on which the entire migration depends.

### Senior @ FAANG: Modernization Governance at L6 and the ADR-Driven Migration Strategy

At senior level, legacy modernization is as much an organizational challenge as a technical one. The technical patterns in this chapter (strangler fig, dual-write, expand-contract) are well-established. The harder challenges are organizational: maintaining stakeholder alignment over a multi-year migration timeline, managing the engineering capacity required to build and maintain both the legacy system and the new system simultaneously, and preventing the migration from being canceled due to business priority shifts.

The governance practice that distinguishes successful senior-led modernizations from failed ones: write an ADR for every significant architectural decision in the migration strategy, share it broadly, and get explicit buy-in from all stakeholders before proceeding. The ADR should cover: why this approach over the alternatives (specifically why not a big-bang rewrite), what the migration milestones are and how success is measured at each stage, what the rollback plan is at each stage, and what organizational commitments are required to complete the migration. This document becomes the anchor for stakeholder conversations when business priorities shift and the migration is questioned.

The maturity model for senior modernization leadership: an L5 engineer can implement a strangler fig proxy correctly. An L6 engineer can design the full migration architecture, instrument it for safety, and drive the migration to completion including managing the organizational dynamics. An L7 engineer can define the modernization strategy for an entire product area across multiple teams, secure the organizational resources required, and govern the migration over a multi-year horizon while keeping business stakeholders aligned.

The specific Go-level governance decisions that staff engineers make in modernization projects: when to use generics versus interface-based polymorphism in the abstraction layer, how to structure the module boundaries between the proxy, the feature flag engine, and the new service, and how to design the shadow mode infrastructure to scale to production traffic levels without creating back-pressure. These decisions have consequences that compound over the migration timeline, and making them correctly requires both Go depth and systems architecture judgment.

---
