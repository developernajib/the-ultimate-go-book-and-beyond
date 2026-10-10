## 52H.9 Complete Real-Time Notification Service

This section ties together the patterns from earlier in the chapter into a complete notification service for a SaaS product. The service uses JetStream for durable event delivery, NATS KV for user notification preferences, and Prometheus for observability. When a user event arrives (signup, purchase, support ticket), the service looks up the user's channel preferences and fans out notifications to email, push, and in-app channels concurrently. Failed deliveries are retried with exponential backoff via JetStream's `NakWithDelay`.

```go
// file: services/notifications/service.go
package notifications

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// UserEvent represents a domain event that may trigger notifications.
type UserEvent struct {
	EventID   string          `json:"event_id"`
	UserID    string          `json:"user_id"`
	Type      string          `json:"type"` // "signup", "purchase", "support_ticket"
	Timestamp time.Time       `json:"timestamp"`
	Payload   json.RawMessage `json:"payload"`
}

// UserPreferences controls which notification channels are active for a user.
type UserPreferences struct {
	UserID      string `json:"user_id"`
	EmailEnabled bool   `json:"email_enabled"`
	PushEnabled  bool   `json:"push_enabled"`
	InAppEnabled bool   `json:"in_app_enabled"`
	Email        string `json:"email"`
	PushToken    string `json:"push_token"`
}

// NotificationResult records the outcome of a notification attempt.
type NotificationResult struct {
	Channel   string
	UserID    string
	EventType string
	Success   bool
	Error     string
}

// Metrics holds Prometheus metrics for the notification service.
type Metrics struct {
	MessagesReceived  prometheus.Counter
	MessagesProcessed *prometheus.CounterVec
	MessagesFailed    *prometheus.CounterVec
	ProcessingLatency prometheus.Histogram
	MessageLag        prometheus.Gauge
}

// NewMetrics registers and returns notification service metrics.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	return &Metrics{
		MessagesReceived: promauto.With(reg).NewCounter(prometheus.CounterOpts{
			Name: "notifications_messages_received_total",
			Help: "Total messages received from JetStream",
		}),
		MessagesProcessed: promauto.With(reg).NewCounterVec(prometheus.CounterOpts{
			Name: "notifications_messages_processed_total",
			Help: "Total messages successfully processed",
		}, []string{"channel", "event_type"}),
		MessagesFailed: promauto.With(reg).NewCounterVec(prometheus.CounterOpts{
			Name: "notifications_messages_failed_total",
			Help: "Total messages that failed processing",
		}, []string{"channel", "event_type"}),
		ProcessingLatency: promauto.With(reg).NewHistogram(prometheus.HistogramOpts{
			Name:    "notifications_processing_duration_seconds",
			Help:    "Notification processing latency",
			Buckets: prometheus.DefBuckets,
		}),
		MessageLag: promauto.With(reg).NewGauge(prometheus.GaugeOpts{
			Name: "notifications_stream_lag_messages",
			Help: "Number of unprocessed messages in the stream",
		}),
	}
}

// NotificationService is the main service orchestrating the notification pipeline.
type NotificationService struct {
	js          nats.JetStreamContext
	kvStore     nats.KeyValue
	emailWorker NotificationWorker
	pushWorker  NotificationWorker
	inAppWorker NotificationWorker
	metrics     *Metrics
	logger      *slog.Logger
}

// NotificationWorker is the interface for channel-specific senders.
type NotificationWorker interface {
	Send(ctx context.Context, userID string, prefs UserPreferences, event UserEvent) error
}

// ServiceConfig configures the notification service.
type ServiceConfig struct {
	StreamName      string
	ConsumerName    string
	EventSubjects   []string
	PrefsBucket     string
	MaxDeliver      int
	AckWait         time.Duration
}

// NewNotificationService creates and wires up the notification service.
func NewNotificationService(
	conn *nats.Conn,
	cfg ServiceConfig,
	emailWorker, pushWorker, inAppWorker NotificationWorker,
	metrics *Metrics,
	logger *slog.Logger,
) (*NotificationService, error) {
	js, err := conn.JetStream()
	if err != nil {
		return nil, fmt.Errorf("creating jetstream context: %w", err)
	}

	// Ensure the events stream exists.
	_, err = js.AddStream(&nats.StreamConfig{
		Name:       cfg.StreamName,
		Subjects:   cfg.EventSubjects,
		Storage:    nats.FileStorage,
		Retention:  nats.WorkQueuePolicy,
		Replicas:   3,
		MaxAge:     72 * time.Hour,
		MaxBytes:   10 * 1024 * 1024 * 1024, // 10 GiB
		Duplicates: 5 * time.Minute,
	})
	if err != nil && err != nats.ErrStreamNameAlreadyInUse {
		return nil, fmt.Errorf("ensuring stream %s: %w", cfg.StreamName, err)
	}

	// Ensure user preferences KV bucket.
	kvBucket, err := js.CreateKeyValue(&nats.KeyValueConfig{
		Bucket:   cfg.PrefsBucket,
		Storage:  nats.FileStorage,
		Replicas: 3,
		TTL:      0, // preferences don't expire
	})
	if err != nil {
		kvBucket, err = js.KeyValue(cfg.PrefsBucket)
		if err != nil {
			return nil, fmt.Errorf("binding to prefs kv bucket: %w", err)
		}
	}

	return &NotificationService{
		js:          js,
		kvStore:     kvBucket,
		emailWorker: emailWorker,
		pushWorker:  pushWorker,
		inAppWorker: inAppWorker,
		metrics:     metrics,
		logger:      logger,
	}, nil
}

// Run starts pull consumer workers and blocks until context is canceled.
func (s *NotificationService) Run(ctx context.Context, cfg ServiceConfig, workerCount int) error {
	backoff := []time.Duration{
		5 * time.Second,
		30 * time.Second,
		2 * time.Minute,
		10 * time.Minute,
	}

	sub, err := s.js.PullSubscribe(
		"user.events.>",
		cfg.ConsumerName,
		nats.BindStream(cfg.StreamName),
		nats.AckWait(cfg.AckWait),
		nats.MaxDeliver(cfg.MaxDeliver),
		nats.BackOff(backoff),
		nats.AckExplicit(),
	)
	if err != nil {
		return fmt.Errorf("creating pull consumer %s: %w", cfg.ConsumerName, err)
	}
	defer sub.Unsubscribe() //nolint:errcheck

	s.logger.Info("notification service started",
		slog.Int("workers", workerCount),
		slog.String("consumer", cfg.ConsumerName),
	)

	var wg sync.WaitGroup
	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			s.workerLoop(ctx, sub, workerID)
		}(i)
	}

	wg.Wait()
	return nil
}

// workerLoop is a single worker goroutine fetching and processing messages.
func (s *NotificationService) workerLoop(ctx context.Context, sub *nats.Subscription, id int) {
	logger := s.logger.With(slog.Int("worker_id", id))
	logger.Info("worker started")

	for {
		select {
		case <-ctx.Done():
			logger.Info("worker stopping")
			return
		default:
		}

		msgs, err := sub.Fetch(5, nats.Context(ctx))
		if err != nil {
			if err == nats.ErrTimeout || err == context.DeadlineExceeded || err == context.Canceled {
				continue
			}
			logger.Error("fetch error", slog.String("error", err.Error()))
			time.Sleep(1 * time.Second)
			continue
		}

		for _, msg := range msgs {
			s.processMessage(ctx, msg, logger)
		}
	}
}

// processMessage handles a single user event message.
func (s *NotificationService) processMessage(ctx context.Context, msg *nats.Msg, logger *slog.Logger) {
	start := time.Now()
	s.metrics.MessagesReceived.Inc()

	meta, err := msg.Metadata()
	if err != nil {
		logger.Error("failed to get metadata", slog.String("error", err.Error()))
		_ = msg.Nak()
		return
	}

	var event UserEvent
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		logger.Error("failed to unmarshal event",
			slog.Uint64("seq", meta.Sequence.Stream),
			slog.String("error", err.Error()),
		)
		// Permanent failure - ack to avoid infinite retry.
		_ = msg.Ack()
		return
	}

	logger.Info("processing event",
		slog.String("event_id", event.EventID),
		slog.String("user_id", event.UserID),
		slog.String("type", event.Type),
		slog.Uint64("delivery", meta.NumDelivered),
	)

	prefs, err := s.getUserPreferences(ctx, event.UserID)
	if err != nil {
		logger.Error("failed to get user preferences",
			slog.String("user_id", event.UserID),
			slog.String("error", err.Error()),
		)
		_ = msg.NakWithDelay(backoffForDelivery(meta.NumDelivered))
		return
	}

	// Fan-out to enabled channels concurrently.
	results := s.fanOutNotification(ctx, prefs, event)

	allSucceeded := true
	for _, result := range results {
		if result.Success {
			s.metrics.MessagesProcessed.WithLabelValues(result.Channel, result.EventType).Inc()
		} else {
			s.metrics.MessagesFailed.WithLabelValues(result.Channel, result.EventType).Inc()
			allSucceeded = false
		}
	}

	s.metrics.ProcessingLatency.Observe(time.Since(start).Seconds())

	if allSucceeded {
		if err := msg.Ack(); err != nil {
			logger.Error("ack failed", slog.String("error", err.Error()))
		}
	} else {
		delay := backoffForDelivery(meta.NumDelivered)
		if err := msg.NakWithDelay(delay); err != nil {
			logger.Error("nak failed", slog.String("error", err.Error()))
		}
	}
}

// fanOutNotification concurrently sends to all enabled channels.
func (s *NotificationService) fanOutNotification(
	ctx context.Context,
	prefs *UserPreferences,
	event UserEvent,
) []NotificationResult {
	type task struct {
		channel string
		worker  NotificationWorker
		enabled bool
	}

	tasks := []task{
		{"email", s.emailWorker, prefs.EmailEnabled},
		{"push", s.pushWorker, prefs.PushEnabled},
		{"in_app", s.inAppWorker, prefs.InAppEnabled},
	}

	results := make([]NotificationResult, 0, 3)
	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, t := range tasks {
		if !t.enabled {
			continue
		}

		wg.Add(1)
		go func(t task) {
			defer wg.Done()

			result := NotificationResult{
				Channel:   t.channel,
				UserID:    event.UserID,
				EventType: event.Type,
				Success:   true,
			}

			if err := t.worker.Send(ctx, event.UserID, *prefs, event); err != nil {
				result.Success = false
				result.Error = err.Error()
				s.logger.Error("notification send failed",
					slog.String("channel", t.channel),
					slog.String("user_id", event.UserID),
					slog.String("error", err.Error()),
				)
			}

			mu.Lock()
			results = append(results, result)
			mu.Unlock()
		}(t)
	}

	wg.Wait()
	return results
}

// getUserPreferences fetches user preferences from the NATS KV store.
func (s *NotificationService) getUserPreferences(ctx context.Context, userID string) (*UserPreferences, error) {
	entry, err := s.kvStore.Get(userID)
	if err != nil {
		if err == nats.ErrKeyNotFound {
			// Default preferences: all channels enabled.
			return &UserPreferences{
				UserID:       userID,
				EmailEnabled: true,
				PushEnabled:  true,
				InAppEnabled: true,
			}, nil
		}
		return nil, fmt.Errorf("kv get prefs for %s: %w", userID, err)
	}

	var prefs UserPreferences
	if err := json.Unmarshal(entry.Value(), &prefs); err != nil {
		return nil, fmt.Errorf("unmarshal prefs for %s: %w", userID, err)
	}
	return &prefs, nil
}

// PublishEvent is the HTTP handler side - publishes a user event to JetStream.
func (s *NotificationService) PublishEvent(ctx context.Context, event UserEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshaling event: %w", err)
	}

	subject := fmt.Sprintf("user.events.%s", event.Type)
	ack, err := s.js.Publish(subject, data, nats.MsgId(event.EventID))
	if err != nil {
		return fmt.Errorf("publishing event %s: %w", event.EventID, err)
	}

	s.logger.Info("event published",
		slog.String("event_id", event.EventID),
		slog.String("subject", subject),
		slog.Uint64("seq", ack.Sequence),
		slog.Bool("duplicate", ack.Duplicate),
	)
	return nil
}

// backoffForDelivery returns the delay before retry based on delivery number.
func backoffForDelivery(delivery uint64) time.Duration {
	delays := []time.Duration{
		10 * time.Second,
		30 * time.Second,
		2 * time.Minute,
		10 * time.Minute,
		30 * time.Minute,
	}
	idx := int(delivery) - 1
	if idx < 0 {
		return delays[0]
	}
	if idx >= len(delays) {
		return delays[len(delays)-1]
	}
	return delays[idx]
}
```

