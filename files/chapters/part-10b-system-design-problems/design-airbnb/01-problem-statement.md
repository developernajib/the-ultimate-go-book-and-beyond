## Problem Statement

A system design interview for Airbnb tests your ability to handle two fundamentally different workloads in one platform: high-throughput, latency-sensitive search and low-throughput, consistency-critical booking. The requirements below define the scale, features, and reliability targets you must address. Every architectural decision in the sections that follow traces back to one or more of these requirements.

Design Airbnb supporting:
- 7M active listings, 150M guests worldwide
- Search by location, dates, price, amenities
- Real-time availability calendar
- Booking with payment hold (pre-authorization)
- Host and guest reviews
- Messaging between hosts and guests
- Dynamic pricing recommendations
- 99.99% availability for booking

---
