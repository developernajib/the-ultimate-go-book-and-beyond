## Problem Statement

Design a typeahead/autocomplete system that returns ranked suggestions as the user types each character. The system must feel instantaneous, any perceptible delay between a keystroke and the appearance of suggestions breaks the user experience and increases abandonment rates. The requirements below define the scale, latency targets, and feature scope you must address.

- **Return top-10 suggestions as user types**: Each keystroke generates a prefix query. For a 5-character query like "golan", the system processes 5 sequential requests (one per character typed).
- **Support 100K QPS with < 100ms P99 latency**: The P99 budget includes network round-trip time, leaving approximately 20ms for server-side computation. This constraint eliminates any design that requires database queries on the hot path.
- **Suggestions ranked by popularity/relevance**: Raw frequency alone is insufficient, a logarithmic scale prevents dominant terms from crowding out everything else, and a recency boost surfaces trending topics.
- **Support prefix matching**: Typing "go" should return suggestions like "golang", "google", and "goroutine", ranked by their computed scores.
- **Update suggestions in near-real-time**: When a news event breaks, related search terms should appear in suggestions within minutes, not hours. This requires a streaming pipeline from search events to trie updates.
- **Personalized suggestions**: Users expect to see their own recent searches alongside global suggestions. A 50/50 blend of personal and global results is the target.
- **Multiple domains**: The same infrastructure should support web search, product search, and user mention autocomplete, each with its own trie and domain-specific metadata.

---
