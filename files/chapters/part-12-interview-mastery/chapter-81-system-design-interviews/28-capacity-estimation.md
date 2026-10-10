## Capacity Estimation

Users: 100M DAU
- Messages: 50 per user per day = 5B messages/day
- 5B / 86400 = 58K messages/second

Storage:
- Message: ~200 bytes average
- 5B × 200 = 1 TB/day
- 365 TB/year (with retention)

Connections:
- 100M concurrent WebSocket connections at peak
- Need ~10K connections per server = 10K servers


### Junior → FAANG: Estimating Capacity for Chat Systems

Chat systems have distinct capacity characteristics from file sync: messages are small (typically under 1KB), but the delivery latency requirement is strict (under 100ms end-to-end for good user experience), and the connection count per server is high (WebSocket connections are long-lived and stateful). Key estimates: daily active users times average messages per user per day gives message throughput. Concurrent users times connection overhead gives the memory requirement for the connection layer. A server maintaining 100k WebSocket connections needs roughly 1-2GB of memory just for connection state, which constrains the server instance type.

### Senior @ FAANG: Capacity Estimation Informing Connection Layer Architecture

At the senior level, the capacity estimate for a chat system's connection layer directly determines the architecture of the WebSocket gateway. If a single gateway server handles 100k connections and you have 10M concurrent users, you need 100 gateway servers. The interesting engineering question is how you route messages: when a message is sent to user B, how do you find which gateway server user B is connected to? This is the routing problem that requires a presence service or a distributed hash table of user-to-server mappings. At the staff level, the capacity estimate also informs the cost model: WebSocket servers are stateful and cannot be auto-scaled as aggressively as stateless API servers. You need baseline capacity for peak concurrent users, and the gap between peak and average determines how much idle capacity you carry. This feeds into the build-versus-buy decision: managed WebSocket services (Pusher, Ably, AWS API Gateway WebSocket) shift the operational burden but at higher per-connection cost.
