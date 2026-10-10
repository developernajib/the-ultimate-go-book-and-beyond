## Architecture

GatewayGo's internal structure separates request processing into two distinct layers. The plugin chain is a sequential pipeline where each plugin inspects or mutates the request and can short-circuit execution by returning an error response early, for example, the Auth plugin rejects unauthenticated requests before they ever reach the load balancer. The load balancer layer maintains a registry of upstream targets, continuously monitors their health via configurable probes, and removes unhealthy targets from rotation without requiring a configuration reload.

```
┌───────────────────────────────────────────────────┐
│                    API Gateway                    │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │                Plugin Chain                 │  │
│  │    Auth → Rate Limit → Transform → Route    │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │                Load Balancer                │  │
│  │     Target 1  │  Target 2  │  Target 3      │  │
│  └─────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```



## Performance

- **Throughput**: 10,000+ req/s per instance
- **Latency**: <1ms added latency
- **Memory**: ~100MB base usage
- **Scalability**: Horizontal scaling
