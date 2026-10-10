## Part 2: Push Notifications

### Apple Push Notification Service (APNs)

APNs requires HTTP/2 and token-based authentication using a signed JWT. Token-based auth (a `.p8` key + Team ID + Key ID) is preferred over the certificate-based flow, one key works across all your apps, keys don't expire annually, and rotation is trivial. The client below loads a `.p8` private key from disk, constructs an ES256-signed JWT on each send, and posts the notification payload to Apple's device-specific endpoint. It supports alert customization, badge counts, sound, collapse IDs (for replacing outdated notifications), and priority levels (10 for immediate delivery, 5 for power-efficient batching).

**Payload size limits.** Standard remote notifications are capped at 4 KB. VoIP pushes (PushKit) get 5 KB. The JWT itself should be cached and reused for up to ~55 minutes (Apple rejects tokens older than ~60 minutes with `ExpiredProviderToken`), regenerating it on every send wastes CPU and triggers `TooManyProviderTokenUpdates` under load. The example below regenerates per-call for clarity. A production client caches the signed JWT behind a `sync.Mutex` with a 55-minute TTL.

```go
package push

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// APNsClient sends push notifications to iOS devices
type APNsClient struct {
	teamID     string
	keyID      string
	bundleID   string
	privateKey *ecdsa.PrivateKey
	httpClient *http.Client
	production bool
}

func NewAPNsClient(teamID, keyID, bundleID, privateKeyPath string, production bool) (*APNsClient, error) {
	keyData, err := os.ReadFile(privateKeyPath)
	if err != nil {
		return nil, fmt.Errorf("read key: %w", err)
	}

	block, _ := pem.Decode(keyData)
	if block == nil {
		return nil, fmt.Errorf("invalid PEM data")
	}

	key, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse key: %w", err)
	}

	// APNs requires HTTP/2
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
		ForceAttemptHTTP2: true,
	}

	return &APNsClient{
		teamID:     teamID,
		keyID:      keyID,
		bundleID:   bundleID,
		privateKey: key,
		production: production,
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   10 * time.Second,
		},
	}, nil
}

// APNsPayload is the notification payload
type APNsPayload struct {
	APS     APSAlert               `json:"aps"`
	Custom  map[string]any `json:"-"` // merged into top level
}

type APSAlert struct {
	Alert    any         `json:"alert,omitempty"` // string or AlertBody
	Badge    *int        `json:"badge,omitempty"`
	Sound    string      `json:"sound,omitempty"`
	Category string      `json:"category,omitempty"`
	ThreadID string      `json:"thread-id,omitempty"`
	ContentAvailable int `json:"content-available,omitempty"` // 1 for silent notification
}

type AlertBody struct {
	Title    string `json:"title,omitempty"`
	Subtitle string `json:"subtitle,omitempty"`
	Body     string `json:"body,omitempty"`
}

// Notification is the complete notification to send
type APNsNotification struct {
	DeviceToken string
	Title       string
	Body        string
	Badge       *int
	Sound       string
	Category    string
	ThreadID    string
	Data        map[string]any
	Expiry      time.Time
	Priority    int // 5 (low) or 10 (immediate)
	CollapseID  string // notifications with same ID collapse to one
}

// Send sends a push notification to an iOS device
func (c *APNsClient) Send(notif APNsNotification) error {
	token, err := c.generateToken()
	if err != nil {
		return fmt.Errorf("generate token: %w", err)
	}

	payload := map[string]any{
		"aps": APSAlert{
			Alert: AlertBody{
				Title: notif.Title,
				Body:  notif.Body,
			},
			Badge:    notif.Badge,
			Sound:    notif.Sound,
			Category: notif.Category,
			ThreadID: notif.ThreadID,
		},
	}
	for k, v := range notif.Data {
		payload[k] = v
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	host := "https://api.sandbox.push.apple.com"
	if c.production {
		host = "https://api.push.apple.com"
	}

	url := fmt.Sprintf("%s/3/device/%s", host, notif.DeviceToken)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}

	req.Header.Set("authorization", "bearer "+token)
	req.Header.Set("apns-topic", c.bundleID)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("Content-Type", "application/json")

	priority := notif.Priority
	if priority == 0 {
		priority = 10
	}
	req.Header.Set("apns-priority", fmt.Sprintf("%d", priority))

	if !notif.Expiry.IsZero() {
		req.Header.Set("apns-expiration", fmt.Sprintf("%d", notif.Expiry.Unix()))
	}

	if notif.CollapseID != "" {
		req.Header.Set("apns-collapse-id", notif.CollapseID)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("send notification: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var apnsErr struct {
			Reason    string `json:"reason"`
			Timestamp int64  `json:"timestamp"`
		}
		json.NewDecoder(resp.Body).Decode(&apnsErr)
		return fmt.Errorf("APNs error %d: %s", resp.StatusCode, apnsErr.Reason)
	}

	return nil
}

func (c *APNsClient) generateToken() (string, error) {
	claims := jwt.MapClaims{
		"iss": c.teamID,
		"iat": time.Now().Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["kid"] = c.keyID

	return token.SignedString(c.privateKey)
}
```

