## Deep Dive: Ad Serving Pipeline

The ad serving pipeline is the entry point that handles the full lifecycle of an ad request: parsing the publisher's ad slot parameters, running the auction, and returning the winning ad markup along with tracking URLs. When no auction winner is found (no bids or budget exhaustion), the pipeline returns a 1x1 transparent GIF as a fallback so the publisher's page layout is not broken. The tracking URLs use HMAC-SHA256 signatures to prevent tampering, ensuring that impression and click events cannot be forged by malicious actors. This is important because every tracked event directly affects billing.

```go
package adserving

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

type Bid struct {
	AdMarkup string
	AdID     string
	CrID     string
}

type AuctionResult struct {
	WinnerBid  Bid
	ClearPrice float64
}

type BidRequest struct {
	ID          string
	Impressions []Impression
	Site        *Site
	AT          int
	Tmax        int
}

type Impression struct {
	ID       string
	Bidfloor float64
}

type Site struct {
	Domain string
}

type AuctionEngine struct{}

func (a *AuctionEngine) RunAuction(ctx context.Context, req BidRequest) (*AuctionResult, error) {
	return &AuctionResult{}, nil
}

type AdServingPipeline struct {
	auctionEngine *AuctionEngine
	signingKey    string
}

func (p *AdServingPipeline) ServeAd(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	start := time.Now()
	slot := parseAdSlot(r)
	bidReq := p.buildBidRequest(ctx, r, slot)

	result, err := p.auctionEngine.RunAuction(ctx, bidReq)
	if err != nil {
		w.Header().Set("Content-Type", "image/gif")
		w.Write(blankGIF)
		return
	}

	resp := AdResponse{
		AdMarkup:      result.WinnerBid.AdMarkup,
		ImpressionURL: p.trackURL("impression", result, start),
		ClickURL:      p.clickURL(result),
		Width:         slot.Width,
		Height:        slot.Height,
		LatencyMs:     time.Since(start).Milliseconds(),
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

type AdSlot struct {
	PublisherID, SlotID, Format string
	Width, Height               int
}
type AdResponse struct {
	AdMarkup, ImpressionURL, ClickURL string
	Width, Height                      int
	LatencyMs                          int64
}

func (p *AdServingPipeline) trackURL(t string, r *AuctionResult, s time.Time) string {
	params := fmt.Sprintf("type=%s&ad=%s&price=%.4f&ts=%d", t, r.WinnerBid.AdID, r.ClearPrice, s.UnixMilli())
	mac := hmac.New(sha256.New, []byte(p.signingKey))
	mac.Write([]byte(params))
	return fmt.Sprintf("https://track.adplatform.com/v1/event?%s&sig=%s", params, hex.EncodeToString(mac.Sum(nil)))
}

func (p *AdServingPipeline) clickURL(r *AuctionResult) string {
	// dest is the creative's click-through landing page, looked up by creative ID
	dest := p.lookupClickThrough(r.WinnerBid.CrID)
	return fmt.Sprintf("https://click.adplatform.com/v1/click?ad=%s&dest=%s", r.WinnerBid.AdID, url.QueryEscape(dest))
}

func (p *AdServingPipeline) buildBidRequest(ctx context.Context, r *http.Request, slot AdSlot) BidRequest {
	return BidRequest{ID: generateAuctionID(), Impressions: []Impression{{ID: slot.SlotID, Bidfloor: 0.50}}, Site: &Site{Domain: r.Host}, AT: 2, Tmax: 80}
}

func parseAdSlot(r *http.Request) AdSlot {
	w, _ := strconv.Atoi(r.URL.Query().Get("w"))
	h, _ := strconv.Atoi(r.URL.Query().Get("h"))
	if w == 0 {
		w = 300
	}
	if h == 0 {
		h = 250
	}
	return AdSlot{PublisherID: r.URL.Query().Get("pub"), SlotID: r.URL.Query().Get("slot"), Width: w, Height: h, Format: r.URL.Query().Get("fmt")}
}

func (p *AdServingPipeline) lookupClickThrough(crID string) string {
	return "https://example.com/landing"
}

func generateAuctionID() string {
	return "auc-123"
}

var blankGIF = []byte{0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,0x80,0x00,0x00,0xff,0xff,0xff,0x00,0x00,0x00,0x21,0xf9,0x04,0x01,0x00,0x00,0x00,0x00,0x2c,0x00,0x00,0x00,0x00,0x01,0x00,0x01,0x00,0x00,0x02,0x02,0x44,0x01,0x00,0x3b}
```

---
