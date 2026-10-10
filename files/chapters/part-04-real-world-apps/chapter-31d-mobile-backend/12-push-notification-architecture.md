## Push Notification Architecture

Push notifications on mobile flow through two distinct vendor pipelines: APNs (Apple) and FCM (Firebase/Google). A production notification service must abstract both, handle device token lifecycle, and provide delivery tracking.

### Routing Service Design

A business event (new message, order update, price alert) enters the notification router, which looks up the target user's registered device tokens and dispatches each notification through the platform-specific sender. The diagram below shows this flow:

```
                    ┌─────────────────────┐
  Business event ──►│  Notification Router│ 
                    └──────────┬──────────┘
                               │  looks up device tokens for user
                    ┌──────────▼──────────┐
                    │   Device Registry   │
                    └──┬──────────────┬───┘
                 iOS   │              │  Android
          ┌────────────▼───┐  ┌───────▼────────┐
          │  APNs Sender   │  │   FCM Sender   │
          └────────────────┘  └────────────────┘
```

### Complete Notification Service

The `Service` struct below wraps both an APNs client (using the `sideshow/apns2` library) and an FCM client (using `appleboy/go-fcm`). It accepts a `DeviceRepository` interface for token storage, making the notification logic testable without live push gateways. The `Notify` method fans out to all of a user's devices concurrently, collects delivery results, and automatically deletes tokens that APNs or FCM reports as permanently invalid.

