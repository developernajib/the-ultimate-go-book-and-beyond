## Deep Dive: Multi-Currency and Webhook Delivery

Supporting multiple currencies is a requirement for any global payment platform. The `CurrencyService` converts amounts between currencies using exchange rates cached in Redis, with a fallback to computing inverse rates when the direct pair is not available. Everything here turns on one fact that is easy to state and easy to forget in code: an amount in minor units means nothing without its currency, because currencies do not share a scale. Japanese Yen has no minor unit at all, so `1000` is ¥1000. Bahraini Dinar has three, so `1000` is 1.000 BHD. US Dollar has two, so `1000` is $10.00. Those are three different amounts of money written with the same integer.

That makes conversion a three-step operation rather than a multiplication. Scale out of the source currency's minor units, apply the rate, scale into the target's. Skipping the scaling step and simply multiplying by the rate produces answers wrong by factors of 100 or 1000 whenever the two currencies have different exponents, and the result is a plausible-looking number rather than an error. Converting ¥1000 to USD by naive multiplication yields 6 cents instead of $6.70.

The second trap is rounding. A conversion almost never lands on a whole minor unit, and `int64(x)` truncates toward zero rather than rounding, quietly shaving a fraction off every conversion in the same direction. Round half away from zero, and account for the remainder somewhere. The rule to hold is that value is never created or destroyed silently: if rounding gains or loses a unit, that unit is booked, not discarded.

```go
package currency

import (
	"context"
	"fmt"
	"math"

	"github.com/redis/go-redis/v9"
)

type CurrencyService struct{ rdb *redis.Client }

// scale is the number of minor units in one major unit, which is 10^exp
// for the currency's ISO 4217 exponent. Any currency not listed here is
// an error rather than an assumption: defaulting an unknown currency to
// 100 is how a JPY charge silently becomes a hundred times too large.
var scale = map[string]int64{
	"USD": 100, "EUR": 100, "GBP": 100, "AUD": 100, "CAD": 100,
	"CHF": 100, "CNY": 100, "HKD": 100, "SEK": 100, "MXN": 100,
	"JPY": 1, "KRW": 1, "VND": 1, "CLP": 1, // exponent 0
	"BHD": 1000, "KWD": 1000, "OMR": 1000, "TND": 1000, // exponent 3
}

// Scale returns how many minor units make up one unit of the currency.
func Scale(currency string) (int64, error) {
	s, ok := scale[currency]
	if !ok {
		return 0, fmt.Errorf("unknown currency %q", currency)
	}
	return s, nil
}

// Convert converts amount, expressed in from's minor units, into to's
// minor units. It returns the converted amount and the rate applied.
//
// Both scales are required, because the rate is quoted between major
// units while the amounts are in minor units.
func (s *CurrencyService) Convert(ctx context.Context, amount int64, from, to string) (int64, float64, error) {
	if from == to {
		return amount, 1.0, nil
	}

	fromScale, err := Scale(from)
	if err != nil {
		return 0, 0, err
	}
	toScale, err := Scale(to)
	if err != nil {
		return 0, 0, err
	}

	rate, err := s.GetRate(ctx, from, to)
	if err != nil {
		return 0, 0, err
	}

	// minor units -> major units -> convert -> target minor units.
	major := float64(amount) / float64(fromScale)
	converted := major * rate * float64(toScale)

	// math.Round rounds half away from zero. Plain int64() truncates, and
	// truncation is a systematic bias: it shaves a fraction off every
	// single conversion in the same direction, so the loss accumulates
	// rather than averaging out.
	rounded := math.Round(converted)

	// float64 holds integers exactly only up to 2^53. Past that, the
	// rounded value is no longer the number we computed, and silently
	// wrapping it into int64 is not an acceptable way to find out.
	if math.IsNaN(rounded) || math.Abs(rounded) > math.MaxInt64/2 {
		return 0, 0, fmt.Errorf("conversion of %d %s to %s overflows", amount, from, to)
	}

	return int64(rounded), rate, nil
}

func (s *CurrencyService) GetRate(ctx context.Context, from, to string) (float64, error) {
	rate, err := s.rdb.Get(ctx, fmt.Sprintf("fx:%s:%s", from, to)).Float64()
	if err == nil {
		if rate <= 0 {
			return 0, fmt.Errorf("nonsensical rate %v for %s/%s", rate, from, to)
		}
		return rate, nil
	}

	// Fall back to the inverse pair. This is only sound because these are
	// mid-market rates: inverting a real bid or ask silently hands away
	// the spread.
	inv, err := s.rdb.Get(ctx, fmt.Sprintf("fx:%s:%s", to, from)).Float64()
	if err != nil {
		return 0, fmt.Errorf("no rate for %s/%s: %w", from, to, err)
	}
	if inv <= 0 {
		// Guard the division. A zero here would return +Inf, which then
		// converts into a garbage amount rather than an error.
		return 0, fmt.Errorf("nonsensical inverse rate %v for %s/%s", inv, to, from)
	}
	return 1.0 / inv, nil
}
```