The `main.go` below wires the service together: it connects to NATS, registers Prometheus metrics, starts the notification workers, and sets up graceful shutdown. On receiving SIGINT or SIGTERM, it drains the NATS connection (allowing in-flight messages to finish processing) before shutting down the HTTP metrics server. The three `NotificationWorker` implementations - email, push, and in-app - are stubs that log their actions. In production, these would call SES/SendGrid, FCM/APNs, and a persistence layer respectively.

```go
// file: services/notifications/main.go
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	// Connect to NATS with production-grade options.
	conn, err := nats.Connect(
		os.Getenv("NATS_URL"),
		nats.Name("notification-service"),
		nats.MaxReconnects(10),
		nats.ReconnectWait(2*time.Second),
		nats.DrainTimeout(30*time.Second),
		nats.ReconnectHandler(func(nc *nats.Conn) {
			logger.Warn("nats reconnected", slog.String("url", nc.ConnectedUrl()))
		}),
		nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
			if err != nil {
				logger.Error("nats disconnected", slog.String("error", err.Error()))
			}
		}),
	)
	if err != nil {
		logger.Error("failed to connect to nats", slog.String("error", err.Error()))
		os.Exit(1)
	}

	reg := prometheus.NewRegistry()
	metrics := NewMetrics(reg)

	svc, err := NewNotificationService(
		conn,
		ServiceConfig{
			StreamName:    "USER-EVENTS",
			ConsumerName:  "notification-router",
			EventSubjects: []string{"user.events.>"},
			PrefsBucket:   "user-prefs",
			MaxDeliver:    5,
			AckWait:       30 * time.Second,
		},
		&EmailWorker{logger: logger},
		&PushWorker{logger: logger},
		&InAppWorker{logger: logger},
		metrics,
		logger,
	)
	if err != nil {
		logger.Error("failed to create notification service", slog.String("error", err.Error()))
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())

	// Metrics HTTP server.
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if conn.IsConnected() {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	})

	srv := &http.Server{Addr: ":8080", Handler: mux}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("metrics server failed", slog.String("error", err.Error()))
		}
	}()

	// Graceful shutdown on signal.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigCh
		logger.Info("shutdown signal received")
		cancel()

		// Drain NATS connection (processes in-flight messages).
		if err := conn.Drain(); err != nil {
			logger.Error("nats drain failed", slog.String("error", err.Error()))
		}

		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("http server shutdown failed", slog.String("error", err.Error()))
		}
	}()

	logger.Info("notification service running")
	if err := svc.Run(ctx, ServiceConfig{
		StreamName:   "USER-EVENTS",
		ConsumerName: "notification-router",
		AckWait:      30 * time.Second,
		MaxDeliver:   5,
	}, 4); err != nil {
		logger.Error("service run failed", slog.String("error", err.Error()))
	}
}

// EmailWorker implements NotificationWorker for email delivery.
type EmailWorker struct{ logger *slog.Logger }

func (w *EmailWorker) Send(ctx context.Context, userID string, prefs UserPreferences, event UserEvent) error {
	w.logger.Info("sending email",
		slog.String("user_id", userID),
		slog.String("email", prefs.Email),
		slog.String("event_type", event.Type),
	)
	// Real implementation: call SES/SendGrid API here.
	return nil
}

// PushWorker implements NotificationWorker for push notifications.
type PushWorker struct{ logger *slog.Logger }

func (w *PushWorker) Send(ctx context.Context, userID string, prefs UserPreferences, event UserEvent) error {
	w.logger.Info("sending push",
		slog.String("user_id", userID),
		slog.String("push_token", prefs.PushToken),
	)
	// Real implementation: call FCM/APNs here.
	return nil
}

// InAppWorker implements NotificationWorker for in-app notifications.
type InAppWorker struct{ logger *slog.Logger }

func (w *InAppWorker) Send(ctx context.Context, userID string, prefs UserPreferences, event UserEvent) error {
	w.logger.Info("storing in-app notification",
		slog.String("user_id", userID),
		slog.String("event_type", event.Type),
	)
	// Real implementation: write to Redis/Postgres.
	return nil
}
```

