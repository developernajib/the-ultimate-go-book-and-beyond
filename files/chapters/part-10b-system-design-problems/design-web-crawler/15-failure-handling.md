## Failure Handling

At internet scale, failures are not exceptional, they are constant. Networks drop connections, servers return errors, DNS resolution fails, and entire machines go down. A resilient crawler must classify each failure type, decide whether to retry, and choose an appropriate backoff delay. The sections below cover the three main failure categories: network errors during page fetching, frontier data loss, and worker machine crashes.

### Network Failure Classification

Not all HTTP errors deserve the same response. A 429 (rate limited) means you should back off for a long time, a 500 (server error) is likely temporary and worth retrying after a few minutes, and a 404 (not found) means the page is gone and retrying would be wasteful. This classifier maps each error type to a retry decision and delay duration, preventing the crawler from wasting cycles on permanently broken URLs.

Two rules deserve more weight than the rest. **When a server sends `Retry-After`, that is not a hint.** A 429 or a 503 with `Retry-After` is the server telling you, in the protocol's own words, exactly when to come back. A crawler that substitutes its own guess for an explicit instruction is precisely the badly-behaved bot that gets IP-banned, and the header costs nothing to honor. It comes in two forms, delta-seconds and an HTTP date, and you must parse both. **Not every transport error is worth retrying.** `NXDOMAIN` means the name does not exist, and it will not exist in five minutes either. Retrying it three times per URL across a domain that has vanished burns real resolver budget for a guaranteed failure.

```go
package crawler

import (
	"errors"
	"net"
	"net/http"
	"strconv"
	"time"
)

const maxRetryAfter = 24 * time.Hour

// ClassifyError decides whether a failed fetch is worth another attempt, and
// when. resp may be nil when the request never produced a response.
func ClassifyError(err error, resp *http.Response) (retryable bool, delay time.Duration) {
	if err != nil {
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			return false, 0 // NXDOMAIN: the host does not exist, retrying cannot help
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return true, 1 * time.Minute
		}
		return true, 5 * time.Minute // connection refused, reset, TLS failure
	}

	switch {
	case resp.StatusCode == http.StatusTooManyRequests: // 429
		// The server told us when to return. Obey it.
		if d, ok := retryAfter(resp); ok {
			return true, d
		}
		return true, 10 * time.Minute
	case resp.StatusCode == http.StatusServiceUnavailable: // 503
		if d, ok := retryAfter(resp); ok {
			return true, d
		}
		return true, 5 * time.Minute
	case resp.StatusCode >= 500:
		return true, 5 * time.Minute // server error, probably transient
	case resp.StatusCode == http.StatusNotFound: // 404
		return false, 0 // dead link
	case resp.StatusCode == http.StatusForbidden: // 403
		return false, 0 // forbidden, and often means we are already blocked
	default:
		return false, 0
	}
}

// retryAfter parses the Retry-After header, which is either delta-seconds
// ("120") or an HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT").
func retryAfter(resp *http.Response) (time.Duration, bool) {
	v := resp.Header.Get("Retry-After")
	if v == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs < 0 {
			return 0, false
		}
		return clampRetry(time.Duration(secs) * time.Second), true
	}
	if t, err := http.ParseTime(v); err == nil {
		d := time.Until(t)
		if d < 0 {
			d = 0
		}
		return clampRetry(d), true
	}
	return 0, false // unparseable, fall back to our own policy
}

// clampRetry bounds a server-supplied delay. Honor the header, but do not let a
// misconfigured site park a URL in the retry queue for a year.
func clampRetry(d time.Duration) time.Duration {
	if d > maxRetryAfter {
		return maxRetryAfter
	}
	return d
}
```

### Frontier Recovery

Losing the URL frontier (the Kafka topic containing all queued URLs) is a serious failure scenario because it represents your entire crawl queue. The recovery plan below describes how to rebuild the frontier from the PostgreSQL database and Bloom filter checkpoints, ensuring the crawler can resume without re-crawling billions of already-visited pages.

```
If Kafka frontier lost:
  1. Rebuild bloom filter from crawled_urls DB (~2 hours)
  2. Re-queue URLs where next_crawl <= NOW()
  3. Re-fetch seed URLs
  4. Resume crawling at reduced throughput

Prevention:
  Kafka RF=3, bloom filter checkpoints to S3 hourly,
  DB WAL backup to S3 continuously
```

### Worker Failure

Individual worker machines will inevitably crash or become unreachable. The system is designed so that no crawl progress is lost when a worker dies, because all durable state lives in Kafka (uncommitted offsets get re-delivered) and Redis (dedup records persist). The graceful shutdown path ensures that workers finish their in-flight requests and commit their Kafka offsets before exiting, preventing duplicate work during planned deployments.

```
1. Worker stops polling -> Kafka session timeout expires
2. Kafka consumer group rebalance -> partitions reassigned
3. In-flight URLs: re-delivered (uncommitted offsets)
4. No data loss: all state in Kafka + Redis

Graceful shutdown:
  SIGTERM -> stop accepting -> finish in-flight (30s deadline)
  -> commit offsets -> leave group -> exit
```

Note who detects the failure. Kafka's own consumer group protocol does, through `session.timeout.ms`, and its rebalance is what moves the partitions. The heartbeat in the worker coordination deep dive feeds dashboards and operator tooling, and it must not be wired up to reassign partitions as well, because two systems reassigning the same partition on different timeouts can leave two workers on one domain, each politely applying its own 1 req/sec limit.

Re-delivery makes the pipeline at-least-once, so plan for duplicates rather than being surprised by them. A worker that fetches a page and dies before committing its offset will have that URL re-delivered and re-fetched, which costs one extra request. The dedup layers absorb the rest: the Redis seen-set has already claimed the URL, and the content fingerprint matches an indexed page, so the duplicate is dropped rather than indexed twice.

---
