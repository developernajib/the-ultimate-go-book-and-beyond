## Failure Handling

In a payment system, how you handle failures matters more than how you handle success. Not every error is retryable, and the distinction is not about severity but about what the error tells you. A "card declined" is a definitive answer from the network: the charge did not happen, and asking again will not change it. A timeout is not an answer at all. It tells you nothing about whether the charge happened, and that distinction is the whole design.

The failover here is where this gets dangerous, and it is worth being blunt about the trap. The obvious implementation is "if the primary errors, try the secondary", and it double-charges customers. When the primary times out, the charge may well have gone through, and the response was simply lost on the way back. Sending the same charge to a second processor then bills the card twice, on two acquirers, with two references. Worse, the idempotency key does not save you: it is scoped to one processor's namespace, so the secondary has never seen it and treats the request as new.

Failover is therefore only safe for errors that prove no charge was created: a connection refused, a DNS failure, a 503 from the processor's edge before it reached the network. On a timeout there is exactly one correct move, and it is to stop, leave the transaction pending, and let reconciliation ask the primary what actually happened. Declines never fail over at all: a card the issuer refused is not a card the secondary processor will get money out of, and retrying declines across processors is the pattern card networks penalize as retry abuse.

```go
package resilience

import (
	"context"
	"errors"
	"fmt"
)

// FailureKind classifies what a processor error actually tells us. The
// axis that matters is not "how bad" but "do we know whether the card
// was charged".
type FailureKind int

const (
	// FailureUnknown: the request may or may not have reached the card
	// network. Timeouts live here. Never retried, never failed over.
	FailureUnknown FailureKind = iota
	// FailureNoCharge: proof that no charge was created, so another
	// attempt cannot duplicate one.
	FailureNoCharge
	// FailureDeclined: the network answered no. Final.
	FailureDeclined
)

type ProcessorError struct {
	Kind FailureKind
	Code string // "processor_timeout", "network_error", "card_declined", ...
	Err  error
}

func (e *ProcessorError) Error() string { return e.Code + ": " + e.Err.Error() }
func (e *ProcessorError) Unwrap() error { return e.Err }

// ErrAmbiguous is returned when we cannot tell whether the card was
// charged. The transaction stays pending and reconciliation resolves it
// against the processor. This is the one case where doing nothing is the
// correct and only safe action.
var ErrAmbiguous = errors.New("charge outcome unknown, left for reconciliation")

type ProcessorFailover struct{ primary, secondary CardProcessor }

func (f *ProcessorFailover) Charge(ctx context.Context, req ChargeRequest) (*ChargeResult, error) {
	result, err := f.primary.Charge(ctx, req)
	if err == nil {
		return result, nil
	}

	var pe *ProcessorError
	if !errors.As(err, &pe) {
		// An error we cannot classify is an error we cannot rule a charge
		// out from. Treat it as ambiguous rather than assuming the
		// convenient answer.
		return nil, fmt.Errorf("%w: unclassified primary error: %v", ErrAmbiguous, err)
	}

	switch pe.Kind {
	case FailureDeclined:
		// The issuer said no. The secondary would ask the same issuer
		// about the same card and get the same no.
		return nil, err

	case FailureUnknown:
		// The critical case. The primary may have charged the card. Our
		// idempotency key means nothing to the secondary, so failing over
		// here bills the customer twice.
		return nil, fmt.Errorf("%w: primary returned %s", ErrAmbiguous, pe.Code)

	case FailureNoCharge:
		// Proven no charge: failover is safe.
		result, secErr := f.secondary.Charge(ctx, req)
		if secErr != nil {
			return nil, fmt.Errorf("primary failed (%w), secondary failed: %w", err, secErr)
		}
		return result, nil
	}

	return nil, err
}
```

The error wrapping in that last branch is not decoration. When both processors fail, an on-call engineer needs to know how each one failed, because "primary refused the connection and the secondary declined the card" and "primary refused the connection and the secondary timed out" call for opposite responses, and the second one means a charge may exist at the secondary. Collapsing both into `"both processors failed"` throws away the only information that distinguishes them.

Payments that exhaust their options land in a dead-letter queue for manual review. Be careful to route the two categories differently, though. A payment that failed cleanly is a customer-facing failure, and the merchant retries it. A payment left ambiguous is an accounting problem: there may be real money sitting at a processor with no record on our side, and it needs reconciliation and a human, not a retry.

---