### Firebase Cloud Messaging (FCM)

FCM handles Android, iOS (as an alternative to direct APNs), and web push. The legacy HTTP API (`key=AAA...` server key) was retired in June 2024, all senders must use the **FCM HTTP v1 API**, which authenticates with a short-lived OAuth2 access token minted from a Google service account JSON credential. Request the scope `https://www.googleapis.com/auth/firebase.messaging`. The access token is valid for one hour, so leaking it has a bounded blast radius compared to the old static server keys. The `FCMClient` below obtains short-lived access tokens from the service account credentials and sends messages through the FCM v1 HTTP endpoint (`https://fcm.googleapis.com/v1/projects/{project_id}/messages:send`). Each message can carry platform-specific configuration blocks (`AndroidConfig`, `APNSConfig`, `WebpushConfig`) so a single API call can customize delivery behavior per platform. FCM payload cap is 4 KB for notification messages and 4 KB for data-only messages.

```go
package push

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// FCMClient sends push notifications to Android/web via Firebase
type FCMClient struct {
	projectID  string
	tokenSrc   oauth2.TokenSource
	httpClient *http.Client
}

func NewFCMClient(ctx context.Context, projectID, serviceAccountPath string) (*FCMClient, error) {
	creds, err := os.ReadFile(serviceAccountPath)
	if err != nil {
		return nil, fmt.Errorf("read credentials: %w", err)
	}

	config, err := google.CredentialsFromJSON(ctx, creds,
		"https://www.googleapis.com/auth/firebase.messaging")
	if err != nil {
		return nil, fmt.Errorf("parse credentials: %w", err)
	}

	return &FCMClient{
		projectID:  projectID,
		tokenSrc:   config.TokenSource,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}, nil
}

// FCMMessage is a Firebase notification message
type FCMMessage struct {
	Token     string            `json:"token,omitempty"`      // device token
	Topic     string            `json:"topic,omitempty"`       // topic (e.g., "news")
	Condition string            `json:"condition,omitempty"`   // topic condition
	Notification *FCMNotification `json:"notification,omitempty"`
	Data      map[string]string `json:"data,omitempty"`
	Android   *AndroidConfig    `json:"android,omitempty"`
	APNS      *APNSConfig       `json:"apns,omitempty"`
	Webpush   *WebpushConfig    `json:"webpush,omitempty"`
}

type FCMNotification struct {
	Title    string `json:"title,omitempty"`
	Body     string `json:"body,omitempty"`
	ImageURL string `json:"image,omitempty"`
}

type AndroidConfig struct {
	Priority    string             `json:"priority,omitempty"` // "normal" or "high"
	TTL         string             `json:"ttl,omitempty"`      // e.g., "3600s"
	CollapseKey string             `json:"collapse_key,omitempty"`
	Notification *AndroidNotification `json:"notification,omitempty"`
}

type AndroidNotification struct {
	ChannelID string `json:"channel_id,omitempty"`
	Icon      string `json:"icon,omitempty"`
	Color     string `json:"color,omitempty"` // "#rrggbb"
}

type APNSConfig struct {
	Headers map[string]string `json:"headers,omitempty"`
	Payload map[string]any `json:"payload,omitempty"`
}

type WebpushConfig struct {
	Headers      map[string]string `json:"headers,omitempty"`
	Notification *FCMNotification  `json:"notification,omitempty"`
}

// Send sends a notification via FCM
func (c *FCMClient) Send(ctx context.Context, msg FCMMessage) (string, error) {
	token, err := c.tokenSrc.Token()
	if err != nil {
		return "", fmt.Errorf("get access token: %w", err)
	}

	reqBody := map[string]any{"message": msg}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal message: %w", err)
	}

	url := fmt.Sprintf("https://fcm.googleapis.com/v1/projects/%s/messages:send", c.projectID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}

	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("send FCM: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		Name string `json:"name"` // message ID
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}

	if result.Error != nil {
		return "", fmt.Errorf("FCM error %d: %s", result.Error.Code, result.Error.Message)
	}

	return result.Name, nil
}

// SendToTopic sends a notification to all subscribers of a topic
func (c *FCMClient) SendToTopic(ctx context.Context, topic, title, body string, data map[string]string) error {
	_, err := c.Send(ctx, FCMMessage{
		Topic: topic, // FCM HTTP v1 uses the bare topic name (no "/topics/" prefix)
		Notification: &FCMNotification{
			Title: title,
			Body:  body,
		},
		Data: data,
		Android: &AndroidConfig{
			Priority: "high",
			TTL:      "3600s",
		},
	})
	return err
}
```

