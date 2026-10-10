## Deep Dive: Market Surveillance System

Exchanges are legally required to detect and report market manipulation to regulators, and the surveillance system does this by continuously monitoring order and trade streams for known abuse patterns. Detected patterns are sent to a `RegulatoryAlerter` that logs them to an immutable audit trail and escalates to human analysts.

The design lesson in this file is that both obvious detectors are wrong, and they are wrong in opposite directions.

The obvious spoofing detector is a cancellation-to-fill ratio over a sliding window. It generates nothing but false positives. A market maker quoting continuously cancels and replaces almost every order it sends as the market moves under it, so its cancel rate sits far above any threshold you would pick, and the detector ends up accusing the firms supplying the liquidity while a spoofer who cancels 90% hides comfortably underneath the line. The ratio measures activity, not intent. What actually distinguishes spoofing is the shape: size displayed on one side, withdrawn without ever trading, while the same participant quietly fills on the *other* side, which is the part that proves the display was never an offer to trade. So the detector below requires all three conditions together, and it still only produces a candidate for a human to judge.

The obvious wash trade detector compares `BuyerID` and `SellerID` on each trade. That check is now dead code by construction: the matching engine's self-trade prevention refuses to cross a trader against their own resting order, so such a trade cannot reach the tape. If one ever does, it is not a manipulation finding at all, it is a bug in the engine, and it deserves a louder alert than any surveillance hit. Real wash trading is routed through separate accounts that the engine sees as unrelated strangers, so catching it requires the beneficial ownership graph, which is the piece the naive version leaves as a comment.

