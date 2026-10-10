## Production Go Implementation: Voice Call Signaling

Voice and video calls in WhatsApp use WebRTC for peer-to-peer media streaming, but the call setup (signaling) flows through the existing WebSocket connection infrastructure. When a user initiates a call, the server relays a call offer containing a WebRTC SDP (Session Description Protocol) to the callee, along with TURN server credentials for NAT traversal. If the callee does not answer within 30 seconds, the call is marked as missed. The actual audio and video data flows directly between the two devices once the WebRTC connection is established, so the server only handles signaling, not media, which is what keeps the media E2E encrypted (WebRTC mandates SRTP) and off the operator's bandwidth bill.

Signaling is where identity gets checked, and it is worth being deliberate about it, because every field arriving from a client is a claim rather than a fact. Two rules govern the code below. The caller's identity comes from the authenticated session, never from the payload, or anyone can ring your phone displaying someone else's name. And the answering party must be the person the call was actually placed to. That second check is easy to omit in a way no compiler will catch: a handler can accept a `calleeID` parameter, look plausible, and never read it, at which point any user who learns a call ID can answer a stranger's call and be connected to a caller who believes they reached someone else. An unused parameter is not a style nit here, it is the authorization.

The ring timeout deserves the same scrutiny. The obvious implementation launches a goroutine that sleeps 30 seconds per call, which at call volume means an enormous population of goroutines whose only job is to wake up and usually discover the call was answered 28 seconds ago. Worse, nothing cancels them. A timer that is stopped when the call is answered costs nothing while it waits, and a durable deadline on the record is what makes the outcome survive the server restarting mid-ring.