### Unified Push Dispatcher

With both APNs and FCM clients in place, the dispatcher routes a single notification request to all of a user's registered devices. It looks up device tokens from a `TokenStore`, sends to each device through the appropriate platform client, and automatically cleans up stale tokens when the push gateway reports them as unregistered. This means the caller only needs to provide a user ID and a message - the dispatcher handles platform routing, error logging, and token lifecycle.

```go
package push

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// Platform identifies the device platform
type Platform string

const (
	PlatformIOS     Platform = "ios"
	PlatformAndroid Platform = "android"
	PlatformWeb     Platform = "web"
)

// DeviceToken stores a device's push token
type DeviceToken struct {
	UserID      string
	DeviceID    string
	Platform    Platform
	Token       string
	AppVersion  string
	LastSeen    time.Time
}

// PushRequest is a unified push notification request
type PushRequest struct {
	UserID  string
	Title   string
	Body    string
	Data        map[string]string
	Badge   *int
	ImageURL string
	Category string // for iOS action categories
}

// Dispatcher routes notifications to the correct service
type Dispatcher struct {
	apns   *APNsClient
	fcm    *FCMClient
	tokenDB TokenStore
	logger *slog.Logger
}

// TokenStore manages device tokens
type TokenStore interface {
	GetTokensForUser(ctx context.Context, userID string) ([]DeviceToken, error)
	DeleteToken(ctx context.Context, token string) error
}

func NewDispatcher(apns *APNsClient, fcm *FCMClient, tokenDB TokenStore, logger *slog.Logger) *Dispatcher {
	return &Dispatcher{
		apns:    apns,
		fcm:     fcm,
		tokenDB: tokenDB,
		logger:  logger,
	}
}

// Send sends a notification to all devices of a user
func (d *Dispatcher) Send(ctx context.Context, req PushRequest) error {
	tokens, err := d.tokenDB.GetTokensForUser(ctx, req.UserID)
	if err != nil {
		return fmt.Errorf("get tokens: %w", err)
	}

	for _, token := range tokens {
		if err := d.sendToDevice(ctx, token, req); err != nil {
			d.logger.Error("push failed",
				slog.String("device", token.DeviceID),
				slog.String("platform", string(token.Platform)),
				slog.String("error", err.Error()),
			)

			// Handle specific errors
			if isTokenInvalid(err) {
				// Remove stale token
				if delErr := d.tokenDB.DeleteToken(ctx, token.Token); delErr != nil {
					d.logger.Error("delete token failed", slog.String("error", delErr.Error()))
				}
			}
		}
	}
	return nil
}

func (d *Dispatcher) sendToDevice(ctx context.Context, token DeviceToken, req PushRequest) error {
	switch token.Platform {
	case PlatformIOS:
		badge := req.Badge
		zero := 0
		if badge == nil {
			badge = &zero
		}
		return d.apns.Send(APNsNotification{
			DeviceToken: token.Token,
			Title:       req.Title,
			Body:        req.Body,
			Badge:       badge,
			Category:    req.Category,
			Data:        req.Data,
			Priority:    10,
		})

	case PlatformAndroid, PlatformWeb:
		data := make(map[string]string)
		for k, v := range req.Data {
			data[k] = v
		}
		_, err := d.fcm.Send(ctx, FCMMessage{
			Token: token.Token,
			Notification: &FCMNotification{
				Title:    req.Title,
				Body:     req.Body,
				ImageURL: req.ImageURL,
			},
			Data: data,
			Android: &AndroidConfig{
				Priority: "high",
				TTL:      "3600s",
			},
		})
		return err
	}
	return fmt.Errorf("unknown platform: %s", token.Platform)
}

func isTokenInvalid(err error) bool {
	errStr := err.Error()
	return contains(errStr, "Unregistered") ||
		contains(errStr, "InvalidToken") ||
		contains(errStr, "BadDeviceToken")
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && strings.Contains(s, sub))
}
```

