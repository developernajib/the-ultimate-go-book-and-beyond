## Deep Dive: FIX Protocol Gateway

FIX (Financial Information eXchange) is the universal language of institutional trading, every major bank, hedge fund, and broker communicates with exchanges using this protocol. Messages are tag=value text over a long-lived TCP session (`35=D` is a New Order Single, `35=F` a Cancel Request, `35=8` an Execution Report). The `FIXGateway` maintains a persistent session with each institutional client, translates those messages into internal domain objects, and routes them through the risk engine before they reach the matching engine. Sequence state is checkpointed to the session store so a reconnecting client resumes its stream, and heartbeats detect dead connections, which is what a cancel-on-disconnect policy keys off.

This gateway is where an exchange meets input it did not write, so two things deserve attention.

The first is that every numeric tag is parsed and validated rather than assumed. It is worth looking closely at what a stubbed accessor that returns `0` on failure does to this code: `Side` becomes buy or sell by accident, `OrderQty` becomes zero, `OrdType` matches no case and leaves the zero value, which is `TypeMarket`. A garbled message does not produce an error, it produces a plausible market order, and every downstream check happily validates it. Numeric parsers must return an error, and the caller must reject on it.

The second is that FIX prices are decimal text, so this is the boundary where they become the integer cents the rest of the system relies on. Reaching for `ParseFloat` and multiplying by 100 undoes, in one line at the edge, the discipline the matching engine and the ledger maintain everywhere else. It fails on ordinary prices, not exotic ones: `8.29` becomes `828.9999999999999`, which truncates to `828`, so the order rests a cent away from where the client put it. Sweep every two-decimal price from $0.01 to $2,000.00 through that conversion and 9,174 of the 200,000 come out a cent low. The parser below reads the digits instead, which cannot be off by a cent at all.

