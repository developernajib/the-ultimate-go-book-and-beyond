## Problem Statement

Design a ticket booking system like Ticketmaster that handles both normal event browsing and extreme burst traffic during high-demand sales. The defining challenge is the traffic spike: a popular concert sale compresses months of revenue into 60 seconds, and any failure during that window results in irrecoverable lost sales and massive reputational damage. The requirements below define both operating modes.

- **Handle 100M users during high-demand sales**: The "Taylor Swift effect" generated 3.5 billion requests across the onsale day, the bulk of them compressed into the opening minutes. Normal browsing traffic is a few hundred QPS. The system must handle both extremes with the same infrastructure, pre-scaled for anticipated demand.
- **Prevent overselling**: Each seat must be sold exactly once. Overselling even a single ticket is a contractual violation that requires expensive compensation (refunds plus additional seats or cash payments). The PostgreSQL uniqueness constraint is the guarantee, the Redis hold is a fast-path guard that keeps the doomed 99% of requests away from the database.
- **Fair access via virtual queue**: Without a queue, bots with faster connections monopolize tickets. The virtual queue creates a fair, first-come-first-served ordering that transforms the thundering herd into a controlled stream. Queue position must be verifiable and tamper-proof.
- **Seat selection**: Users choose between picking specific seats from an interactive map and requesting "best available," where the system selects optimal contiguous seats based on section, row proximity, and center positioning.
- **Ticket transfers and resale marketplace**: Ticket holders can transfer tickets to other users or list them for resale. Anti-scalping measures cap resale prices at 120% of face value. Ownership transfer invalidates the original QR code and generates a new one.
- **Mobile ticket delivery via QR code**: Tickets are delivered as QR codes scanned at venue entry. Static codes are vulnerable to screenshot duplication, so high-value events use rotating SafeTix codes that change every 30 seconds.
- **Pre-sale and general on-sale events**: Fan clubs, credit card partners, and artist-selected groups get early access via presale codes. Each code has a usage limit enforced atomically to prevent over-redemption.
- **99.99% availability**: Allowing only 52 minutes of downtime per year. During a sale event, even 30 seconds of downtime can cost millions in lost revenue and permanent brand damage.

---
