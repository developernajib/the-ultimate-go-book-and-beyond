## Core Components

### 1. Virtual Queue (Waiting Room)

The virtual queue is the first line of defense against the "thundering herd" problem. When millions of fans rush to buy tickets simultaneously, this service places them in a fair, first-come-first-served line backed by a Redis sorted set. Users receive a signed token and position number, then wait until the admission controller lets them into the booking flow. Without this component, every user would hit the booking service directly, causing database connection exhaustion and system-wide failure.

```go
package queue

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const defaultAdmissionRate int64 = 500 // cold start admission rate per minute

// VirtualQueueService manages fair access during high-demand sales
// Prevents system overload and ensures fair ordering
type VirtualQueueService struct {
	rdb    *redis.Client
	secret []byte // for HMAC signing of queue tokens
}

// QueueEntry represents a user's place in line
type QueueEntry struct {
	UserID    string
	EventID   string
	Position  int64
	Token     string // signed token for verification
	EnteredAt time.Time
	ExpiresAt time.Time
}

// JoinQueue places a user in the virtual waiting room
func (s *VirtualQueueService) JoinQueue(ctx context.Context, userID, eventID string) (*QueueEntry, error) {
	// Use Redis sorted set: score = timestamp, member = userID
	// This creates FIFO ordering while deduplicating concurrent requests
	queueKey := queueKey(eventID)
	now := float64(time.Now().UnixMicro())

	// NX: only add if not already in queue. A re-join keeps the original score,
	// so refreshing the page never costs a user their place in line.
	if err := s.rdb.ZAddNX(ctx, queueKey, redis.Z{
		Score:  now,
		Member: userID,
	}).Err(); err != nil {
		return nil, fmt.Errorf("join queue: %w", err)
	}

	// Read the rank whether we just added the user or they were already there.
	position, err := s.rdb.ZRank(ctx, queueKey, userID).Result()
	if err != nil {
		return nil, fmt.Errorf("queue rank: %w", err)
	}

	// Set queue TTL (queue expires after sale ends)
	if err := s.rdb.Expire(ctx, queueKey, 4*time.Hour).Err(); err != nil {
		return nil, fmt.Errorf("queue expire: %w", err)
	}

	entry := &QueueEntry{
		UserID:    userID,
		EventID:   eventID,
		Position:  position + 1, // 1-indexed
		EnteredAt: time.Now(),
		ExpiresAt: time.Now().Add(4 * time.Hour),
	}
	entry.Token = s.signToken(entry)

	return entry, nil
}

// GetPosition returns current queue position and estimated wait time
func (s *VirtualQueueService) GetPosition(ctx context.Context, userID, eventID string) (int64, int64, error) {
	queueKey := queueKey(eventID)

	position, err := s.rdb.ZRank(ctx, queueKey, userID).Result()
	if err != nil {
		return 0, 0, fmt.Errorf("user not in queue")
	}

	// Admission rate, measured over the last completed minute. Reading the
	// previous bucket rather than the current one avoids dividing by a
	// partially filled minute, which would overstate the wait.
	throughput, err := s.rdb.Get(ctx, throughputKey(eventID, time.Now().Add(-time.Minute))).Int64()
	if err != nil || throughput <= 0 {
		throughput = defaultAdmissionRate // cold start: the configured rate
	}

	waitMinutes := position / throughput

	return position + 1, waitMinutes, nil
}

// AdmitNext admits the next N users from the queue into the booking flow
// Called by the booking service to control admission rate
func (s *VirtualQueueService) AdmitNext(ctx context.Context, eventID string, count int64) ([]string, error) {
	queueKey := queueKey(eventID)

	// Pop N users from front of queue (lowest score = earliest joiner)
	members, err := s.rdb.ZPopMin(ctx, queueKey, count).Result()
	if err != nil {
		return nil, err
	}

	now := time.Now()
	deadline := float64(now.Add(admissionTTL).Unix())

	userIDs := make([]string, 0, len(members))
	pipe := s.rdb.Pipeline()
	for _, m := range members {
		userID, ok := m.Member.(string)
		if !ok {
			continue
		}
		userIDs = append(userIDs, userID)
		// Admission is one entry in a sorted set scored by its deadline, so an
		// abandoned checkout expires exactly like a completed one.
		pipe.ZAdd(ctx, activeKey(eventID), redis.Z{Score: deadline, Member: userID})
	}
	pipe.Expire(ctx, activeKey(eventID), 4*time.Hour)

	// Count admissions into a per-minute bucket, incremented by the size of the
	// batch. Incrementing by 1 per call would measure how often AdmitNext runs,
	// not how many users it let through, and refreshing a TTL on a single
	// cumulative key would never yield a rate at all.
	bucket := throughputKey(eventID, now)
	pipe.IncrBy(ctx, bucket, int64(len(userIDs)))
	pipe.Expire(ctx, bucket, 5*time.Minute)

	if _, err := pipe.Exec(ctx); err != nil {
		return nil, fmt.Errorf("admit batch: %w", err)
	}

	return userIDs, nil
}

// IsAdmitted reports whether a user currently holds a live admission.
//
// The deadline is compared explicitly rather than relying on a key's TTL to
// make the entry disappear, because the same sorted set is what the admission
// controller counts to measure concurrency. One representation, one answer.
func (s *VirtualQueueService) IsAdmitted(ctx context.Context, userID, eventID string) bool {
	deadline, err := s.rdb.ZScore(ctx, activeKey(eventID), userID).Result()
	if err != nil {
		return false // redis.Nil (never admitted) or a Redis error: fail closed
	}
	return time.Now().Unix() <= int64(deadline)
}

// signToken creates an HMAC-signed token for queue verification. The payload
// travels with the MAC: a bare signature is unverifiable, because the verifier
// would have no way to recover EnteredAt in order to recompute it.
func (s *VirtualQueueService) signToken(entry *QueueEntry) string {
	payload := fmt.Sprintf("%s:%s:%d", entry.UserID, entry.EventID, entry.EnteredAt.Unix())
	return payload + "." + s.mac(payload)
}

// VerifyToken checks that a token was issued by this service and returns the
// user and event it was minted for.
func (s *VirtualQueueService) VerifyToken(token string) (userID, eventID string, err error) {
	payload, sig, ok := strings.Cut(token, ".")
	if !ok {
		return "", "", fmt.Errorf("malformed queue token")
	}
	// Constant-time compare. A byte-wise != on a MAC leaks, through timing,
	// how many leading bytes of a forged signature were correct.
	if !hmac.Equal([]byte(sig), []byte(s.mac(payload))) {
		return "", "", fmt.Errorf("invalid queue token")
	}
	parts := strings.Split(payload, ":")
	if len(parts) != 3 {
		return "", "", fmt.Errorf("malformed queue token payload")
	}
	return parts[0], parts[1], nil
}

func (s *VirtualQueueService) mac(payload string) string {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

// admissionTTL is how long an admitted user has to complete a booking before
// their slot is reclaimed for the next person in line.
const admissionTTL = 10 * time.Minute

func queueKey(eventID string) string {
	return fmt.Sprintf("queue:%s", eventID)
}

// activeKey holds the users currently inside the booking flow, scored by the
// deadline at which each admission lapses.
func activeKey(eventID string) string {
	return fmt.Sprintf("admitted:active:%s", eventID)
}

// throughputKey buckets admission counts by wall-clock minute.
func throughputKey(eventID string, t time.Time) string {
	return fmt.Sprintf("queue:throughput:%s:%d", eventID, t.Unix()/60)
}
```

