## Problem Statement

A production ad platform must solve two problems simultaneously: maximize revenue for publishers by showing the highest-value ad on every page load, and maximize return on ad spend for advertisers by targeting the right audience at the right time. These goals align most of the time but conflict when fraud enters the picture or when budget constraints require throttling high-performing campaigns.

Design an online advertising system (like Google/Facebook Ads):
- 1 trillion ad impressions per day (global scale)
- Real-Time Bidding (RTB): auction completes in < 100ms
- Serve relevant ads based on user targeting
- Track impressions, clicks, conversions
- Budget pacing (don't spend daily budget in first hour)
- Fraud detection (invalid clicks)
- Billing advertisers, paying publishers
- Support: display, video, search, social ad formats

The 100ms RTB constraint is the defining technical requirement. Within that window, the system must validate the incoming request, fan out bid requests to multiple external DSPs over the network, wait for responses (with timeouts for slow bidders), run fraud checks on the winning bid, deduct from the campaign budget atomically, serve the ad creative, and fire an impression tracking pixel. Every component on this critical path must be optimized for latency, and any non-essential work must happen asynchronously after the response is sent.

---
