## Go Implementation: Anti-Bot Service

Scalper bots are the biggest threat to fair ticket access. They can generate thousands of requests per second, overwhelming the queue and buying tickets before real fans get a chance. This service implements a multi-signal scoring system that evaluates each request on IP rate, device fingerprint frequency, datacenter IP ranges, client-reported behavioral signals, and account age. Requests scoring above 0.7 are blocked outright, while borderline scores (0.4 to 0.7) trigger a CAPTCHA challenge.

Two honest caveats belong here, because this is an area where designs get graded on wishful thinking.

The behavioral signals are *client-supplied*. Mouse movement counts and time-since-page-load arrive in the request body, and a bot can put whatever it likes there. They filter unsophisticated scripts that do not bother to lie, and a serious scalper sets `mouse_movements: 47` and moves on. Treat them as weak priors that raise the cost of a naive attack, never as evidence.

And proof-of-work is a speed bump, not a wall. Run the numbers the design itself implies: a difficulty of 20 bits is about a million hashes, roughly half a second of browser CPU. An attacker running a thousand parallel workers spends a thousand CPU-seconds, which is a rounding error on a cloud bill, to chase tickets worth thousands of dollars. Proof-of-work meaningfully taxes the naive high-rate script and is close to irrelevant against a funded scalper. The measures that actually move the needle are the ones that make identity expensive rather than CPU expensive: Verified Fan registration days ahead of the sale, purchase limits bound to payment instruments, and post-purchase detection with cancellation.