```go
package surveillance

import (
	"context"
	"fmt"
	"time"
)

type Order struct {
	Quantity int64
	Filled   int64
	Side     Side
	Price    int64
	Status   OrderStatus
	Type     OrderType
}

type Trade struct {
	ID       string
	BuyerID  string
	SellerID string
	Quantity int64
	Price    int64
}

type OrderType int

const TypeLimit OrderType = 1

type OrderStatus int

const StatusCanceled OrderStatus = 3

type Side int

const (
	Buy Side = iota
	Sell
)

type OrderStream interface {
	GetOrders(ctx context.Context, traderID, symbol string, window time.Duration) ([]Order, error)
}

type TradeStream interface {
	GetTrades(ctx context.Context, symbol string, window time.Duration) ([]Trade, error)
}

type RegulatoryAlerter interface {
	Raise(ctx context.Context, p ManipulationPattern) error
}

// AccountGraph resolves a trading account to its beneficial owner. Wash
// trading between two accounts is invisible without it.
type AccountGraph interface {
	BeneficialOwner(ctx context.Context, traderID string) (string, error)
}

// SurveillanceEngine detects market manipulation in real-time
type SurveillanceEngine struct {
	orderStream OrderStream
	tradeStream TradeStream
	accounts    AccountGraph
	alerter     RegulatoryAlerter
}

const (
	minOrdersForSignal = 10   // below this the window says nothing
	minDisplayedVolume = 5000 // shares, ignore noise-sized activity
	withdrawnPct       = 90   // share of displayed size that left without trading
	oppositeFillPct    = 10   // opposite-side fills, as a share of displayed size
	minLayerLevels     = 5    // distinct price levels stacked on one side
)

// ManipulationPattern defines detectable market abuse patterns
type ManipulationPattern struct {
	Type     string // spoofing, layering, wash_trading, stp_bypass
	TraderID string
	Symbol   string
	// Score ranks candidates for analyst triage. It is not a probability and
	// must never be presented as one: a number like 0.85 invented at the call
	// site reads as evidence in a report it was never meant to support.
	Score      int
	Evidence   []string
	DetectedAt time.Time
}

// Scan runs the detectors for one symbol and raises whatever they find.
func (e *SurveillanceEngine) Scan(ctx context.Context, traderID, symbol string, window time.Duration) error {
	var found []ManipulationPattern

	if p, err := e.DetectSpoofing(ctx, traderID, symbol, window); err != nil {
		return err
	} else if p != nil {
		found = append(found, *p)
	}

	if p, err := e.DetectLayering(ctx, traderID, symbol, window); err != nil {
		return err
	} else if p != nil {
		found = append(found, *p)
	}

	washes, err := e.DetectWashTrading(ctx, symbol, window)
	if err != nil {
		return err
	}
	found = append(found, washes...)

	for _, p := range found {
		if err := e.alerter.Raise(ctx, p); err != nil {
			return fmt.Errorf("raise %s alert for %s: %w", p.Type, p.TraderID, err)
		}
	}
	return nil
}

// DetectSpoofing identifies size displayed with no intent to trade.
//
// Three conditions must hold together, and the third is the one that carries
// the weight: meaningful size shown on one side, nearly all of it withdrawn
// without trading, and fills by the same trader on the opposite side inside
// the same window. A market maker satisfies the first two every minute of
// every day and the third almost never.
func (e *SurveillanceEngine) DetectSpoofing(ctx context.Context, traderID, symbol string, window time.Duration) (*ManipulationPattern, error) {
	orders, err := e.orderStream.GetOrders(ctx, traderID, symbol, window)
	if err != nil {
		return nil, fmt.Errorf("load orders for %s: %w", traderID, err)
	}
	if len(orders) < minOrdersForSignal {
		return nil, nil // insufficient data
	}

	var bidShown, bidPulled, bidFilled int64
	var askShown, askPulled, askFilled int64
	for _, o := range orders {
		unfilled := o.Quantity - o.Filled
		if o.Side == Buy {
			bidShown += o.Quantity
			bidFilled += o.Filled
			if o.Status == StatusCanceled {
				bidPulled += unfilled
			}
		} else {
			askShown += o.Quantity
			askFilled += o.Filled
			if o.Status == StatusCanceled {
				askPulled += unfilled
			}
		}
	}

	// Bids shown then pulled while selling: painting a bid to sell into it.
	if p := spoofCandidate(traderID, symbol, "bid", bidShown, bidPulled, askFilled); p != nil {
		return p, nil
	}
	// And the mirror image: offers shown then pulled while buying.
	if p := spoofCandidate(traderID, symbol, "ask", askShown, askPulled, bidFilled); p != nil {
		return p, nil
	}
	return nil, nil
}

func spoofCandidate(traderID, symbol, side string, shown, pulled, oppositeFilled int64) *ManipulationPattern {
	if shown < minDisplayedVolume || oppositeFilled == 0 {
		return nil
	}
	// Integer comparisons rather than float ratios: pulled/shown > 90%.
	if pulled*100 < shown*withdrawnPct {
		return nil
	}
	if oppositeFilled*100 < shown*oppositeFillPct {
		return nil
	}
	return &ManipulationPattern{
		Type:     "spoofing",
		TraderID: traderID,
		Symbol:   symbol,
		Score:    int(pulled * 100 / shown),
		Evidence: []string{
			fmt.Sprintf("side=%s displayed=%d withdrawn=%d", side, shown, pulled),
			fmt.Sprintf("opposite_side_filled=%d", oppositeFilled),
		},
		DetectedAt: time.Now(),
	}
}

// DetectWashTrading identifies trades whose two sides share a beneficial
// owner. See the note above on why comparing BuyerID to SellerID is not the
// detector: the engine already makes that trade impossible, so its appearance
// means self-trade prevention is broken rather than that someone is washing.
func (e *SurveillanceEngine) DetectWashTrading(ctx context.Context, symbol string, window time.Duration) ([]ManipulationPattern, error) {
	trades, err := e.tradeStream.GetTrades(ctx, symbol, window)
	if err != nil {
		return nil, fmt.Errorf("load trades for %s: %w", symbol, err)
	}

	owners := make(map[string]string, 2*len(trades))
	ownerOf := func(traderID string) (string, error) {
		if o, ok := owners[traderID]; ok {
			return o, nil
		}
		o, err := e.accounts.BeneficialOwner(ctx, traderID)
		if err != nil {
			return "", fmt.Errorf("resolve owner of %s: %w", traderID, err)
		}
		owners[traderID] = o
		return o, nil
	}

	var patterns []ManipulationPattern
	for _, t := range trades {
		if t.BuyerID == t.SellerID {
			patterns = append(patterns, ManipulationPattern{
				Type:     "stp_bypass",
				TraderID: t.BuyerID,
				Symbol:   symbol,
				Score:    100,
				Evidence: []string{fmt.Sprintf(
					"engine crossed a trader with itself, trade_id=%s qty=%d price=%d",
					t.ID, t.Quantity, t.Price)},
				DetectedAt: time.Now(),
			})
			continue
		}

		buyOwner, err := ownerOf(t.BuyerID)
		if err != nil {
			return nil, err
		}
		sellOwner, err := ownerOf(t.SellerID)
		if err != nil {
			return nil, err
		}
		if buyOwner == sellOwner {
			patterns = append(patterns, ManipulationPattern{
				Type:     "wash_trading",
				TraderID: buyOwner,
				Symbol:   symbol,
				Score:    90,
				Evidence: []string{fmt.Sprintf(
					"same beneficial owner %s on both sides via %s and %s, trade_id=%s qty=%d",
					buyOwner, t.BuyerID, t.SellerID, t.ID, t.Quantity)},
				DetectedAt: time.Now(),
			})
		}
	}
	return patterns, nil
}

// DetectLayering identifies orders stacked across several price levels on one
// side and pulled without trading, with nothing comparable on the other side.
// Counting distinct price levels matters: many orders at a single price is
// ordinary queue management, whereas a ladder across levels is built to be
// looked at.
func (e *SurveillanceEngine) DetectLayering(ctx context.Context, traderID, symbol string, window time.Duration) (*ManipulationPattern, error) {
	orders, err := e.orderStream.GetOrders(ctx, traderID, symbol, window)
	if err != nil {
		return nil, fmt.Errorf("load orders for %s: %w", traderID, err)
	}

	bidLevels := make(map[int64]bool)
	askLevels := make(map[int64]bool)
	for _, o := range orders {
		if o.Type != TypeLimit || o.Status != StatusCanceled || o.Filled > 0 {
			continue // only size that was shown and left without trading
		}
		if o.Side == Buy {
			bidLevels[o.Price] = true
		} else {
			askLevels[o.Price] = true
		}
	}

	// Check both sides. The original one-sided test let a trader ladder the
	// offer to buy cheaply and never register.
	if p := layerCandidate(traderID, symbol, "bid", len(bidLevels), len(askLevels)); p != nil {
		return p, nil
	}
	if p := layerCandidate(traderID, symbol, "ask", len(askLevels), len(bidLevels)); p != nil {
		return p, nil
	}
	return nil, nil
}

func layerCandidate(traderID, symbol, side string, levels, otherLevels int) *ManipulationPattern {
	if levels < minLayerLevels || otherLevels > 1 {
		return nil
	}
	return &ManipulationPattern{
		Type:     "layering",
		TraderID: traderID,
		Symbol:   symbol,
		Score:    levels * 10,
		Evidence: []string{fmt.Sprintf(
			"%d canceled price levels on the %s side, %d on the other",
			levels, side, otherLevels)},
		DetectedAt: time.Now(),
	}
}
```

---