### Junior -> FAANG: Reading a Complete Service as an Architecture Study

The notification service in this section is not just a code example. It is a template for how production Go services using JetStream are structured. Read it as an architecture study, not just as code to copy.

Identify the boundaries between components: the `NotificationService` owns the JetStream subscription and fan-out logic. Individual `NotificationWorker` implementations own channel-specific delivery. The `Metrics` struct owns observability. The `main.go` owns lifecycle management. Each component has a single responsibility, which means each one can be tested independently and replaced without touching the others.

The `NotificationWorker` interface is the key extensibility point. Adding a new notification channel (SMS, Slack, webhook) means implementing the interface and adding one entry to the `tasks` slice in `fanOutNotification`. No other code changes. This is the Open-Closed Principle in practice.

For interview preparation: be ready to explain why the service uses `msg.Ack()` for parse failures (permanent errors should not be retried) and `msg.NakWithDelay` for transient failures (preference lookup failures, channel send failures). This distinction is one of the first things FAANG interviewers probe in messaging system design questions.

### Senior @ FAANG: Production Gaps in the Notification Service and How to Fill Them

The notification service is well-structured but has several gaps that would be mandatory to address before a FAANG production deployment.

The first gap is partial fan-out failure handling. `fanOutNotification` returns results for each channel, and the `processMessage` function naks the message if any channel fails. This means a message where email succeeds but push fails gets nacked and redelivered. On the next delivery, the email worker sends the email again (a duplicate), even though only push needs to retry. The fix is idempotency at the channel level: before sending, check a deduplication store (Redis SET with key `dedup:notify:<eventID>:<channel>`, value `1`, TTL equals message retention window). If the key exists, skip the send. This turns the at-least-once delivery guarantee into effectively-once from the user's perspective.

