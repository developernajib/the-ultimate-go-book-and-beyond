## 102B.10 Network Debugging Tools

### tcpdump: Capturing Traffic

`tcpdump` is the foundational network debugging tool for capturing and inspecting raw packet data at the kernel level, essential for diagnosing issues that are invisible to application-layer logging. Captured traffic is written to `.pcap` files that can be opened in Wireshark for graphical analysis or processed programmatically with Go's `gopacket` library. The BPF (Berkeley Packet Filter) expressions passed to tcpdump compile to kernel bytecode that filters packets before they are copied to userspace, keeping capture overhead minimal even on high-traffic interfaces.

```bash
# Capture all HTTP traffic on port 8080:
sudo tcpdump -i eth0 -nn 'tcp port 8080' -w capture.pcap

# Capture DNS queries:
sudo tcpdump -i eth0 -nn 'udp port 53' -A

# Capture and display HTTP request/response headers:
sudo tcpdump -i eth0 -nn -A 'tcp port 80 and (((ip[2:2] - ((ip[0]&0xf)<<2)) - ((tcp[12]&0xf0)>>2)) != 0)'

# Filter by host:
sudo tcpdump -i any host 10.0.1.5 and port 443
```

### curl: HTTP Debugging

`curl` is indispensable for testing HTTP endpoints directly from the terminal, providing granular insight into connection timings, TLS negotiation, redirects, and response headers. The `-w` flag with a custom format string breaks the request lifecycle into named phases (DNS lookup, TCP connect, TLS handshake, and time to first byte), making it easy to isolate which layer is introducing latency. Combining `-v` for full header tracing with `--trace-time` adds millisecond timestamps to every protocol event.

```bash
# Verbose output with timing breakdown:
curl -v --trace-time https://api.example.com/health

# Show timing breakdown (DNS, connect, TLS, first byte, total):
curl -o /dev/null -s -w "\
  dns_lookup:    %{time_namelookup}s\n\
  tcp_connect:   %{time_connect}s\n\
  tls_handshake: %{time_appconnect}s\n\
  first_byte:    %{time_starttransfer}s\n\
  total:         %{time_total}s\n" \
  https://api.example.com/health

# Test HTTP/2:
curl --http2 -v https://api.example.com/

# Test with specific TLS version:
curl --tlsv1.3 --tls-max 1.3 https://api.example.com/

# Custom headers and body (for API testing):
curl -X POST https://api.example.com/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice"}'
```

### openssl s_client: TLS Debugging

`openssl s_client` opens a raw TLS connection to a host and prints the full handshake transcript (negotiated cipher suite, protocol version, certificate chain, and ALPN result), making it the go-to tool for diagnosing certificate errors, mTLS failures, and protocol mismatches. Unlike `curl`, it operates below the HTTP layer, so it works with any TLS-wrapped protocol including gRPC, SMTP, and custom TCP services. Piping the output through `openssl x509` extracts structured certificate fields such as expiry dates and Subject Alternative Names.

```bash
# Inspect TLS certificate and handshake:
openssl s_client -connect api.example.com:443 -servername api.example.com

# Test specific TLS version:
openssl s_client -connect api.example.com:443 -tls1_3

# Test with client certificate (mTLS):
openssl s_client -connect api.example.com:443 \
  -cert client.crt -key client.key \
  -CAfile ca.crt

# Check certificate expiry:
echo | openssl s_client -connect api.example.com:443 2>/dev/null \
  | openssl x509 -noout -dates

# Verify ALPN negotiation:
openssl s_client -connect api.example.com:443 -alpn h2 2>/dev/null | grep ALPN
```

### dig: DNS Debugging

`dig` queries DNS servers directly and returns the full response including answer records, authoritative nameservers, TTLs, and query timing (far more detail than tools like `nslookup`). The `+trace` flag walks the full delegation chain from root nameservers down to the authoritative server, which is essential for debugging propagation issues and misconfigured delegations. Specifying a custom resolver with `@8.8.8.8` bypasses the system stub resolver, allowing you to compare responses between resolvers and detect split-horizon or caching problems.

```bash
# Basic A record lookup:
dig api.example.com A

# Lookup against a specific resolver:
dig @8.8.8.8 api.example.com A

# Full DNS resolution trace:
dig +trace api.example.com

# SRV record lookup (for gRPC service discovery):
dig _grpc._tcp.example.com SRV

# Check negative caching (NXDOMAIN TTL):
dig nonexistent.example.com A

# Reverse lookup:
dig -x 203.0.113.10
```

### ss/netstat: Socket State Inspection

`ss` (socket statistics) is the modern replacement for `netstat`, reading directly from the kernel's TCP state table via netlink for dramatically faster output on hosts with thousands of connections. The key use case in production is monitoring `TIME_WAIT` accumulation, which indicates rapid connection cycling and can exhaust ephemeral ports if left unchecked. Combining `ss` with `awk`, `sort`, and `uniq -c` produces a per-state connection count summary in a single command, giving an instant view of connection health.

```bash
# Show all listening sockets:
ss -tlnp

# Show TCP connections with process info:
ss -tnp

# Count sockets by state (useful for TIME_WAIT monitoring):
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn

# Show connections to a specific port:
ss -tnp dst :443

# Monitor socket states in real-time:
watch -n1 'ss -tan | awk '"'"'NR>1 {print $1}'"'"' | sort | uniq -c'
```

---

### Junior → FAANG: Network Debugging Tools as On-Call Essentials

The tools in this section are most valuable when you know which one to reach for first. For application-level HTTP debugging (headers, timing breakdown), `curl -v` is the right tool. For socket state inspection (are connections pooled, are there TIME_WAIT connections accumulating?), `ss -t` or `netstat -t` is the right tool. For DNS debugging (is resolution slow, is the right record being returned?), `dig` is the right tool. For low-level packet inspection (what is actually on the wire?), `tcpdump` or Wireshark is the right tool.

The most commonly needed diagnostic in production Go services: `ss -t state ESTABLISHED | wc -l` to count active TCP connections, and `ss -t state TIME_WAIT | wc -l` to check for TIME_WAIT accumulation. A large TIME_WAIT count indicates that connections are being closed rather than reused, pointing to a connection pooling configuration problem.

First-job habit: practice these tools on a local service before you need them in an incident. Run `curl -v` against your local service and understand every line of output. Run `ss -t` while a test is running and understand what you see. Building familiarity in low-pressure situations makes incident response faster and less stressful.

### Senior @ FAANG: Network Debugging as Incident Response Competency

At staff level, network debugging competency is measured by diagnostic speed under pressure: how quickly can you identify the root cause of a networking-related incident and propose a fix? The engineers who can do this quickly are the ones who have practiced these tools extensively and have mental models for the most common failure patterns.

The structured incident investigation approach for networking issues: (1) Identify the layer (application, HTTP, TLS, TCP, DNS, or physical). (2) Measure the latency contribution at each layer using `curl --resolve` with timing output. (3) Narrow the scope (is the issue affecting all endpoints or specific ones, all backends or specific instances). (4) Collect evidence (tcpdump for packet-level investigation, distributed traces for cross-service latency attribution). (5) Propose and test a fix.

The distributed tracing investment pays dividends specifically in networking incidents: if every service emits spans for each outgoing HTTP request with DNS resolution time, TLS handshake time, and first-byte time as span attributes, the networking investigation at step 3 becomes a dashboard query rather than manual tcpdump analysis. Building this tracing instrumentation into the shared HTTP client library is the staff engineer contribution that makes future networking investigations faster for every team.