Note what `Convert` does not do: it does not decide where the rounding remainder goes. Rounding a single conversion is arithmetic, but splitting one amount into several (a payout across sub-merchants, a fee taken out of a charge) is a distribution problem, and rounding each share independently either invents or destroys minor units. If you split $100.00 three ways and round each share to $33.33, you have distributed $99.99 and lost a cent. The standard fix is largest-remainder: compute the floor of each share, then hand the leftover units out one at a time to the shares with the largest remainders, so the parts always sum to exactly the whole. Whatever scheme you pick, the invariant is that the sum of the parts equals the original, and that is a property to assert in a test rather than hope for.

The `WebhookService` delivers payment events to merchant endpoints with HMAC-SHA256 signatures for authenticity verification and uses exponential backoff to retry transient failures. The signature is what lets the merchant trust the payload, so it has to sign more than the body. A signature over the body alone is constant for that body forever, which means anyone who observes one delivery can replay it verbatim at any point in the future and the merchant will verify it happily. Stripe's scheme is the one to copy: sign `timestamp.payload`, send both, and have the receiver reject anything outside a tolerance window. The timestamp is inside the MAC, so an attacker cannot rewrite it to keep a stale event fresh.

```go
package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"time"
)

type WebhookService struct{ httpClient *http.Client }

type WebhookEvent struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	Data      map[string]any `json:"data"`
	CreatedAt time.Time      `json:"created_at"`
}

const (
	maxAttempts = 5
	maxBackoff  = 30 * time.Second
)

// sign returns the signature header value over timestamp.payload, in the
// same shape Stripe uses. The receiver recomputes the MAC over the same
// two parts, compares with hmac.Equal, and rejects a timestamp outside
// its tolerance. Signing the body alone would make every delivery
// replayable forever.
func sign(secret string, ts time.Time, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.", ts.Unix())
	mac.Write(body)
	return fmt.Sprintf("t=%d,v1=%s", ts.Unix(), hex.EncodeToString(mac.Sum(nil)))
}

func (s *WebhookService) Deliver(ctx context.Context, url, secret string, event WebhookEvent) error {
	body, err := json.Marshal(event)
	if err != nil {
		// Unmarshalable event: retrying cannot help.
		return fmt.Errorf("marshal event %s: %w", event.ID, err)
	}

	sig := sign(secret, time.Now(), body)
	backoff := 1 * time.Second

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		retryable, err := s.attempt(ctx, url, sig, body, event.ID)
		if err == nil {
			return nil
		}
		if !retryable || attempt == maxAttempts {
			return fmt.Errorf("webhook %s to %s failed on attempt %d/%d: %w",
				event.ID, url, attempt, maxAttempts, err)
		}

		// Full jitter. Every merchant endpoint that fails during an
		// incident otherwise retries in lockstep and hits it again as a
		// synchronized wave the moment it starts recovering.
		wait := time.Duration(rand.Int64N(int64(backoff)))
		select {
		case <-ctx.Done():
			// time.Sleep here would keep sleeping through cancellation
			// and shutdown, holding the worker for the full backoff.
			return ctx.Err()
		case <-time.After(wait):
		}

		if backoff *= 2; backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
	return fmt.Errorf("webhook %s to %s failed after %d attempts", event.ID, url, maxAttempts)
}

// attempt makes one delivery. The bool reports whether the failure is
// worth retrying.
func (s *WebhookService) attempt(ctx context.Context, url, sig string, body []byte, eventID string) (retryable bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return false, err // a malformed URL will not fix itself
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Webhook-Signature", sig)
	// The merchant needs this to deduplicate: at-least-once delivery
	// means they will eventually see the same event twice.
	req.Header.Set("Webhook-Id", eventID)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return true, err // network failure, worth another try
	}
	// Drain and close, always. Leaking the body leaks the connection, and
	// a delivery worker that leaks one per failed webhook exhausts the
	// transport pool and then cannot deliver anything at all.
	defer func() {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()
	}()

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return false, nil
	case resp.StatusCode == http.StatusTooManyRequests, resp.StatusCode >= 500:
		// Overload or a server-side fault: the endpoint may recover.
		return true, fmt.Errorf("endpoint returned %d", resp.StatusCode)
	default:
		// 4xx means the merchant rejected this request on its merits.
		// A 400 will be a 400 on every retry, so retrying only burns
		// capacity and delays the dead-letter queue.
		return false, fmt.Errorf("endpoint returned %d", resp.StatusCode)
	}
}
```

Two properties of this design matter more than the retry mechanics. Delivery is at-least-once, not exactly-once, because a merchant that receives the event and dies before responding will be sent it again. That is unavoidable, so the contract must say so, and the `Webhook-Id` header is what lets merchants deduplicate. The other is that `Deliver` blocks for the length of its backoff, which is fine in a delivery worker consuming from a queue and wrong in a request handler. Webhook delivery belongs on the far side of an outbox or queue, so that a merchant's slow endpoint cannot add tens of seconds of latency to the payment that triggered the event. After the final attempt the event goes to a dead-letter queue for inspection and manual replay rather than being dropped.

---
