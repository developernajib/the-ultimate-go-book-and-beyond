## Architecture Overview: Network Debugging Framework

Network problems in Go services fall into four overlapping categories, latency, throughput, reliability, and connection management, each requiring a different diagnostic lens. Latency issues often originate in DNS resolution or TLS handshake overhead rather than actual data transfer, while throughput problems are frequently caused by undersized TCP receive windows or application-level serialization that prevents pipelining. Connection-related failures such as file descriptor exhaustion and port reuse errors are almost always the result of missing timeouts or response bodies that are never fully read, leaving connections in the kernel's `TIME_WAIT` state. A systematic approach, observe symptoms, isolate the responsible network layer, measure a baseline, then apply and verify a fix, prevents the common mistake of tuning at the wrong level.

```
┌───────────────────────────────────────────────────────────────────────┐
│                    Network Problem Taxonomy                           │
│                                                                       │
│  Latency Issues:                                                      │
│    DNS resolution →  TCP handshake →  TLS handshake →  TTFB           │
│    [0-50ms]         [1-10ms]         [10-100ms]        [varies]       │
│                                                                       │
│  Throughput Issues:                                                   │
│    Bandwidth cap → TCP window → Congestion → App serialization        │
│                                                                       │
│  Reliability Issues:                                                  │
│    Packet loss → TCP retransmits → RST storms → Connection resets     │
│                                                                       │
│  Connection Issues:                                                   │
│    FD leaks → TIME_WAIT exhaustion → Port exhaustion → Pool starvation│
│                                                                       │
│ ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐        │
│ │  Observe   │→ │  Isolate   │→ │  Measure   │→ │  Fix       │        │
│ │  symptoms  │  │  layer     │  │  baseline  │  │  & verify  │        │
│ └────────────┘  └────────────┘  └────────────┘  └────────────┘        │
└───────────────────────────────────────────────────────────────────────┘

Debugging Tool Stack:
  Application: pprof, httptrace, custom metrics
  Go runtime:  GODEBUG=http2debug=2, GODEBUG=netdns=go+2
  OS:          ss, netstat, tcpdump, wireshark
  Kernel:      /proc/net/tcp, /proc/net/snmp, sysctl
```

### Junior → FAANG: The Four Categories as a Triage Framework

The four categories (latency, throughput, reliability, connection management) are a triage framework, not just a taxonomy. When you receive a report of "the service is slow," the first question is: which category? Latency issues have a specific diagnostic path (httptrace, distributed tracing, DNS cache). Throughput issues have a different path (TCP receive window, serialization bottleneck, connection pool). Reliability issues have another path (error rate by type, retry rate, circuit breaker state). Connection management issues have yet another path (file descriptor count, socket state distribution, response body drain).

Using the category to direct the diagnostic reduces the time to find the root cause from hours of random exploration to minutes of targeted investigation. Practice the following for each category: what is the first metric you check, what tool provides it, and what are the two most common root causes?

### Senior @ FAANG: Framework Coverage and Its Limits

The systematic framework described in this section works for the categories it covers. The cases it misses are the hardest to debug: intermittent failures that occur under specific load patterns, cross-datacenter latency anomalies caused by BGP route changes, and packet loss from a single network switch that affects a subset of connections. These require packet-level analysis (Section 5) and correlation with infrastructure events, not just application-level metrics.

The L6 contribution to network debugging frameworks: documenting the escalation path when the four-category framework does not yield a root cause. At what point does the investigation escalate to packet capture? At what point does it escalate to the network engineering team? At what point does it require a kernel-level analysis with eBPF? Having explicit escalation criteria prevents both premature escalation (calling in network engineering when an httptrace analysis would have found the answer in 10 minutes) and insufficient escalation (spending days on application-level debugging for a problem that required a network change to fix).

---