```go
package notification

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"firebase.google.com/go/v4/messaging"
	"github.com/appleboy/go-fcm"
	apns2 "github.com/sideshow/apns2"
	"github.com/sideshow/apns2/payload"
	"github.com/sideshow/apns2/token"
)

// Platform identifies the mobile operating system for a device.
type Platform string

const (
	PlatformIOS     Platform = "ios"
	PlatformAndroid Platform = "android"
)

// DeviceToken is a registered device push token with platform metadata.
type DeviceToken struct {
	UserID    string
	Token     string
	Platform  Platform
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Message is the platform-agnostic notification payload.
type Message struct {
	Title    string
	Body     string
	Data     map[string]string // custom key-value pairs delivered to the app
	ImageURL string            // rich notification image (supported on both platforms)
	Badge    int               // iOS badge count; 0 = no change
}

// DeliveryResult records the outcome of a single send attempt.
type DeliveryResult struct {
	Token   string
	Success bool
	Error   error
	// ShouldDelete is true when the token is permanently invalid and must be
	// removed from the device registry.
	ShouldDelete bool
}

// DeviceRepository is the persistence interface for device tokens.
type DeviceRepository interface {
	GetTokensForUser(ctx context.Context, userID string) ([]DeviceToken, error)
	DeleteToken(ctx context.Context, token string) error
}

// APNsConfig holds credentials for the Apple push gateway.
type APNsConfig struct {
	KeyID      string // 10-char Key ID from Apple Developer Portal
	TeamID     string // 10-char Team ID
	PrivateKey []byte // contents of the .p8 file
	BundleID   string // com.example.myapp
	Production bool
}

// FCMConfig holds credentials for Firebase Cloud Messaging (HTTP v1 API).
// The legacy static server key was retired in June 2024 - all new senders
// must authenticate with an OAuth2 access token minted from a service
// account JSON credential (scope: firebase.messaging).
type FCMConfig struct {
	ProjectID              string // Firebase project ID (used to build the v1 URL)
	ServiceAccountJSONPath string // path to the service-account credential file
}

// Service sends notifications to iOS and Android devices.
type Service struct {
	apnsClient *apns2.Client
	fcmClient  *fcm.Client
	repo       DeviceRepository
	logger     *slog.Logger
	bundleID   string
}

// NewService constructs a ready-to-use notification Service.
func NewService(ctx context.Context, apnsCfg APNsConfig, fcmCfg FCMConfig, repo DeviceRepository, logger *slog.Logger) (*Service, error) {
	// Build APNs token-based auth client (preferred over certificate auth)
	authKey, err := token.AuthKeyFromBytes(apnsCfg.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("notification: parse APNs auth key: %w", err)
	}
	t := &token.Token{
		AuthKey: authKey,
		KeyID:   apnsCfg.KeyID,
		TeamID:  apnsCfg.TeamID,
	}
	var apnsClient *apns2.Client
	if apnsCfg.Production {
		apnsClient = apns2.NewTokenClient(t).Production()
	} else {
		apnsClient = apns2.NewTokenClient(t).Development()
	}

	// Build FCM client (HTTP v1 API, service-account credentials)
	fcmClient, err := fcm.NewClient(ctx, fcm.WithCredentialsFile(fcmCfg.ServiceAccountJSONPath))
	if err != nil {
		return nil, fmt.Errorf("notification: init FCM client: %w", err)
	}

	return &Service{
		apnsClient: apnsClient,
		fcmClient:  fcmClient,
		repo:       repo,
		logger:     logger,
		bundleID:   apnsCfg.BundleID,
	}, nil
}

// Notify sends msg to all registered devices for userID.
// Stale/invalid tokens are deleted from the registry automatically.
func (s *Service) Notify(ctx context.Context, userID string, msg Message) error {
	tokens, err := s.repo.GetTokensForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("notify: get tokens: %w", err)
	}
	if len(tokens) == 0 {
		return nil // user has no registered devices; not an error
	}

	results := s.fanOut(ctx, tokens, msg)

	// Cleanup invalid tokens without blocking the caller.
	go func() {
		cleanCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for _, r := range results {
			if r.ShouldDelete {
				if err := s.repo.DeleteToken(cleanCtx, r.Token); err != nil {
					s.logger.Error("delete stale token", "token_prefix", r.Token[:8], "err", err)
				}
			}
		}
	}()

	// Return first hard error (not token expiry, which is handled above)
	for _, r := range results {
		if r.Error != nil && !r.ShouldDelete {
			return r.Error
		}
	}
	return nil
}

// fanOut sends msg to all tokens concurrently and collects results.
func (s *Service) fanOut(ctx context.Context, tokens []DeviceToken, msg Message) []DeliveryResult {
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		results []DeliveryResult
	)

	for _, dt := range tokens {
		dt := dt
		wg.Add(1)
		go func() {
			defer wg.Done()
			var r DeliveryResult
			switch dt.Platform {
			case PlatformIOS:
				r = s.sendAPNs(ctx, dt.Token, msg)
			case PlatformAndroid:
				r = s.sendFCM(ctx, dt.Token, msg)
			default:
				r = DeliveryResult{Token: dt.Token, Error: fmt.Errorf("unknown platform: %s", dt.Platform)}
			}
			mu.Lock()
			results = append(results, r)
			mu.Unlock()
		}()
	}
	wg.Wait()
	return results
}

// sendAPNs delivers msg to a single iOS device token via APNs HTTP/2.
func (s *Service) sendAPNs(ctx context.Context, deviceToken string, msg Message) DeliveryResult {
	p := payload.NewPayload().
		AlertTitle(msg.Title).
		AlertBody(msg.Body).
		Badge(msg.Badge).
		Sound("default")

	for k, v := range msg.Data {
		p.Custom(k, v)
	}

	notification := &apns2.Notification{
		DeviceToken: deviceToken,
		Topic:       s.bundleID,
		Payload:     p,
		PushType:    apns2.PushTypeAlert,
	}

	resp, err := s.apnsClient.PushWithContext(ctx, notification)
	if err != nil {
		return DeliveryResult{Token: deviceToken, Error: err}
	}

	if resp.Sent() {
		s.logger.Info("APNs delivered", "apns_id", resp.ApnsID)
		return DeliveryResult{Token: deviceToken, Success: true}
	}

	// Permanent token errors - device uninstalled or token rotated
	shouldDelete := resp.Reason == apns2.ReasonUnregistered ||
		resp.Reason == apns2.ReasonBadDeviceToken ||
		resp.Reason == apns2.ReasonDeviceTokenNotForTopic

	return DeliveryResult{
		Token:        deviceToken,
		Error:        fmt.Errorf("APNs: %s", resp.Reason),
		ShouldDelete: shouldDelete,
	}
}

// sendFCM delivers msg to a single Android device via Firebase Cloud Messaging (HTTP v1).
func (s *Service) sendFCM(ctx context.Context, deviceToken string, msg Message) DeliveryResult {
	message := &messaging.Message{
		Token: deviceToken,
		Notification: &messaging.Notification{
			Title:    msg.Title,
			Body:     msg.Body,
			ImageURL: msg.ImageURL,
		},
		Data: msg.Data, // messaging.Message.Data is map[string]string
	}

	resp, err := s.fcmClient.Send(ctx, message)
	if err != nil {
		return DeliveryResult{Token: deviceToken, Error: fmt.Errorf("FCM send: %w", err)}
	}

	// Single message: inspect the one per-message response.
	for _, r := range resp.Responses {
		if !r.Success && r.Error != nil {
			// Unregistered/invalid token: remove it from the registry.
			shouldDelete := messaging.IsUnregistered(r.Error) ||
				messaging.IsInvalidArgument(r.Error)
			return DeliveryResult{
				Token:        deviceToken,
				Error:        r.Error,
				ShouldDelete: shouldDelete,
			}
		}
	}

	return DeliveryResult{Token: deviceToken, Success: true}
}
```