### Junior → FAANG: Reading the APNs and FCM Clients Correctly

A common first-job mistake on a mobile backend team is treating push notifications as a reliable delivery channel. They are not. APNs is explicitly best-effort. Apple's documentation states that the service does not guarantee delivery, does not guarantee ordering, and coalesces messages to the same device under load. FCM offers similar best-effort guarantees on the free tier. The correct mental model is that push is a hint to the client to wake up and pull, not a message bus. Any architecture that assumes a push arrived (for example, deleting server-side state because the client was notified) is broken. The invariant is: server state remains authoritative, push wakes the client, the client pulls and reconciles.

Worked example of the common bug. A junior engineer writes a mobile chat backend that sends a push with the full message body in the payload, and the client displays it. Sometimes the message is missing. Why? Three failure modes: APNs dropped it, the device was off for longer than the `apns-expiration` window, or the collapse ID overwrote it with a newer notification. The fix is to include only a message ID and sender in the push payload and have the client fetch the message body on wake. This also fixes the end-to-end-encryption issue because you never ship plaintext through Apple's servers.

Interview framing for APNs token auth. If asked "how do you authenticate with APNs," the right answer names the `.p8` key plus Team ID plus Key ID JWT flow, notes that tokens expire in about an hour so they must be cached with a sub-hour TTL, and flags that regenerating the JWT per request triggers Apple's `TooManyProviderTokenUpdates` rate limit. The wrong answer is "I would use an API key." There is no API key model for APNs. Knowing the auth model distinguishes candidates who have actually shipped iOS push from those who have read a tutorial.

First-job context on token lifecycle. You will inherit a token table with millions of rows, a meaningful fraction of which are dead. Devices have been wiped, apps uninstalled, users churned. Your first real improvement is usually building the token graveyard: when APNs returns `Unregistered` or FCM returns `NOT_FOUND` or `INVALID_ARGUMENT`, move the token to a `tokens_archived` table with a reason and timestamp. Never hard-delete immediately. You want the audit trail when a user complains that they stopped receiving notifications. The archive also feeds the dashboard that tracks token health, which is the single most useful push observability metric you can build in your first month.

### Senior @ FAANG: Push Fan-Out Architecture, Delivery Semantics, and the Storm Scenarios

At scale push is not a function call. It is a pipeline. The dispatcher shown above is fine for thousands of devices. At ten million or a hundred million devices the architecture changes shape. The staff-level design problem is not "how do I send a push" but "how do I send a hundred million pushes in under fifteen minutes without overwhelming APNs, FCM, the token database, or my own infrastructure, while preserving delivery priority for time-sensitive traffic."

The canonical fan-out architecture has four stages. An ingest API accepts a push-send intent (user ID, topic, segment) and writes it to a durable queue (Kafka, Google Pub/Sub, AWS SQS with FIFO groups) with the intent hashed so duplicates are suppressed. A fan-out worker pool reads intents and materializes them into per-device send tasks, looking up tokens from a sharded token store (typically a key-value store like Bigtable or DynamoDB keyed by user ID, because the access pattern is always "all tokens for user X"). A send worker pool consumes per-device tasks and dispatches to APNs or FCM, with per-provider rate limiters and per-provider connection pools (APNs HTTP/2 benefits from long-lived connections, ideally one per worker, with stream multiplexing). A feedback consumer reads APNs and FCM delivery receipts and error responses, updates the token store, and feeds the observability pipeline. Each stage is independently scalable and independently observable.