### 2. Ticket Service

The ticket service is the core of the booking system, responsible for holding seats during checkout and confirming purchases after payment. The critical challenge here is preventing overselling: two users must never successfully book the same seat.

The two layers are not equal partners, and knowing which one is load-bearing is the whole point. The Redis Lua script is a fast-path guard. It runs check-and-claim as one uninterruptible operation, so in the common case exactly one of the ten thousand users racing for seat A17 gets a hold and the other 9,999 are turned away without ever touching PostgreSQL. That is a throughput decision, not a correctness one. Redis holds expire, get reaped, and can be lost entirely if a replica is promoted mid-sale, so a hold is a reservation to attempt a purchase and nothing stronger.

The guarantee is the conditional UPDATE in `confirmSeatsInDB`, where a row lock and a `status = 'available'` predicate make the sale a compare-and-set that exactly one transaction can win. If Redis vanished and every request fell through to the database, the system would be slow, but it still would not oversell. If the database check were dropped and the Redis hold were trusted, the system would be fast and would eventually sell one seat twice. Design reviews that treat the cache as the source of truth are how that second outcome happens.

```go
package ticket

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// errDuplicateBooking means this hold has already been confirmed, which makes
// the caller a retry rather than a failure.
var errDuplicateBooking = errors.New("booking already exists for hold")

// queueAdmitter is the slice of the virtual queue that the ticket service
// depends on. Declaring the interface here, at the point of use, keeps the
// ticket package from importing the queue package.
type queueAdmitter interface {
	IsAdmitted(ctx context.Context, userID, eventID string) bool
}

type ChargeRequest struct {
	IdempotencyKey  string
	CustomerID      string
	Amount          int64
	Currency        string
	PaymentMethodID string
}

type ChargeResult struct {
	ChargeID string
}

type PaymentService interface {
	Charge(ctx context.Context, req ChargeRequest) (*ChargeResult, error)
	Refund(ctx context.Context, chargeID, reason string) error
}

type DeliveryService interface {
	DeliverTickets(ctx context.Context, booking *Booking) error
}

// TicketService manages ticket inventory and booking
type TicketService struct {
	db          *pgxpool.Pool
	rdb         *redis.Client
	queueSvc    queueAdmitter
	paymentSvc  PaymentService
	deliverySvc DeliveryService
}

// Seat represents a specific seat in a venue
type Seat struct {
	ID         string `json:"id"`
	EventID    string `json:"event_id"`
	Section    string `json:"section"` // A, B, Floor
	Row        string `json:"row"`
	Number     int    `json:"number"`
	Tier       string `json:"tier"` // VIP, GA, Standard
	PriceCents int64  `json:"price_cents"`
	Status     string `json:"status"` // available, held, sold
}

// Booking represents a completed ticket purchase
type Booking struct {
	ID         string    `json:"id"`
	UserID     string    `json:"user_id"`
	EventID    string    `json:"event_id"`
	SeatIDs    []string  `json:"seat_ids"`
	TotalCents int64     `json:"total_cents"`
	Status     string    `json:"status"` // pending, confirmed, canceled
	PaymentID  string    `json:"payment_id"`
	CreatedAt  time.Time `json:"created_at"`
}

const (
	holdTTL = 10 * time.Minute
	// holdGrace keeps the hold key readable after the hold itself has lapsed,
	// so the reaper can still recover the seat list. The expiry index, not the
	// key's TTL, decides whether a hold is still live.
	holdGrace = 5 * time.Minute
)

// holdScript atomically verifies every requested seat is available and claims
// them all under one hold ID, recording the seat list on the hold key and the
// hold's deadline on a per-event expiry index.
//
// KEYS: seat status hash, hold key, expiry index (sorted set)
// ARGV: holdID, ttlSeconds, graceSeconds, nowUnix, seatIDs...
var holdScript = redis.NewScript(`
	local seatKey   = KEYS[1]
	local holdKey   = KEYS[2]
	local expiryKey = KEYS[3]
	local holdID    = ARGV[1]
	local ttl       = tonumber(ARGV[2])
	local grace     = tonumber(ARGV[3])
	local now       = tonumber(ARGV[4])

	-- Check every seat first: a partial hold is worse than no hold.
	for i = 5, #ARGV do
		local status = redis.call('HGET', seatKey, ARGV[i])
		if status ~= 'available' then
			return redis.error_reply('seat ' .. ARGV[i] .. ' not available')
		end
	end

	-- Claim them. The whole script runs as one unit, so no other client can
	-- observe the gap between the checks above and the writes below.
	local seats = {}
	for i = 5, #ARGV do
		redis.call('HSET', seatKey, ARGV[i], 'held:' .. holdID)
		seats[#seats + 1] = ARGV[i]
	end

	-- The hold key carries its own seat list, so confirming a hold never has
	-- to scan the seat hash. The expiry index is the authority on when the
	-- hold lapses; the key itself is kept past that deadline by a grace
	-- window, because a key that expires exactly when the hold does takes the
	-- seat list with it and leaves the reaper nothing to release.
	redis.call('SET', holdKey, table.concat(seats, ','), 'EX', ttl + grace)
	redis.call('ZADD', expiryKey, now + ttl, holdID)

	return holdID
`)

// HoldSeats temporarily reserves seats during checkout (10-minute window).
//
// The hold is a fast-path guard, not the oversell guarantee. It keeps the
// losing 99% of a stampede from ever reaching PostgreSQL, but the seat is not
// actually anyone's until the conditional UPDATE in confirmSeatsInDB commits.
func (s *TicketService) HoldSeats(ctx context.Context, userID, eventID string, seatIDs []string) (string, error) {
	if len(seatIDs) == 0 {
		return "", fmt.Errorf("no seats requested")
	}

	// Verify user is admitted from queue
	if !s.queueSvc.IsAdmitted(ctx, userID, eventID) {
		return "", fmt.Errorf("not admitted from queue")
	}

	// Mint the hold ID in Go. Deriving it from userID plus a one-second Redis
	// TIME reading, as an earlier draft of this design did, hands the same ID
	// to two holds by the same user in the same second, and the second hold
	// then silently adopts the first one's seats.
	holdID := uuid.NewString()

	now := time.Now()
	args := []any{holdID, int64(holdTTL.Seconds()), int64(holdGrace.Seconds()), now.Unix()}
	for _, id := range seatIDs {
		args = append(args, id)
	}
	keys := []string{seatKey(eventID), holdKey(eventID, holdID), expiryKey(eventID)}

	if err := holdScript.Run(ctx, s.rdb, keys, args...).Err(); err != nil {
		return "", fmt.Errorf("hold failed: %w", err)
	}

	return holdID, nil
}

// ConfirmBooking completes a purchase after payment succeeds.
func (s *TicketService) ConfirmBooking(ctx context.Context, userID, eventID, holdID, paymentMethodID string) (*Booking, error) {
	seatIDs, subtotal, err := s.getHeldSeats(ctx, eventID, holdID)
	if err != nil {
		return nil, fmt.Errorf("hold expired or invalid: %w", err)
	}

	// All money is integer cents. A 20% fee on a $67.50 seat is 1350 cents
	// exactly - the same sum in float64 drifts, and a drift of one cent per
	// booking across an arena is a reconciliation ticket nobody wants to work.
	// Rounding is half-up on the fee only, so the total is always the sum of
	// two exact integers and no value is invented or destroyed.
	feeCents := (subtotal*20 + 50) / 100
	totalCents := subtotal + feeCents

	// The idempotency key is derived from the hold, so a client that retries a
	// confirm is charged once. Reusing a key with different parameters is a
	// 400 from Stripe, which is the behavior we want: it surfaces the bug
	// rather than double-charging.
	payResult, err := s.paymentSvc.Charge(ctx, ChargeRequest{
		IdempotencyKey:  "booking-" + holdID,
		CustomerID:      userID,
		Amount:          totalCents,
		Currency:        "USD",
		PaymentMethodID: paymentMethodID,
	})
	if err != nil {
		// Release hold on payment failure
		s.releaseHold(ctx, eventID, holdID, seatIDs)
		return nil, fmt.Errorf("payment failed: %w", err)
	}

	// Confirm seats in database. This is the step that actually decides who
	// owns the seat, and the only step that can be trusted to.
	bookingID := uuid.NewString()
	err = s.confirmSeatsInDB(ctx, bookingID, userID, eventID, holdID, seatIDs, totalCents)
	switch {
	case errors.Is(err, errDuplicateBooking):
		// This confirm already succeeded and the client retried. The charge
		// was idempotent, so the money is already correct: return the original
		// booking. Falling through to the refund path here would cancel the
		// payment for a booking that remains confirmed, which is worse than
		// the failure it was written to handle.
		return s.loadBookingByHold(ctx, holdID)

	case err != nil:
		// Payment succeeded but the seats were not ours to sell. Refund the
		// exact amount charged, never a recomputed one, and drop the hold.
		if rErr := s.paymentSvc.Refund(ctx, payResult.ChargeID, "seat_unavailable"); rErr != nil {
			// A failed refund is a money problem, not a booking problem. It
			// must be retried out of band, not swallowed here.
			slog.ErrorContext(ctx, "refund failed, manual reconciliation required",
				"charge_id", payResult.ChargeID, "booking_id", bookingID, "err", rErr)
		}
		s.releaseHold(ctx, eventID, holdID, seatIDs)
		return nil, fmt.Errorf("booking DB write failed after payment: %w", err)
	}

	// Only now is the Redis view updated to match the committed truth.
	s.markSeatsSold(ctx, eventID, holdID, seatIDs, bookingID)

	booking := &Booking{
		ID:         bookingID,
		UserID:     userID,
		EventID:    eventID,
		SeatIDs:    seatIDs,
		TotalCents: totalCents,
		Status:     "confirmed",
		PaymentID:  payResult.ChargeID,
		CreatedAt:  time.Now(),
	}

	// Deliver out of band. context.WithoutCancel keeps the work alive after the
	// HTTP handler returns without inheriting a deadline that is about to fire,
	// and the timeout keeps the goroutine from outliving the process quietly.
	// In production this is an outbox row written inside confirmSeatsInDB and
	// drained by a worker: a goroutine dies with its pod and takes the
	// undelivered ticket with it.
	go func() {
		dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if err := s.deliverySvc.DeliverTickets(dctx, booking); err != nil {
			slog.ErrorContext(dctx, "ticket delivery failed",
				"booking_id", booking.ID, "err", err)
		}
	}()

	return booking, nil
}

// getHeldSeats returns the seats attached to a hold and their subtotal in cents.
//
// It reads the seat list straight off the hold key. Scanning the event's seat
// hash for members tagged with this hold, which is the obvious implementation,
// costs an HGETALL of 100K fields on every confirm: at 500 confirms per second
// that is 50M field transfers per second to find three seats.
func (s *TicketService) getHeldSeats(ctx context.Context, eventID, holdID string) ([]string, int64, error) {
	// The expiry index, not the key's TTL, says whether the hold is still live,
	// because the key deliberately outlives the hold by holdGrace.
	deadline, err := s.rdb.ZScore(ctx, expiryKey(eventID), holdID).Result()
	if err != nil {
		return nil, 0, fmt.Errorf("hold %s not found: %w", holdID, err)
	}
	if time.Now().Unix() > int64(deadline) {
		return nil, 0, fmt.Errorf("hold %s expired", holdID)
	}

	packed, err := s.rdb.Get(ctx, holdKey(eventID, holdID)).Result()
	if err != nil {
		return nil, 0, fmt.Errorf("hold %s not found: %w", holdID, err)
	}
	if packed == "" {
		return nil, 0, fmt.Errorf("hold %s has no seats", holdID)
	}
	seatIDs := strings.Split(packed, ",")

	// Price from the database, in one round trip, never from the client and
	// never one query per seat.
	rows, err := s.db.Query(ctx,
		`SELECT id, price_cents FROM seats WHERE event_id = $1 AND id = ANY($2)`,
		eventID, seatIDs)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var subtotal int64
	var priced int
	for rows.Next() {
		var id string
		var cents int64
		if err := rows.Scan(&id, &cents); err != nil {
			return nil, 0, err
		}
		subtotal += cents
		priced++
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if priced != len(seatIDs) {
		// Charging for seats we could not price is how a booking ends up
		// costing the wrong amount. Refuse instead.
		return nil, 0, fmt.Errorf("priced %d of %d held seats", priced, len(seatIDs))
	}

	return seatIDs, subtotal, nil
}

// confirmSeatsInDB is the oversell guarantee. Everything upstream of it is an
// optimization.
//
// The conditional UPDATE is a compare-and-set: PostgreSQL takes a row lock,
// and a second transaction targeting the same seat blocks, re-evaluates the
// WHERE clause against the committed row, sees 'sold', and reports zero rows
// affected. Note that the predicate is status = 'available', not 'held': the
// hold lives only in Redis, so a WHERE status = 'held' would match nothing and
// every booking in the system would fail.
//
// This works here because seat rows are created with the event, so there is
// nothing to phantom-insert. That is what separates this problem from a date
// range booking, where the row you need to lock does not exist yet and
// SELECT ... FOR UPDATE therefore cannot prevent the conflict on its own.
func (s *TicketService) confirmSeatsInDB(ctx context.Context, bookingID, userID, eventID, holdID string, seatIDs []string, totalCents int64) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// UNIQUE(hold_id) makes a retried confirm collide instead of creating a
	// second booking. Checking "does a booking exist for this hold?" and then
	// inserting is a read-then-write race that two concurrent retries both win.
	result, err := tx.Exec(ctx, `
		INSERT INTO bookings (id, user_id, event_id, hold_id, total_cents, status, created_at)
		VALUES ($1, $2, $3, $4, $5, 'confirmed', NOW())
		ON CONFLICT (hold_id) DO NOTHING`,
		bookingID, userID, eventID, holdID, totalCents,
	)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("hold %s: %w", holdID, errDuplicateBooking)
	}

	// One statement for all seats. Anything less than a full sweep means
	// another buyer committed first.
	result, err = tx.Exec(ctx, `
		UPDATE seats SET status = 'sold', booking_id = $1
		WHERE event_id = $2 AND id = ANY($3) AND status = 'available'`,
		bookingID, eventID, seatIDs,
	)
	if err != nil {
		return err
	}
	if int(result.RowsAffected()) != len(seatIDs) {
		return fmt.Errorf("only %d of %d seats still available", result.RowsAffected(), len(seatIDs))
	}

	return tx.Commit(ctx)
}

// releaseScript returns seats to inventory, but only the ones this hold still
// owns.
//
// The compare is what matters. Blindly writing 'available' back, as a plain
// pipeline of HSETs would, lets a stale release stomp the hold of whoever
// picked the seat up after this hold expired, and that reopens the exact
// double-booking window the hold exists to close.
var releaseScript = redis.NewScript(`
	local seatKey   = KEYS[1]
	local holdKey   = KEYS[2]
	local expiryKey = KEYS[3]
	local holdID    = ARGV[1]

	for i = 2, #ARGV do
		if redis.call('HGET', seatKey, ARGV[i]) == 'held:' .. holdID then
			redis.call('HSET', seatKey, ARGV[i], 'available')
		end
	end
	redis.call('DEL', holdKey)
	redis.call('ZREM', expiryKey, holdID)
	return 1
`)

// soldScript flips this hold's seats to sold. Same compare, same reason.
var soldScript = redis.NewScript(`
	local seatKey   = KEYS[1]
	local holdKey   = KEYS[2]
	local expiryKey = KEYS[3]
	local holdID    = ARGV[1]
	local bookingID = ARGV[2]

	for i = 3, #ARGV do
		local status = redis.call('HGET', seatKey, ARGV[i])
		if status == 'held:' .. holdID or status == 'available' then
			redis.call('HSET', seatKey, ARGV[i], 'sold:' .. bookingID)
		end
	end
	redis.call('DEL', holdKey)
	redis.call('ZREM', expiryKey, holdID)
	return 1
`)

// markSeatsSold syncs Redis to a booking the database has already committed.
// The database is the authority here, so this cannot fail the booking: it can
// only leave the cached seat map briefly wrong, which reconciliation repairs.
func (s *TicketService) markSeatsSold(ctx context.Context, eventID, holdID string, seatIDs []string, bookingID string) {
	args := []any{holdID, bookingID}
	for _, id := range seatIDs {
		args = append(args, id)
	}
	keys := []string{seatKey(eventID), holdKey(eventID, holdID), expiryKey(eventID)}
	if err := soldScript.Run(ctx, s.rdb, keys, args...).Err(); err != nil {
		slog.ErrorContext(ctx, "seat map sync failed, reconciliation will repair",
			"event_id", eventID, "booking_id", bookingID, "err", err)
	}
}

func (s *TicketService) releaseHold(ctx context.Context, eventID, holdID string, seatIDs []string) {
	args := []any{holdID}
	for _, id := range seatIDs {
		args = append(args, id)
	}
	keys := []string{seatKey(eventID), holdKey(eventID, holdID), expiryKey(eventID)}
	if err := releaseScript.Run(ctx, s.rdb, keys, args...).Err(); err != nil {
		slog.ErrorContext(ctx, "hold release failed, reaper will retry",
			"event_id", eventID, "hold_id", holdID, "err", err)
	}
}

// ReapExpiredHolds returns seats from lapsed holds to inventory. Run it on a
// ticker, one instance per event shard.
//
// Without it the design silently loses inventory: the hold key's TTL removes
// the hold, but nothing rewrites the seat hash, so every abandoned checkout
// strands its seats in 'held' for the life of the sale. Seats sitting unsold
// next to a sold-out banner is the failure users notice most.
func (s *TicketService) ReapExpiredHolds(ctx context.Context, eventID string) error {
	expired, err := s.rdb.ZRangeByScore(ctx, expiryKey(eventID), &redis.ZRangeBy{
		Min:   "-inf",
		Max:   fmt.Sprintf("%d", time.Now().Unix()),
		Count: 500,
	}).Result()
	if err != nil {
		return err
	}

	for _, holdID := range expired {
		// The seat list outlives the hold key's TTL only if we still have it,
		// so re-read before it lapses - if it is already gone, drop the index
		// entry and let reconciliation against PostgreSQL catch the strays.
		packed, err := s.rdb.Get(ctx, holdKey(eventID, holdID)).Result()
		if err != nil {
			s.rdb.ZRem(ctx, expiryKey(eventID), holdID)
			continue
		}
		s.releaseHold(ctx, eventID, holdID, strings.Split(packed, ","))
	}
	return nil
}

// loadBookingByHold returns the booking a hold already produced, so a retried
// confirm is answered with the original result instead of an error.
func (s *TicketService) loadBookingByHold(ctx context.Context, holdID string) (*Booking, error) {
	b := &Booking{}
	err := s.db.QueryRow(ctx, `
		SELECT b.id, b.user_id, b.event_id, b.total_cents, b.status,
		       COALESCE(b.payment_id, ''), b.created_at,
		       COALESCE(array_agg(s.id) FILTER (WHERE s.id IS NOT NULL), '{}')
		FROM bookings b
		LEFT JOIN seats s ON s.booking_id = b.id
		WHERE b.hold_id = $1
		GROUP BY b.id`, holdID).
		Scan(&b.ID, &b.UserID, &b.EventID, &b.TotalCents, &b.Status,
			&b.PaymentID, &b.CreatedAt, &b.SeatIDs)
	if err != nil {
		return nil, fmt.Errorf("load booking for hold %s: %w", holdID, err)
	}
	return b, nil
}

func seatKey(eventID string) string   { return fmt.Sprintf("seats:%s", eventID) }
func expiryKey(eventID string) string { return fmt.Sprintf("holds:expiry:%s", eventID) }

func holdKey(eventID, holdID string) string {
	return fmt.Sprintf("hold:%s:%s", eventID, holdID)
}
```

### 3. Ticket Delivery (QR Code)

Once a booking is confirmed, the delivery service generates a digital ticket with a tamper-proof QR code. Each barcode is cryptographically signed using HMAC-SHA256, binding it to a specific ticket, event, and user. This means a forged or duplicated barcode will fail validation at the venue scanner. The QR images are stored in S3 and served via CDN, so ticket retrieval stays fast even under heavy load.

```go
package delivery

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/skip2/go-qrcode"
)

// Booking is the delivery service's view of a confirmed purchase. It is
// declared here rather than imported from the ticket service so that delivery
// depends on the shape of the data it needs, not on the booking package.
type Booking struct {
	ID      string
	UserID  string
	EventID string
	Seats   []BookedSeat
}

// BookedSeat carries the detail that has to appear on the ticket itself.
type BookedSeat struct {
	SeatID     string
	EventName  string
	Date       time.Time
	Venue      string
	Section    string
	Row        string
	SeatNumber int
}

type NotificationService interface {
	SendTicketEmail(ctx context.Context, userID string, tickets []DigitalTicket) error
	SendPushNotification(ctx context.Context, userID, message string) error
}

// DeliveryService generates and delivers digital tickets
type DeliveryService struct {
	db       *pgxpool.Pool
	s3Client *s3.Client
	bucket   string
	secret   []byte
	notifier NotificationService
}

// DigitalTicket is a delivered ticket with QR code
type DigitalTicket struct {
	BookingID  string
	TicketID   string
	EventName  string
	Date       time.Time
	Venue      string
	Section    string
	Row        string
	SeatNumber int
	QRCodeURL  string
	BarCode    string // signed barcode for scanner validation
}

// DeliverTickets generates QR codes and sends to user
func (s *DeliveryService) DeliverTickets(ctx context.Context, booking *Booking) error {
	tickets := make([]DigitalTicket, len(booking.Seats))

	for i, seat := range booking.Seats {
		ticketID := fmt.Sprintf("TKT-%s-%s", booking.ID, seat.SeatID)

		// Generate signed barcode (prevents forgery)
		barcode := s.signBarcode(ticketID, booking.EventID, booking.UserID)

		// Generate QR code PNG
		qrCodeURL, err := s.generateQRCode(ctx, ticketID, barcode)
		if err != nil {
			return fmt.Errorf("qr generation failed: %w", err)
		}

		// Every field the venue and the attendee need. Populating only the IDs
		// and leaving the rest zero produces a ticket that emails cleanly and
		// tells the holder neither which event they bought nor where to sit.
		tickets[i] = DigitalTicket{
			BookingID:  booking.ID,
			TicketID:   ticketID,
			EventName:  seat.EventName,
			Date:       seat.Date,
			Venue:      seat.Venue,
			Section:    seat.Section,
			Row:        seat.Row,
			SeatNumber: seat.SeatNumber,
			QRCodeURL:  qrCodeURL,
			BarCode:    barcode,
		}
	}

	if err := s.notifier.SendTicketEmail(ctx, booking.UserID, tickets); err != nil {
		return fmt.Errorf("ticket email: %w", err)
	}
	// Best effort: a dropped push is not a failed delivery, the email carries
	// the tickets.
	_ = s.notifier.SendPushNotification(ctx, booking.UserID, "Your tickets are ready!")

	return nil
}

// generateQRCode creates and uploads a QR code image to S3
func (s *DeliveryService) generateQRCode(ctx context.Context, ticketID, barcode string) (string, error) {
	// Create QR code with barcode data
	png, err := qrcode.Encode(barcode, qrcode.High, 512)
	if err != nil {
		return "", err
	}

	key := fmt.Sprintf("tickets/qr/%s.png", ticketID)
	_, err = s.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(png),
		ContentType: aws.String("image/png"),
	})
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("https://cdn.tickets.example.com/%s", key), nil
}

// signBarcode creates a tamper-proof barcode for venue scanning
// Barcode = ticketID + HMAC(ticketID + eventID + userID)
func (s *DeliveryService) signBarcode(ticketID, eventID, userID string) string {
	payload := fmt.Sprintf("%s:%s:%s", ticketID, eventID, userID)
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payload))
	signature := hex.EncodeToString(mac.Sum(nil))[:16]
	return base64.URLEncoding.EncodeToString([]byte(ticketID + "." + signature))
}

// ValidateBarcode validates a scanned barcode at the venue and burns it.
func (s *DeliveryService) ValidateBarcode(ctx context.Context, barcode, eventID string) (bool, string, error) {
	decoded, err := base64.URLEncoding.DecodeString(barcode)
	if err != nil {
		return false, "", fmt.Errorf("invalid barcode format")
	}

	ticketID, _, ok := strings.Cut(string(decoded), ".")
	if !ok {
		return false, "", fmt.Errorf("malformed barcode")
	}

	// The owner is part of the signed payload, so it has to be recovered before
	// the signature can be recomputed. Leaving this as a stub and verifying
	// against a zero userID means the recomputed MAC never matches and the
	// scanner rejects every genuine ticket at the gate.
	var userID string
	err = s.db.QueryRow(ctx,
		`SELECT user_id FROM tickets WHERE id = $1 AND event_id = $2`,
		ticketID, eventID).Scan(&userID)
	if err != nil {
		return false, ticketID, fmt.Errorf("unknown ticket")
	}

	// Constant-time compare: != on a signature leaks how much of a forgery was
	// right, which is enough to build the rest of it one byte at a time.
	expected := s.signBarcode(ticketID, eventID, userID)
	if !hmac.Equal([]byte(expected), []byte(barcode)) {
		return false, ticketID, fmt.Errorf("invalid signature")
	}

	// Burn the ticket. The UPDATE is conditional on it being unused, so two
	// scanners racing the same barcode at two gates resolve to exactly one
	// admission: reading a used flag and then writing it lets both in.
	tag, err := s.db.Exec(ctx,
		`UPDATE tickets SET is_used = true, used_at = NOW()
		 WHERE id = $1 AND event_id = $2 AND is_used = false`,
		ticketID, eventID)
	if err != nil {
		return false, ticketID, fmt.Errorf("scan record failed: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, ticketID, fmt.Errorf("ticket already scanned")
	}

	return true, ticketID, nil
}
```

---