### Notification Batching

When a single event should notify thousands of users (a live-score update, a system announcement), fan-out must be batched to avoid goroutine explosion.

```go
// BatchNotify sends msg to a list of userIDs, processing them in chunks.
// chunkSize controls how many users are processed concurrently per batch.
func (s *Service) BatchNotify(ctx context.Context, userIDs []string, msg Message, chunkSize int) error {
	if chunkSize <= 0 {
		chunkSize = 100
	}
	sem := make(chan struct{}, chunkSize)
	var wg sync.WaitGroup
	errs := make(chan error, len(userIDs))

	for _, uid := range userIDs {
		uid := uid
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer func() {
				<-sem
				wg.Done()
			}()
			if err := s.Notify(ctx, uid, msg); err != nil {
				errs <- fmt.Errorf("user %s: %w", uid, err)
			}
		}()
	}

	wg.Wait()
	close(errs)

	var combined []error
	for e := range errs {
		combined = append(combined, e)
	}
	return errors.Join(combined...)
}
```

### Notification Preferences

Never send a push notification to a user who has opted out. Store preferences at the category level, not just a global toggle.

```go
// NotificationCategory classifies the type of notification for opt-out purposes.
type NotificationCategory string

const (
	CategoryMarketing  NotificationCategory = "marketing"
	CategorySecurity   NotificationCategory = "security"    // never suppressed
	CategorySocial     NotificationCategory = "social"
	CategoryReminders  NotificationCategory = "reminders"
)

// PreferencesRepository reads user notification opt-in/out settings.
type PreferencesRepository interface {
	IsEnabled(ctx context.Context, userID string, category NotificationCategory) (bool, error)
}

// NotifyIfEnabled wraps Notify with a preference check.
func (s *Service) NotifyIfEnabled(ctx context.Context, userID string, category NotificationCategory, msg Message, prefs PreferencesRepository) error {
	if category != CategorySecurity {
		ok, err := prefs.IsEnabled(ctx, userID, category)
		if err != nil {
			return fmt.Errorf("preference check: %w", err)
		}
		if !ok {
			s.logger.Debug("notification suppressed by user preference", "user_id", userID, "category", category)
			return nil
		}
	}
	return s.Notify(ctx, userID, msg)
}
```

### Junior → FAANG: Reading The Push Service Architecture

The service above is the shape of a production push system. A junior reader should internalize three framings before extending it. First, the `DeliveryResult.ShouldDelete` flag encodes the decision that "this token is dead, remove it." That decision is not obvious from the error alone and is specific to each provider. APNs `Unregistered` and `BadDeviceToken` mean dead. APNs `PayloadTooLarge` means the message is bad, not the token. FCM `NOT_FOUND` means dead. FCM `INVALID_ARGUMENT` usually means the message is bad. Misclassifying transient errors as dead tokens is a common bug that silently erodes your token table. Second, the fan-out uses a bounded concurrency (via `sem` in BatchNotify) which is the right pattern, but the per-user `Notify` inside each slot does its own unbounded fan-out across the user's devices. At the median this is fine because most users have one or two devices, but power users with ten or more devices can spike the unbounded inner fan-out. The production fix is a second bounded semaphore for per-user device fan-out. Third, the logic assumes `s.Notify` is idempotent on retry, which it currently is not (a retry would send a second notification to every device). The idempotency key in a real system is the business event ID plus user ID, stored for a deduplication window, and checked before dispatch.

Worked example of a token-cleanup bug. A junior engineer notices that the cleanup goroutine runs without a bound, and after an outage where the token store has millions of dead tokens, the cleanup creates millions of goroutines, each making a database call, and takes down the database. The fix is a bounded worker pool for cleanup, a batch delete (`DELETE FROM tokens WHERE token IN (...)`) instead of single-row deletes, and ideally a soft-delete to a graveyard table so the audit trail is preserved.

Interview framing. If asked to review this code, the senior-track notes include: rate limiter per provider connection, circuit breaker around each provider, metrics for per-provider latency and error rates, per-platform payload size validation (4KB for APNs, 4KB for FCM data messages), collapse ID support for deduplicating updates to the same notification, and graceful degradation when one provider is unavailable (the other continues). Each of these is a staff-level addition that the baseline code does not yet have.

First-job context. Your first real improvement on a push service like this is usually observability. Add a Prometheus histogram for per-provider send latency bucketed by result (success, transient failure, permanent failure), a counter for tokens moved to the graveyard per day per reason, and a gauge for active token count per platform per app version. These three metrics alone enable the dashboards that a push-team on-call needs at 3am.

### Senior @ FAANG: Push Architecture As A Platform, Not A Service