Topic-based push at Meta scale is instructive. Instagram and WhatsApp fan-out to millions of subscribers per topic in seconds. The trick is not to iterate the subscriber list in the sender. It is to partition subscribers by shard and dispatch per-shard fan-out to workers colocated with the token shard, so the token read and the send happen in the same region without a cross-region hop. This is the pattern that makes sub-minute fan-out to ten million devices feasible on commodity infrastructure.

Silent push (content-available on iOS, data-only on Android) is the staff-level lever that most teams under-use. It lets the server wake the client in the background without a visible notification, which the client uses to trigger a sync, pre-fetch content, or refresh a token. The trade-off is that both platforms rate-limit silent push aggressively: APNs throttles `content-available` pushes to protect battery, and Android's Doze mode can delay them arbitrarily. The staff-level ADR should document which product flows use silent push, what the expected delivery latency is, and what the fallback is when silent push is throttled. The fallback is almost always "pull on next foreground" with a server-side invariant that works regardless.

Delivery guarantees are the observability story that separates mature mobile backends from immature ones. You cannot measure delivery because neither APNs nor FCM tells you the device actually showed the notification. What you can measure is acceptance by the provider (200 response), token health (rolling count of valid tokens per platform per app version), client-reported receipt (the client logs an analytics event when it processes the push, which is your lower-bound delivery rate), and client-reported visibility (for iOS the user interaction delegate, for Android the notification posted callback). The headline dashboard metric at staff level is not "pushes sent." It is "pushes sent minus client-reported receipt within five minutes," segmented by platform, OS version, and app version. Anomalies in that metric are usually one of four things: a provider incident, a token rotation event (iOS app reinstall generates a new token and old pushes silently drop), a bad client version that crashes on notification receipt, or a payload format regression. The first one is easy. The other three are the staff-level incidents you want dashboards to surface in minutes, not days.

Token rotation and the device graveyard deserve their own ADR. Tokens rotate on app reinstall, on OS restore to a new device, on explicit re-registration, and silently in some provider-initiated flows. The invariant to maintain is: any token the server holds is either the canonical current token for a device or archived. Never two active tokens for the same `user_id + device_id` pair. The database schema should enforce this with a unique index, and the registration endpoint should be an upsert that archives the previous token with reason `rotated`. The graveyard retains tokens for a bounded period (commonly 90 days) with the reason they were removed, which is gold for postmortems when a product manager asks why a segment of users stopped receiving notifications six weeks ago.

WebPush with VAPID is the third push channel that deserves first-class treatment in a 2026 mobile backend, even though the chapter title says mobile. Progressive Web Apps and the iOS 16.4+ WebPush support on home-screen-installed PWAs mean that a meaningful fraction of your push audience may not be native iOS or Android. VAPID (Voluntary Application Server Identification) is the authentication scheme: you generate a key pair, the public key is embedded in the client subscription, and the server signs each push with the private key. The payload is encrypted with a per-subscription ECDH-derived key. The Go library `github.com/SherClockHolmes/webpush-go` handles this end to end. The staff-level decision is whether to treat WebPush as a third dispatcher branch (adding operational complexity but preserving provider independence) or to route WebPush through FCM's browser push support (simpler but adds a dependency on Firebase for web users). For teams already on Firebase the latter is usually right. For teams that have deliberately kept Firebase out of the web stack, direct WebPush is the answer.

Push storm scenarios are the staff-level incident category to design against. Three common storms: the launch-day storm (app release ships with a bad notification config, every device that updates registers and a push is sent to all at once), the outage-recovery storm (the push fan-out was down for two hours, the queue drained to backlog, and when the system recovers it dispatches the backlog in minutes, saturating APNs and your own rate limiters), and the thundering herd on cold-start (server-side event triggers a push to every user who matches a segment, all wake at once, all hit the BFF with the same request within a one-minute window). The mitigations are smoothing (dispatch the backlog over a window instead of as fast as possible), jitter (add per-device random delay before the client acts on a push), and BFF-side request coalescing with short TTL cache so that the herd hits one cache fill instead of one database query per device. The ADR to write is the one that says, for each traffic class, which smoothing and jitter policies apply and what the SLO degradation looks like when they are engaged.

---
