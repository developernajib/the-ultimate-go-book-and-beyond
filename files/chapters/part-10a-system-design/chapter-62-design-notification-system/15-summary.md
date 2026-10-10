## Summary

This chapter built a notification system that routes events across email, SMS, push, and in-app channels at over 1 million notifications per minute:

- **Priority-partitioned queuing**: Separate Kafka topics per priority level prevent marketing email blasts from starving critical OTP delivery, with each topic independently scaled by consumer count
- **Channel-specific workers**: Each sender implements the same `NotificationSender` interface but handles provider-specific concerns, SendGrid API for email, Twilio REST for SMS, FCM multicast for push, with per-provider circuit breakers and failover chains
- **Idempotency and deduplication**: Redis-backed idempotency keys with TTL ensure retries after partial failures never produce duplicate notifications
- **User preferences as a gate**: The preference service is consulted synchronously at intake time, not as an afterthought, making opt-out compliance architecturally enforced rather than optional
- **Timezone-aware scheduling**: Quiet hours and daily digests are computed in the user's local timezone, avoiding the 3 AM marketing email problem
- **Delivery tracking**: Webhook handlers for SendGrid and Twilio translate provider-specific status events into a canonical schema, closing the loop between outbound send and inbound receipt

The central design principle is treating each channel's delivery semantics honestly: email is at-least-once, push can be silently dropped if the device is offline, and SMS is expensive and synchronous. Building separate pipelines per channel rather than forcing them into a uniform abstraction lets each path be optimized for its specific constraints.

### Junior -> FAANG: Consolidating the Chapter's Core Patterns

This chapter covers the complete lifecycle of a notification: intake validation, preference enforcement, channel fan-out, template rendering, priority queuing, worker processing, retry logic, delivery tracking, and webhook ingestion. Each component exists to solve a specific failure mode.

The two most important patterns to internalize before any interview: idempotency keys (prevent duplicate delivery during retries) and per-priority Kafka topics (prevent low-priority traffic from starving high-priority delivery). These two patterns address the two most common production failure modes for notification systems.

For interview preparation, practice drawing the architecture from memory: API Gateway, Notification Service, Priority Queue (Kafka with 4 topics), four channel worker pools (Email, SMS, Push, InApp), their provider integrations, and the webhook feedback loop from providers back to the Delivery Tracker. Being able to draw this in 90 seconds and explain each component in one sentence is the baseline for a system design interview on this topic.

### Senior @ FAANG: Platform Maturity and the Path Forward

The system built in this chapter is a solid production v2 notification platform. The path to FAANG-grade maturity requires three additional investments.

First, multi-tenancy: product teams must be able to onboard new notification types, define their aggregation policies, set their rate limits, and monitor their own delivery metrics without involving the platform team in every configuration change. This requires a self-service API for notification type registration, validated against a contract schema, with automated provisioning of the required Kafka topics and worker groups.

Second, observability at the notification type level: the platform must expose per-type delivery rates, engagement metrics, and SLA compliance dashboards that product teams can consume directly. The platform team should own the alerting infrastructure, and product teams should own the thresholds for their specific notification types.

Third, compliance automation: GDPR right-to-erasure requests must be processable end-to-end without manual engineering involvement. This requires an erasure API that deletes or anonymizes notification history, preference data, device token records, and delivery events for a specified user ID, within the legally required response window. Building this API as a first-class platform feature is the difference between a notification platform and a notification system.