At staff level the push service shown is the control plane of a push platform. The platform comprises: the send API (a gRPC or HTTP interface that product teams call), the fan-out pipeline (queue plus workers that materialize user IDs to device tokens), the send workers (per-provider connection pools with rate limiting), the feedback consumer (processes provider callbacks and errors), the token registry (authoritative device token store), the graveyard (archived dead tokens), the preferences store (opt-in state per category per user), and the observability pipeline (metrics, traces, and a delivery-tracking system that joins send events with client-reported receipts). Each component has an SLO and an owner.

Provider redundancy is the high-value ADR that mid-sized companies skip. The default architecture sends to APNs for iOS and FCM for Android. The staff-level architecture acknowledges that both APNs and FCM have had multi-hour outages and designs for provider failure. Three patterns exist. First, parallel send (send to both APNs and FCM for iOS when FCM has APNs-bridge support, accepting that deduplication is now the client's problem via a collapse-ID). Second, provider failover (detect APNs elevated error rate via the feedback consumer, route iOS traffic through FCM's APNs bridge for the duration of the incident, accept higher latency). Third, WebPush as a third rail (for users who have enabled browser notifications from a PWA, WebPush provides a path that is neither APNs nor FCM). Each has trade-offs. The ADR names which pattern applies to which traffic class and what the activation procedure is during an outage.

Connection management at scale is non-obvious. APNs uses HTTP/2 with long-lived connections and stream multiplexing. A single connection can handle thousands of concurrent streams, so a worker pool with many connections is wasteful. A small number of long-lived connections with many streams each is optimal. The typical pattern is one connection per worker process, with the provider's token (JWT for APNs, OAuth2 access token for FCM) cached and rotated independently of the connection lifecycle. For FCM HTTP v1, the OAuth2 access token is valid for one hour, so the token source must refresh proactively before expiry, not reactively on 401. A 401 from FCM during a critical send is a sharp edge the `appleboy/go-fcm` library used in the example does not always handle cleanly, which is why many teams move to the official Firebase Admin SDK for Go or build a minimal HTTP v1 client themselves.

Delivery tracking is the observability story that separates mature platforms from immature ones. The send-side metrics (provider acceptance rate, per-provider latency) are necessary but insufficient because they do not measure user-visible delivery. The complete picture requires the client to report receipt: when the push handler fires on iOS or Android, the client emits an analytics event with the push's unique ID (generated server-side and included in the data payload). The delivery dashboard joins send events with receipt events and reports, for each send cohort, the percentage of pushes received within N minutes. Anomalies in that percentage, segmented by platform, OS version, app version, and region, are the dashboard view that catches real incidents. Client-reported visibility (did the user actually see the notification, via the notification-posted callback or the user-tapped callback) is the next layer, and it is the one that informs product decisions about notification engagement versus raw delivery.

The push storm playbook deserves a written runbook. Three storm scenarios. First, the product-launch storm: a new feature ships with a default-on push setting, every installed user is eligible, and a marketing team triggers a send to 100 million users at 10am local time. Mitigation: smooth the dispatch over a multi-hour window, per-user jitter, and a hard rate limit at the send-worker layer. Second, the outage-recovery storm: the push pipeline was down for three hours, the ingest queue has backlogged 50 million pushes, and on recovery the workers attempt to drain as fast as possible. Mitigation: a configurable drain rate, progressive ramp-up (start at 10% of normal throughput, double every 15 minutes), and explicit backpressure from the providers (APNs 429, FCM quota exceeded) as the signal to pause. Third, the feedback loop storm: a bad client version crashes on push receipt, which causes the OS to increment its crash-on-notification counter, which causes the OS to throttle future pushes to that app, which looks like a provider issue. Mitigation: client-version-aware send routing (quarantine pushes to known-bad client versions) and a forced-update flow for the crashing version. Each of these is a staff-level runbook item that the on-call team needs in place before the incident, not during.

Topic-based push versus direct send is an architectural choice with scaling implications. Direct send (iterate users, look up tokens, dispatch) scales linearly with the user count per event. Topic-based send (clients subscribe to a topic, the provider handles fan-out) scales O(1) in your infrastructure but requires the topic subscription list to be maintained by the provider. FCM topics scale to millions of subscribers per topic, which is a significant leverage point for broadcast notifications. APNs does not have topic subscriptions in the FCM sense. The equivalent is using FCM's APNs bridge for topic fan-out to iOS. The staff-level decision is which classes of notifications use topic-based fan-out (broadcast announcements, sports scores for a team, weather alerts for a region) versus direct send (per-user personalized notifications). The ADR names the classification rule and the observability to verify that topic subscriptions are not silently dropped when users uninstall.

---