```go
package calling

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
)

const ringTimeout = 30 * time.Second

var (
	ErrNotFound   = errors.New("call not found")
	ErrNotRinging = errors.New("call not in ringing state")
)

// CallSignalingService handles WebRTC call setup via the existing WebSocket.
type CallSignalingService struct {
	connRouter  ConnectionRouter
	callDB      CallStore
	turnServers []string

	// Ring timers, so answering a call cancels its timeout instead of leaving
	// a goroutine asleep for the full 30 seconds.
	mu     sync.Mutex
	timers map[string]*time.Timer
}

// CallOffer is what the client sends. It carries no CallID and no CallerID:
// both are assigned or derived by the server. A client-chosen CallID would let
// an attacker collide with, or overwrite, someone else's in-flight call, and a
// client-supplied CallerID is simply a request to be believed about who you
// are.
type CallOffer struct {
	CalleeID string `json:"callee_id"`
	Type     string `json:"type"` // "voice", "video"
	SDP      string `json:"sdp"`
}

type CallAnswer struct {
	CallID string `json:"call_id"`
	SDP    string `json:"sdp"`
}

type ICECandidate struct {
	CallID    string `json:"call_id"`
	Candidate string `json:"candidate"`
}

type CallRecord struct {
	ID        string     `json:"id"`
	CallerID  string     `json:"caller_id"`
	CalleeID  string     `json:"callee_id"`
	Type      string     `json:"type"`
	Status    string     `json:"status"` // ringing, connected, ended, missed
	StartedAt *time.Time `json:"started_at,omitempty"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`
	DurationS int        `json:"duration_seconds"`
	RingsTill time.Time  `json:"rings_till"`
	CreatedAt time.Time  `json:"created_at"`
}

// InitiateCall sends a call offer to the callee.
//
// callerID comes from the authenticated session, not from the request body.
func (s *CallSignalingService) InitiateCall(ctx context.Context, callerID string, offer CallOffer) (*CallRecord, error) {
	if offer.CalleeID == "" || offer.CalleeID == callerID {
		return nil, errors.New("invalid callee")
	}
	if offer.Type != "voice" && offer.Type != "video" {
		return nil, errors.New("invalid call type")
	}

	now := time.Now()
	record := &CallRecord{
		ID:        uuid.NewString(), // server-assigned, unguessable
		CallerID:  callerID,
		CalleeID:  offer.CalleeID,
		Type:      offer.Type,
		Status:    "ringing",
		RingsTill: now.Add(ringTimeout),
		CreatedAt: now,
	}

	if err := s.callDB.Create(ctx, record); err != nil {
		return nil, fmt.Errorf("create call: %w", err)
	}

	data, err := json.Marshal(map[string]any{
		"type":         "call_offer",
		"call_id":      record.ID,
		"caller_id":    callerID,
		"call_type":    offer.Type,
		"sdp":          offer.SDP,
		"turn_servers": s.turnServers,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal offer: %w", err)
	}

	if err := s.connRouter.DeliverToUser(ctx, offer.CalleeID, data); err != nil {
		// Not reachable on a live socket. That is not the same as declining:
		// the callee's phone may simply be asleep, so wake it and keep ringing
		// until the deadline rather than reporting a missed call instantly.
		log.Printf("call %s: callee %s not live, relying on push: %v", record.ID, offer.CalleeID, err)
	}

	s.armRingTimer(record.ID)
	return record, nil
}

// armRingTimer schedules the missed-call transition.
//
// time.AfterFunc, not a goroutine that sleeps. A parked goroutine costs a stack
// and cannot be cancelled, so answered calls would still hold one for the full
// ring timeout. A timer is a heap entry that Stop() removes.
//
// The timer is a latency optimization, not the source of truth: RingsTill is on
// the record, so a sweeper can retire calls whose deadline passed while the
// process that armed the timer was restarting.
func (s *CallSignalingService) armRingTimer(callID string) {
	t := time.AfterFunc(ringTimeout, func() {
		s.mu.Lock()
		delete(s.timers, callID)
		s.mu.Unlock()

		// A fresh context: the request that started the call is long gone, and
		// inheriting its cancellation would abort this the moment the caller's
		// HTTP handler returned.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		// Conditional update: only ringing -> missed. Without the guard this
		// races an answer landing in the same instant and marks a live call
		// missed.
		ok, err := s.callDB.CompareAndSetStatus(ctx, callID, "ringing", "missed")
		if err != nil {
			log.Printf("call %s: ring timeout update: %v", callID, err)
			return
		}
		if !ok {
			return // already answered or ended
		}

		notice, err := json.Marshal(map[string]string{"type": "call_missed", "call_id": callID})
		if err != nil {
			return
		}
		rec, err := s.callDB.Get(ctx, callID)
		if err != nil {
			return
		}
		if err := s.connRouter.DeliverToUser(ctx, rec.CallerID, notice); err != nil {
			log.Printf("call %s: notify caller of miss: %v", callID, err)
		}
	})

	s.mu.Lock()
	if s.timers == nil {
		s.timers = make(map[string]*time.Timer)
	}
	s.timers[callID] = t
	s.mu.Unlock()
}

func (s *CallSignalingService) cancelRingTimer(callID string) {
	s.mu.Lock()
	if t, ok := s.timers[callID]; ok {
		t.Stop()
		delete(s.timers, callID)
	}
	s.mu.Unlock()
}

// AnswerCall processes the callee accepting the call.
//
// calleeID is the authenticated session's user, and it is checked against the
// record. This is the line whose absence lets any user answer any call they can
// name.
func (s *CallSignalingService) AnswerCall(ctx context.Context, calleeID string, answer CallAnswer) error {
	record, err := s.callDB.Get(ctx, answer.CallID)
	if err != nil {
		return fmt.Errorf("get call: %w", err)
	}
	if record.CalleeID != calleeID {
		// Same error as a nonexistent call: do not confirm that this call ID is
		// real to someone with no business answering it.
		return ErrNotFound
	}

	// ringing -> connected, atomically, so two devices racing to answer produce
	// one winner rather than two connected halves.
	ok, err := s.callDB.CompareAndSetStatus(ctx, answer.CallID, "ringing", "connected")
	if err != nil {
		return fmt.Errorf("update status: %w", err)
	}
	if !ok {
		return ErrNotRinging
	}
	s.cancelRingTimer(answer.CallID)

	now := time.Now()
	record.Status = "connected"
	record.StartedAt = &now
	if err := s.callDB.Update(ctx, record); err != nil {
		return fmt.Errorf("save start time: %w", err)
	}

	data, err := json.Marshal(map[string]any{
		"type": "call_answer", "call_id": answer.CallID, "sdp": answer.SDP,
	})
	if err != nil {
		return fmt.Errorf("marshal answer: %w", err)
	}
	return s.connRouter.DeliverToUser(ctx, record.CallerID, data)
}

// EndCall hangs up and records the duration.
func (s *CallSignalingService) EndCall(ctx context.Context, userID, callID string) error {
	record, err := s.callDB.Get(ctx, callID)
	if err != nil {
		return fmt.Errorf("get call: %w", err)
	}
	// Either participant may hang up, nobody else may.
	if record.CallerID != userID && record.CalleeID != userID {
		return ErrNotFound
	}
	if record.Status == "ended" {
		return nil // idempotent
	}

	s.cancelRingTimer(callID)

	now := time.Now()
	record.EndedAt = &now
	record.Status = "ended"
	// DurationS is computed, not left at its zero value. It is measured from
	// answer to hangup, so an unanswered call is 0 rather than counting the
	// time it spent ringing.
	if record.StartedAt != nil {
		record.DurationS = int(now.Sub(*record.StartedAt).Seconds())
	}
	if err := s.callDB.Update(ctx, record); err != nil {
		return fmt.Errorf("update call: %w", err)
	}

	peer := record.CallerID
	if userID == record.CallerID {
		peer = record.CalleeID
	}
	data, err := json.Marshal(map[string]string{"type": "call_ended", "call_id": callID})
	if err != nil {
		return err
	}
	if err := s.connRouter.DeliverToUser(ctx, peer, data); err != nil {
		log.Printf("call %s: notify peer of hangup: %v", callID, err)
	}
	return nil
}
```

---
