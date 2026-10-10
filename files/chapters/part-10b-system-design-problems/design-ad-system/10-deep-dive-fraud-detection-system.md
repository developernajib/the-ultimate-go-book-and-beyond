## Deep Dive: Fraud Detection System

Click fraud costs advertisers billions of dollars annually, so a reliable fraud detection system is non-negotiable in any ad platform. This implementation uses a three-layer approach: rule-based checks (known bot signatures, datacenter IPs) that run in under 1ms, velocity-based checks (detecting abnormal click patterns per IP or user) that run in under 5ms, and an ML-based model for sophisticated fraud patterns that runs in under 50ms. The layered design matters because you want to catch obvious fraud cheaply and quickly before investing expensive ML inference on every request. Each layer returns a fraud score, and the system blocks requests that exceed the threshold at any layer.

```go
package fraud

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

type MLFraudModel interface {
	Predict(features []float64) float64
}

type IPIntelligence interface {
	IsDatacenterIP(ip string) bool
}

// FraudDetector implements multi-layer fraud detection for ad clicks
type FraudDetector struct {
	rdb     *redis.Client
	mlModel MLFraudModel
	ipDB    IPIntelligence
}

type FraudCheckResult struct {
	IsFraud bool     `json:"is_fraud"`
	Score   float64  `json:"score"`
	Reasons []string `json:"reasons"`
	Layer   string   `json:"layer"`
}

// Layer 1: Rule-based detection (< 1ms)
func (d *FraudDetector) CheckRules(ctx context.Context, signals FraudSignals) *FraudCheckResult {
	var reasons []string
	if d.ipDB.IsDatacenterIP(signals.IP) {
		reasons = append(reasons, "datacenter_ip")
	}
	if isBotUserAgent(signals.UserAgent) {
		reasons = append(reasons, "bot_user_agent")
	}
	if !signals.CookiesEnabled || !signals.JSEnabled {
		reasons = append(reasons, "headless_browser")
	}
	blocked, _ := d.rdb.SIsMember(ctx, "fraud:blocked_ips", signals.IP).Result()
	if blocked {
		reasons = append(reasons, "blocked_ip")
	}
	if len(reasons) > 0 {
		return &FraudCheckResult{IsFraud: true, Score: 1.0, Reasons: reasons, Layer: "rule"}
	}
	return nil
}

// Layer 2: Velocity-based detection (< 5ms)
func (d *FraudDetector) CheckVelocity(ctx context.Context, signals FraudSignals) *FraudCheckResult {
	var reasons []string
	now := time.Now().Unix()
	hourAgo := fmt.Sprintf("%d", now-3600)

	ipKey := fmt.Sprintf("vel:click:ip:%s", signals.IP)
	clickCount, _ := d.rdb.ZCount(ctx, ipKey, hourAgo, "+inf").Result()
	if clickCount > 20 {
		reasons = append(reasons, fmt.Sprintf("high_click_velocity_ip:%d/hour", clickCount))
	}

	userKey := fmt.Sprintf("vel:click:user:%s", signals.UserID)
	userClicks, _ := d.rdb.ZCount(ctx, userKey, hourAgo, "+inf").Result()
	if userClicks > 10 {
		reasons = append(reasons, fmt.Sprintf("high_click_velocity_user:%d/hour", userClicks))
	}

	adUserKey := fmt.Sprintf("vel:click:ad_user:%s:%s", signals.AdID, signals.UserID)
	repeatClicks, _ := d.rdb.ZCount(ctx, adUserKey, hourAgo, "+inf").Result()
	if repeatClicks > 3 {
		reasons = append(reasons, "repeat_click_same_ad")
	}

	impTime, _ := d.rdb.Get(ctx, fmt.Sprintf("imp:time:%s", signals.ImpressionID)).Int64()
	if impTime > 0 && (now-impTime) < 1 {
		reasons = append(reasons, "click_too_fast")
	}

	// Record this click in all three velocity windows
	member := fmt.Sprintf("%d:%s", now, signals.AdID)
	for _, key := range []string{ipKey, userKey, adUserKey} {
		d.rdb.ZAdd(ctx, key, redis.Z{Score: float64(now), Member: member})
		d.rdb.Expire(ctx, key, 24*time.Hour)
	}

	if len(reasons) > 0 {
		score := math.Min(float64(len(reasons))*0.3, 1.0)
		return &FraudCheckResult{IsFraud: score > 0.7, Score: score, Reasons: reasons, Layer: "velocity"}
	}
	return nil
}

// Layer 3: ML-based detection (< 50ms)
func (d *FraudDetector) CheckML(ctx context.Context, signals FraudSignals) *FraudCheckResult {
	features := d.extractFeatures(ctx, signals)
	score := d.mlModel.Predict(features)
	if score > 0.85 {
		return &FraudCheckResult{IsFraud: true, Score: score, Reasons: []string{"ml_model_high_risk"}, Layer: "ml"}
	}
	return nil
}

func (d *FraudDetector) extractFeatures(ctx context.Context, s FraudSignals) []float64 {
	return make([]float64, 50) // 50+ features: IP reputation, device fingerprint, CTR history, etc.
}

func isBotUserAgent(ua string) bool {
	for _, sig := range []string{"bot", "crawler", "spider", "headless", "phantom", "selenium"} {
		if strings.Contains(strings.ToLower(ua), sig) {
			return true
		}
	}
	return false
}

type FraudSignals struct {
	UserID, IP, UserAgent, AdID, ImpressionID string
	CookiesEnabled, JSEnabled                  bool
}
```

---