```go
package antibot

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net/netip"
	"time"

	"github.com/redis/go-redis/v9"
)

// AntiBotService detects and blocks automated ticket purchases
type AntiBotService struct {
	rdb *redis.Client
}

type BotCheckResult struct {
	IsBot          bool     `json:"is_bot"`
	Score          float64  `json:"score"` // 0-1, higher = more likely bot
	Reasons        []string `json:"reasons"`
	RequireCAPTCHA bool     `json:"require_captcha"`
}

// CheckRequest evaluates if a request is from a bot.
//
// Fails closed: if the signals cannot be read, the request is challenged with a
// CAPTCHA rather than waved through. A rate limiter that returns "0 requests
// so far" when Redis is unreachable is an open door precisely during the
// incident an attacker is causing.
func (s *AntiBotService) CheckRequest(ctx context.Context, req BotCheckRequest) *BotCheckResult {
	result := &BotCheckResult{}

	// 1. Rate limiting per IP
	ipCount, err := s.hitCount(ctx, "ip", req.IP)
	if err != nil {
		return &BotCheckResult{RequireCAPTCHA: true, Score: 0.5,
			Reasons: []string{"signal_unavailable"}}
	}
	if ipCount > 10 { // 10 requests/min per IP
		result.Score += 0.3
		result.Reasons = append(result.Reasons, "high_request_rate")
	}

	// 2. Device fingerprint check
	fpCount, err := s.hitCount(ctx, "fp", req.Fingerprint)
	if err != nil {
		return &BotCheckResult{RequireCAPTCHA: true, Score: 0.5,
			Reasons: []string{"signal_unavailable"}}
	}
	if fpCount > 5 {
		result.Score += 0.3
		result.Reasons = append(result.Reasons, "fingerprint_rate_exceeded")
	}

	// 3. Datacenter IP ranges. A signal, not a verdict: corporate VPNs, cloud
	// gaming, iCloud Private Relay and carrier CGNAT all put real fans on
	// these ranges, so this is weighted to contribute to a CAPTCHA rather than
	// to an outright block on its own.
	if isDatacenterIP(req.IP) {
		result.Score += 0.3
		result.Reasons = append(result.Reasons, "datacenter_ip")
	}

	// 4. Behavioral signals. Client-reported and therefore trivially forged:
	// these catch lazy scripts, and weigh accordingly.
	if req.MouseMovements == 0 {
		result.Score += 0.2
		result.Reasons = append(result.Reasons, "no_mouse_movement")
	}
	if req.TimeSincePageLoad < 500 { // < 500ms to click
		result.Score += 0.2
		result.Reasons = append(result.Reasons, "suspiciously_fast")
	}

	// 5. Account age
	if req.AccountAgeDays < 1 {
		result.Score += 0.15
		result.Reasons = append(result.Reasons, "new_account")
	}

	// Clamp before deciding. The weights above sum to 1.15, so an unclamped
	// score contradicts the 0-1 range this field is documented and logged as.
	result.Score = math.Min(1.0, result.Score)

	result.IsBot = result.Score >= 0.7
	result.RequireCAPTCHA = result.Score >= 0.4 && result.Score < 0.7

	return result
}

// hitCount increments a per-minute bucket and returns its value.
//
// The bucket is what makes this a rate. INCR against a fixed key with EXPIRE
// refreshed on every call produces a key whose TTL is pushed forward by the
// very traffic it is meant to measure: it never expires, the count rises
// forever, and every visitor is permanently over the limit after their tenth
// request of the day.
func (s *AntiBotService) hitCount(ctx context.Context, kind, id string) (int64, error) {
	key := fmt.Sprintf("rate:%s:%s:%d", kind, id, time.Now().Unix()/60)
	pipe := s.rdb.Pipeline()
	incr := pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, 2*time.Minute)
	if _, err := pipe.Exec(ctx); err != nil {
		return 0, err
	}
	return incr.Val(), nil
}

type BotCheckRequest struct {
	UserID            string
	IP                string
	Fingerprint       string // browser fingerprint hash
	UserAgent         string
	MouseMovements    int
	TimeSincePageLoad int64 // milliseconds
	AccountAgeDays    int
}

// datacenterRanges is illustrative only. Real deployments load the providers'
// published prefix feeds (AWS ip-ranges.json, GCP cloud.json, and equivalents)
// and refresh them, because these allocations change constantly.
//
// Do not hardcode whole /8s: AWS does not own all of 52.0.0.0/8 and Google
// does not own all of 34.0.0.0/8, so blanket-scoring those ranges flags a lot
// of ordinary people.
var datacenterRanges = mustPrefixes(
	"52.94.0.0/16", // AWS (example prefix from the published feed)
	"34.64.0.0/10", // GCP (example prefix from the published feed)
)

func mustPrefixes(cidrs ...string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(cidrs))
	for _, c := range cidrs {
		// Parsed once at startup. Parsing CIDRs per request, and discarding
		// the error while doing it, turns a typo into a nil dereference on the
		// busiest code path in the system.
		out = append(out, netip.MustParsePrefix(c))
	}
	return out
}

func isDatacenterIP(ip string) bool {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return false // unparseable: let the other signals speak
	}
	for _, p := range datacenterRanges {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// ProofOfWork asks the client to solve a computational puzzle. It taxes naive
// high-rate scripts. It does not stop a funded scalper: see the discussion
// above before relying on it for anything.
type ProofOfWorkChallenge struct {
	Challenge  string `json:"challenge"`
	Difficulty int    `json:"difficulty"` // number of leading zero bits
}

const powDifficulty = 20 // ~1M hash attempts, ~0.5s in a browser

// IssueChallenge mints a single-use challenge and records it.
//
// The record is the point. A challenge that is not tracked server-side can be
// solved once and replayed forever, which reduces the whole mechanism to a
// constant that the attacker pays a single time.
func (s *AntiBotService) IssueChallenge(ctx context.Context) (*ProofOfWorkChallenge, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	challenge := hex.EncodeToString(buf)

	// SET NX with a TTL: the challenge is valid once, and only for a minute.
	if err := s.rdb.Set(ctx, powKey(challenge), "open", time.Minute).Err(); err != nil {
		return nil, err
	}
	return &ProofOfWorkChallenge{Challenge: challenge, Difficulty: powDifficulty}, nil
}

// RedeemProofOfWork verifies a solution and burns the challenge, so the same
// (challenge, solution) pair cannot be presented twice.
func (s *AntiBotService) RedeemProofOfWork(ctx context.Context, challenge, solution string) bool {
	if !verifyProofOfWork(challenge, solution, powDifficulty) {
		return false
	}
	// DEL returns the number of keys removed, so exactly one caller can win
	// even if several redeem the same solved challenge simultaneously.
	deleted, err := s.rdb.Del(ctx, powKey(challenge)).Result()
	return err == nil && deleted == 1
}

func powKey(challenge string) string { return "pow:" + challenge }

// verifyProofOfWork checks that the hash has `difficulty` leading zero BITS.
//
// Counting leading zero hex characters instead (difficulty/4) silently rounds
// the requirement down to the nearest multiple of four: a difficulty of 22
// would accept 20 bits, a puzzle four times easier than the one requested.
func verifyProofOfWork(challenge, solution string, difficulty int) bool {
	hash := sha256.Sum256([]byte(challenge + solution))

	full := difficulty / 8
	for i := 0; i < full; i++ {
		if hash[i] != 0 {
			return false
		}
	}
	if rem := difficulty % 8; rem != 0 {
		if hash[full]>>(8-rem) != 0 {
			return false
		}
	}
	return true
}
```

---
