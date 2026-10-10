## Deep Dive: Driver Dispatch Queue

When a match is found, the system does not simply assign the trip, it offers it to the highest-scored driver first and gives them 15 seconds to accept. If that driver does not respond, the offer cascades to the next-best driver, and so on down the ranked list. This prevents wasted matches where an assigned driver never responds.

The whole difficulty of this component lives in one instant: the moment the 15 second timer expires is exactly the moment the driver is most likely to tap Accept. A driver who takes the full window to decide lands their tap and the timeout on the same millisecond. This is not a rare edge case you can wave away, it is the single most likely collision in the design, and the offer must resolve to exactly one outcome.

Getting this wrong is easy and instructive. A queue that holds a mutex around its maps, then reads the current candidate index outside that mutex, looks synchronized and is not. Two things go wrong at once. The obvious one is the data race on the index itself, which `go test -race` reports immediately. The subtler one is that `timer.Stop()` returning `false` means the timer already fired, so its goroutine is running right now and is about to advance the offer no matter what Accept decides. Both the accepting driver and the next driver in the list can end up confirmed for the same trip.

The fix is to make the resolution a single decision under a single lock. Each offer carries a round counter, and both Accept and the timeout must claim the round they were issued for. Whoever claims it first advances the counter, and the loser finds a number it does not recognize and returns. This works whether or not `Stop` succeeds, which matters, because `Stop` cannot unfire a timer.

```go
package dispatch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

const offerTTL = 15 * time.Second

var (
	ErrNoSuchOffer  = errors.New("no pending offer for trip")
	ErrOfferExpired = errors.New("offer already cascaded past this driver")
)

// Notifier is the transport out to drivers and riders. Real collaborators
// behind an interface, not empty methods: a stub that silently does nothing is
// how a dispatch queue passes every test and offers a trip to nobody.
type Notifier interface {
	SendOffer(ctx context.Context, driverID, tripID string) error
	NotifyRider(ctx context.Context, riderID, status string) error
	Confirm(ctx context.Context, riderID, driverID, tripID string) error
}

type DispatchQueue struct {
	mu      sync.Mutex
	pending map[string]*offer // guarded by mu
	notif   Notifier
	log     *slog.Logger
}

// offer holds one trip's cascade. Every field is guarded by DispatchQueue.mu,
// including current and round. Reading current outside the lock is the bug this
// whole design exists to prevent.
type offer struct {
	tripID    string
	riderID   string
	driverIDs []string
	current   int    // index of the driver currently holding the offer
	round     uint64 // bumped on every resolution, stale timers detect it
	timer     *time.Timer
}

// NewDispatchQueue is required, not a convenience. A zero-value DispatchQueue
// has nil maps, and the first assignment to a nil map panics.
func NewDispatchQueue(n Notifier, log *slog.Logger) *DispatchQueue {
	return &DispatchQueue{pending: make(map[string]*offer), notif: n, log: log}
}

// OfferTrip starts the cascade at the highest-scored driver.
//
// The cascade outlives the HTTP request that started it: 15 seconds per
// candidate, potentially minutes in total. Capturing the request's context
// would cancel every remaining offer the moment the handler returns, so the
// timer chain runs on a context stripped of the deadline. WithoutCancel keeps
// the values (trace IDs, locale) and drops the cancellation.
func (q *DispatchQueue) OfferTrip(ctx context.Context, tripID, riderID string, driverIDs []string) error {
	if len(driverIDs) == 0 {
		return fmt.Errorf("trip %s: no candidate drivers", tripID)
	}
	bg := context.WithoutCancel(ctx)

	q.mu.Lock()
	if _, dup := q.pending[tripID]; dup {
		q.mu.Unlock()
		return fmt.Errorf("trip %s is already dispatching", tripID)
	}
	o := &offer{tripID: tripID, riderID: riderID, driverIDs: driverIDs}
	q.pending[tripID] = o
	driverID := o.driverIDs[0]
	q.armLocked(bg, o)
	q.mu.Unlock()

	return q.notif.SendOffer(bg, driverID, tripID)
}

// armLocked schedules the timeout for the offer's current round.
// Caller must hold q.mu.
func (q *DispatchQueue) armLocked(ctx context.Context, o *offer) {
	round := o.round
	o.timer = time.AfterFunc(offerTTL, func() { q.cascade(ctx, o.tripID, round) })
}

// cascade advances the offer when the current driver lets it expire.
//
// The round check carries the correctness. If Accept resolved this round first,
// round has moved on (or the trip is gone from pending) and this timer, which
// may well have already fired and be blocked on the mutex above, discovers it
// lost and returns. Relying on Stop() instead would be a coin flip.
func (q *DispatchQueue) cascade(ctx context.Context, tripID string, round uint64) {
	q.mu.Lock()
	o, ok := q.pending[tripID]
	if !ok || o.round != round {
		q.mu.Unlock()
		return // a driver accepted this round, we are a stale timer
	}

	o.round++
	o.current++
	if o.current >= len(o.driverIDs) {
		riderID := o.riderID
		delete(q.pending, tripID)
		q.mu.Unlock()
		if err := q.notif.NotifyRider(ctx, riderID, "no_drivers"); err != nil {
			q.log.ErrorContext(ctx, "notify rider failed", "trip", tripID, "err", err)
		}
		return
	}

	driverID := o.driverIDs[o.current]
	q.armLocked(ctx, o)
	q.mu.Unlock()

	if err := q.notif.SendOffer(ctx, driverID, tripID); err != nil {
		// The offer is already armed, so a send failure just burns this
		// candidate's window rather than stalling the trip forever.
		q.log.ErrorContext(ctx, "send offer failed", "trip", tripID, "driver", driverID, "err", err)
	}
}

// Accept resolves the offer to the accepting driver.
//
// Every part of the decision (does this offer exist, is this driver the current
// holder, has this round already been resolved) happens under one lock and is
// committed by bumping round before releasing it. An Accept and a timeout
// cannot both win, regardless of which fired first.
func (q *DispatchQueue) Accept(ctx context.Context, tripID, driverID string) error {
	q.mu.Lock()
	o, ok := q.pending[tripID]
	if !ok {
		q.mu.Unlock()
		return ErrNoSuchOffer
	}
	if o.driverIDs[o.current] != driverID {
		q.mu.Unlock()
		return ErrOfferExpired // cascaded past this driver already
	}

	o.round++ // invalidates the in-flight timer even if it already fired
	if o.timer != nil {
		o.timer.Stop() // best effort, the round bump is what actually protects us
	}
	riderID := o.riderID
	delete(q.pending, tripID)
	q.mu.Unlock()

	// Confirm performs the trip write. The unique index on active trips is the
	// final authority: this queue's state is per-process, so two dispatch
	// replicas working different trips can still offer the same driver at once,
	// and only the database sees both claims.
	return q.notif.Confirm(ctx, riderID, driverID, tripID)
}
```

The queue is in-memory, which means a dispatch process crash drops every in-flight offer. That is survivable, because an offer is worth 15 seconds and the rider's app can re-request, whereas persisting every offer to Redis would put a write on the hottest path in the system to protect state that expires almost immediately. Know that you made this trade, though, and be ready to say so: it is a reasonable answer, and pretending the state is durable is not.

---