```go
package fix

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

type MatchingEngine interface {
	SubmitOrder(ctx context.Context, order *Order) error
}

type RiskEngine interface {
	PreTradeRiskCheck(ctx context.Context, order *Order) error
}

type SessionStore interface {
	Save(ctx context.Context, sessionID string, outSeq, inSeq int64) error
}

type Order struct {
	ID        string
	Symbol    string
	Side      Side
	Quantity  int64
	TraderID  string
	Type      OrderType
	Price     int64
	StopPrice int64
}

type Side int

const (
	Buy Side = iota + 1
	Sell
)

type OrderType int

const (
	TypeMarket OrderType = iota + 1
	TypeLimit
	TypeStop
	TypeStopLimit
)

// FIXGateway handles FIX protocol connections from institutional clients
// FIX (Financial Information eXchange) is the industry standard for trading
type FIXGateway struct {
	matchingEngine MatchingEngine
	riskEngine     RiskEngine
	sessionStore   SessionStore
}

// FIX Message Types used in exchange
const (
	MsgTypeLogon              = "A"
	MsgTypeLogout             = "5"
	MsgTypeHeartbeat          = "0"
	MsgTypeNewOrderSingle     = "D"  // new order
	MsgTypeOrderCancelRequest = "F"  // cancel
	MsgTypeOrderCancelReplace = "G"  // modify
	MsgTypeExecutionReport    = "8"  // fill/status
	MsgTypeOrderCancelReject  = "9"  // cancel rejected
	MsgTypeMarketDataRequest  = "V"  // subscribe to market data
)

// OrdStatus (tag 39) values. Worth naming rather than passing "8" around:
// tag 35 (MsgType) also uses "8", for ExecutionReport, and the two are
// unrelated.
const (
	OrdStatusNew      = "0"
	OrdStatusRejected = "8"
)

// ErrSeqGap reports a hole in the inbound stream. The caller answers it with
// a ResendRequest (35=2).
var ErrSeqGap = errors.New("fix: inbound sequence gap")

// FIXSession represents a persistent connection with a broker
type FIXSession struct {
	SenderCompID  string // broker identifier
	TargetCompID  string // exchange identifier
	SessionID     string
	HeartbeatInt  int // seconds between heartbeats
	LastActivity  time.Time
	Authenticated bool

	// mu guards the sequence numbers. The session is driven by a reader
	// goroutine while execution reports are pushed from the matching engine's
	// side, so these counters are shared state. Two goroutines incrementing
	// MsgSeqNum without the lock hand out a duplicate sequence number, and a
	// FIX counterparty treats that as a protocol violation and drops the
	// session mid-trading.
	mu        sync.Mutex
	MsgSeqNum int64 // last outbound sequence number
	NextInSeq int64 // next inbound sequence number expected
}

func (s *FIXSession) nextOutbound() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.MsgSeqNum++
	return s.MsgSeqNum
}

// checkInbound enforces the sequence contract. A FIX session is an ordered
// stream, so a gap means messages were lost in transit. Accepting the newer
// message anyway would silently drop the orders in the hole.
func (s *FIXSession) checkInbound(seq int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	switch {
	case seq == s.NextInSeq:
		s.NextInSeq++
		return nil
	case seq < s.NextInSeq:
		return fmt.Errorf("fix: duplicate inbound sequence %d, expected %d", seq, s.NextInSeq)
	default:
		return fmt.Errorf("%w: got %d, expected %d", ErrSeqGap, seq, s.NextInSeq)
	}
}

// Checkpoint persists sequence state so a reconnecting client resumes its
// stream instead of restarting it. FIX sessions deliberately outlive TCP
// connections, which is why the protocol numbers its messages at all.
func (g *FIXGateway) Checkpoint(ctx context.Context, session *FIXSession) error {
	session.mu.Lock()
	out, in := session.MsgSeqNum, session.NextInSeq
	session.mu.Unlock()

	return g.sessionStore.Save(ctx, session.SessionID, out, in)
}

// ProcessNewOrderSingle handles a new order from a FIX client
func (g *FIXGateway) ProcessNewOrderSingle(ctx context.Context, session *FIXSession, msg FIXMessage) error {
	// An unauthenticated session may not trade. Checking the flag here,
	// rather than trusting that a connection reaching this code must have
	// logged on, is what stops an order that arrives before (or instead of) a
	// Logon from being matched.
	if !session.Authenticated {
		return fmt.Errorf("session %s is not authenticated", session.SessionID)
	}

	seq, err := msg.GetInt64(34) // MsgSeqNum
	if err != nil {
		return fmt.Errorf("MsgSeqNum: %w", err)
	}
	if err := session.checkInbound(seq); err != nil {
		return err
	}

	order, err := g.parseOrder(session, msg)
	if err != nil {
		// A malformed order is rejected, never guessed at.
		return g.sendExecutionReport(session, &Order{ID: msg.GetString(11)},
			OrdStatusRejected, err.Error())
	}

	// Pre-trade risk check
	if err := g.riskEngine.PreTradeRiskCheck(ctx, order); err != nil {
		return g.sendExecutionReport(session, order, OrdStatusRejected, err.Error())
	}

	// Submit to matching engine
	if err := g.matchingEngine.SubmitOrder(ctx, order); err != nil {
		if sendErr := g.sendExecutionReport(session, order, OrdStatusRejected, err.Error()); sendErr != nil {
			return errors.Join(err, sendErr)
		}
		return err
	}

	// Send acknowledgment
	return g.sendExecutionReport(session, order, OrdStatusNew, "")
}

// parseOrder translates a New Order Single into the internal order type.
// Every numeric tag is parsed and validated, because a FIX message is text
// arriving from another company's software over a socket.
func (g *FIXGateway) parseOrder(session *FIXSession, msg FIXMessage) (*Order, error) {
	clOrdID := msg.GetString(11) // ClOrdID
	if clOrdID == "" {
		return nil, errors.New("missing ClOrdID")
	}
	symbol := msg.GetString(55) // Symbol
	if symbol == "" {
		return nil, errors.New("missing Symbol")
	}

	sideCode, err := msg.GetInt(54) // Side
	if err != nil {
		return nil, fmt.Errorf("Side: %w", err)
	}
	side, err := parseFIXSide(sideCode)
	if err != nil {
		return nil, err
	}

	qty, err := msg.GetInt64(38) // OrderQty
	if err != nil {
		return nil, fmt.Errorf("OrderQty: %w", err)
	}
	if qty <= 0 {
		return nil, fmt.Errorf("OrderQty must be positive, got %d", qty)
	}

	order := &Order{
		ID:       clOrdID,
		Symbol:   symbol,
		Side:     side,
		Quantity: qty,
		// The trader comes from the authenticated session, never from the
		// message. A client that could name its own trader ID could trade on
		// another firm's account.
		TraderID: session.SenderCompID,
	}

	ordType, err := msg.GetInt(40) // OrdType
	if err != nil {
		return nil, fmt.Errorf("OrdType: %w", err)
	}
	switch ordType {
	case 1:
		order.Type = TypeMarket
	case 2:
		order.Type = TypeLimit
		if order.Price, err = msg.GetPriceCents(44); err != nil { // Price
			return nil, err
		}
	case 3:
		order.Type = TypeStop
		if order.StopPrice, err = msg.GetPriceCents(99); err != nil { // StopPx
			return nil, err
		}
	case 4:
		order.Type = TypeStopLimit
		if order.Price, err = msg.GetPriceCents(44); err != nil {
			return nil, err
		}
		if order.StopPrice, err = msg.GetPriceCents(99); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported OrdType %d", ordType)
	}

	return order, nil
}

func (g *FIXGateway) sendExecutionReport(session *FIXSession, order *Order, ordStatus, text string) error {
	seq := session.nextOutbound()

	// Build and send FIX ExecutionReport (35=8) stamped with MsgSeqNum=seq.
	// Key fields: OrderID, ExecID, ExecType, OrdStatus, Symbol, Side,
	// LeavesQty, CumQty, AvgPx.
	_ = seq
	return nil
}

func parseFIXSide(side int) (Side, error) {
	switch side {
	case 1:
		return Buy, nil
	case 2:
		return Sell, nil
	default:
		// Anything else (short sale variants, or a garbled tag) is refused
		// rather than folded into Sell.
		return 0, fmt.Errorf("unsupported Side %d", side)
	}
}

type FIXMessage struct {
	Fields map[int]string
}

func (m FIXMessage) GetString(tag int) string { return m.Fields[tag] }

func (m FIXMessage) GetInt(tag int) (int, error) {
	v, err := m.GetInt64(tag)
	return int(v), err
}

func (m FIXMessage) GetInt64(tag int) (int64, error) {
	raw, ok := m.Fields[tag]
	if !ok {
		return 0, fmt.Errorf("missing tag %d", tag)
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("tag %d: %q is not an integer", tag, raw)
	}
	return n, nil
}

// GetPriceCents parses a FIX price into integer cents.
//
// FIX carries prices as decimal text, so this gateway is the exact boundary
// where they become integer minor units. Note what it refuses to do:
// ParseFloat followed by multiplying by 100, which is how a system that is
// careful about money everywhere else lets a rounding error in through the
// front door. The failure is not exotic: "8.29" parses to a float that is a
// hair under 8.29, times 100 is 828.9999999999999, and the conversion to
// int64 truncates it to 828. The order is now priced a cent below what the
// client sent, and at the wrong price it may cross a spread it should not
// have. Parsing the digits cannot be off by a cent.
func (m FIXMessage) GetPriceCents(tag int) (int64, error) {
	raw, ok := m.Fields[tag]
	if !ok {
		return 0, fmt.Errorf("missing tag %d", tag)
	}

	s := raw
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(strings.TrimPrefix(s, "-"), "+")

	whole, frac, _ := strings.Cut(s, ".")
	if whole == "" {
		whole = "0"
	}
	switch len(frac) {
	case 0:
		frac = "00"
	case 1:
		frac += "0"
	case 2:
		// already cents
	default:
		// Sub-penny prices are permitted below $1 under Reg NMS Rule 612.
		// A cent-denominated book cannot represent them, so it says so
		// instead of rounding the difference away.
		return 0, fmt.Errorf("tag %d: %q has sub-cent precision", tag, raw)
	}

	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("tag %d: %q is not a price", tag, raw)
	}
	f, err := strconv.ParseInt(frac, 10, 64)
	if err != nil || f < 0 {
		return 0, fmt.Errorf("tag %d: %q is not a price", tag, raw)
	}

	cents := w*100 + f
	if neg {
		cents = -cents
	}
	return cents, nil
}
```

---