The second gap is the `getUserPreferences` fallback: when the KV key is not found, all channels are enabled by default. This is a reasonable default but creates a correctness risk. If the KV store is temporarily unreachable (not just missing the key, but returning a connection error), the error path falls through to the same "all channels enabled" behavior when it should nack and retry. The error check should distinguish between `nats.ErrKeyNotFound` (key is absent, use defaults) and all other errors (KV is unavailable, nack and retry). The current code returns an error for KV failures, and `processMessage` correctly naks those, so this is actually handled correctly. Verify this in code review by tracing the error path explicitly.

The third gap is worker count tuning. The `Run` method takes a `workerCount` parameter, but there is no mechanism to auto-tune it based on consumer lag. For notification services with highly variable traffic (Black Friday bursts), a fixed worker count is either over-provisioned (wastes compute during normal traffic) or under-provisioned (builds lag during spikes). The mature solution is lag-based autoscaling: a separate goroutine polls `ConsumerInfo.NumPending`, and when lag exceeds a threshold, it increases the number of active worker goroutines up to a configured maximum. When lag drops below a lower threshold, it reduces workers. This is a platform-level concern that belongs in the JetStream client library rather than individual services.

The fourth gap is the metrics set. The `Metrics` struct tracks received, processed, failed, and latency. Missing from this set: per-channel success rate (to detect email provider degradation independently of push degradation), preference lookup latency (to detect KV store performance issues), and message age at processing time (to detect that the consumer is falling behind the stream's head). These four metrics, combined with consumer `NumPending` from JetStream, give a complete picture of the service's health.

---
