## Key Design Decisions

This section captures the most important architectural trade-offs in the system. In a real interview, interviewers expect you to not only describe your design but also explain why you chose one approach over another. Each decision below addresses a specific tension, for example, consistency versus latency in search, or safety versus user experience in payments. Understanding these trade-offs is what separates a strong system design answer from a surface-level one.

**Availability Hold Pattern:** Dates held for 10 minutes in Redis during booking flow, which avoids holding a DB lock for the full checkout. If payment fails, the hold expires automatically. The hold is only the first line of defense: the overlap re-check inside the booking transaction and the schema's exclusion constraint are what actually guarantee no double-booking.

**Two-Phase Payment:** Authorize (hold funds) when the guest begins checkout, capture (charge) once the booking is confirmed: in the same session for Instant Book, on host acceptance for Request-to-Book. Capture cannot wait until check-in because card authorizations expire after roughly 7 days and bookings are made weeks or months in advance. The guest is charged at confirmation, but the host is not paid until 24 hours after check-in, which gives the platform a dispute window without touching the guest's card again. Void the authorization if the request is declined or the booking is canceled.

**Search Decoupled from Availability:** Elasticsearch returns candidate listings based on location/filters. Availability check is a separate batch query (SQL). This prevents the availability check from blocking search performance. Trade-off: may show slightly stale availability in search results.

**Elasticsearch for Listings:** Geospatial + full-text + filter queries. ES `geo_distance` query efficiently finds listings within radius. Listings are indexed asynchronously when created/updated.

---
