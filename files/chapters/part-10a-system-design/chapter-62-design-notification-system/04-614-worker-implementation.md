## 62.4 Worker Implementation

### Base Worker

The base worker defines the common notification delivery lifecycle: dequeue a batch from the channel-specific queue, process each notification through the channel provider (email, SMS, push), update delivery status, and handle failures with exponential backoff retries. All channel-specific workers embed this base, overriding only the `processNotification` method with the provider-specific API call. The worker pool spawns a configurable number of goroutines to process notifications concurrently, with a `WaitGroup` ensuring all in-flight notifications complete before the worker shuts down gracefully.

```go
// worker/base_worker.go
package worker

import (
    "context"
    "encoding/json"
    "log"
    "sync"
    "time"

    "github.com/segmentio/kafka-go"
    "yourproject/types"
)

// NotificationWorker processes notifications
type NotificationWorker struct {
    reader     *kafka.Reader
    sender     NotificationSender
    repo       NotificationRepository
    retrier    Retrier
    metrics    Metrics
    delayer    Delayer // hands scheduled messages to a delay queue

    concurrency int
    wg          sync.WaitGroup
    stopCh      chan struct{}
}

// Delayer re-delivers a message when its scheduled time arrives
type Delayer interface {
    Delay(ctx context.Context, msg kafka.Message, until time.Time) error
}

// NotificationSender interface for channel-specific senders
type NotificationSender interface {
    Send(ctx context.Context, notification *types.Notification, content *RenderedContent) error
    Channel() types.Channel
}

// RenderedContent represents rendered notification content
type RenderedContent struct {
    Subject string
    Body    string
    HTML    string
    Data    map[string]any
}

// NewNotificationWorker creates a new worker
func NewNotificationWorker(reader *kafka.Reader, sender NotificationSender, repo NotificationRepository, concurrency int) *NotificationWorker {
    return &NotificationWorker{
        reader:      reader,
        sender:      sender,
        repo:        repo,
        retrier:     NewExponentialRetrier(3, time.Second, time.Minute),
        concurrency: concurrency,
        stopCh:      make(chan struct{}),
    }
}

// Start begins processing notifications
func (w *NotificationWorker) Start(ctx context.Context) {
    // Create worker pool
    jobs := make(chan kafka.Message, w.concurrency*2)

    for i := 0; i < w.concurrency; i++ {
        w.wg.Add(1)
        go w.worker(ctx, jobs)
    }

    // Read messages and dispatch to workers
    go func() {
        for {
            select {
            case <-w.stopCh:
                close(jobs)
                return
            default:
                msg, err := w.reader.FetchMessage(ctx)
                if err != nil {
                    if ctx.Err() != nil {
                        return
                    }
                    log.Printf("Error fetching message: %v", err)
                    continue
                }

                // Filter by channel
                channelHeader := getHeader(msg.Headers, "channel")
                if channelHeader != string(w.sender.Channel()) {
                    w.reader.CommitMessages(ctx, msg)
                    continue
                }

                jobs <- msg
            }
        }
    }()
}

func (w *NotificationWorker) worker(ctx context.Context, jobs <-chan kafka.Message) {
    defer w.wg.Done()

    for msg := range jobs {
        w.processMessage(ctx, msg)
    }
}

func (w *NotificationWorker) processMessage(ctx context.Context, msg kafka.Message) {
    var notification types.Notification
    if err := json.Unmarshal(msg.Value, &notification); err != nil {
        log.Printf("Error unmarshaling notification: %v", err)
        w.reader.CommitMessages(ctx, msg)
        return
    }

    // Check if scheduled for later. This message MUST be handed to a
    // delay queue before we move on: Kafka commits are cumulative, so
    // committing any later message on this partition implicitly
    // commits this offset too, and silently returning here would lose
    // the notification the moment that happens.
    if notification.ScheduledAt != nil && notification.ScheduledAt.After(time.Now()) {
        if err := w.delayer.Delay(ctx, msg, *notification.ScheduledAt); err != nil {
            log.Printf("delay notification %s: %v", notification.ID, err)
            return // uncommitted: will be redelivered and retried
        }
        w.reader.CommitMessages(ctx, msg)
        return
    }

    // Check expiration
    if notification.ExpiresAt != nil && notification.ExpiresAt.Before(time.Now()) {
        w.repo.UpdateStatus(ctx, notification.ID, types.StatusFailed, "notification expired")
        w.reader.CommitMessages(ctx, msg)
        return
    }

    // Update status to sending
    w.repo.UpdateStatus(ctx, notification.ID, types.StatusSending, "")

    // Render content
    content, err := w.renderContent(&notification)
    if err != nil {
        w.repo.UpdateStatus(ctx, notification.ID, types.StatusFailed, err.Error())
        w.reader.CommitMessages(ctx, msg)
        return
    }

    // Send with retry
    err = w.retrier.Do(func() error {
        return w.sender.Send(ctx, &notification, content)
    })

    if err != nil {
        w.repo.UpdateStatus(ctx, notification.ID, types.StatusFailed, err.Error())
        w.metrics.IncrementFailed(w.sender.Channel())
    } else {
        w.repo.UpdateStatus(ctx, notification.ID, types.StatusDelivered, "")
        w.metrics.IncrementDelivered(w.sender.Channel())
    }

    // Commit message
    w.reader.CommitMessages(ctx, msg)
}

func (w *NotificationWorker) renderContent(n *types.Notification) (*RenderedContent, error) {
    // Use template engine to render content
    // Implementation depends on your template system
    return &RenderedContent{
        Subject: "Notification",
        Body:    "Your notification content",
    }, nil
}

// Stop gracefully stops the worker
func (w *NotificationWorker) Stop() {
    close(w.stopCh)
    w.wg.Wait()
    w.reader.Close()
}

func getHeader(headers []kafka.Header, key string) string {
    for _, h := range headers {
        if h.Key == key {
            return string(h.Value)
        }
    }
    return ""
}
```

### Email Sender

The `EmailSender` implements the `NotificationSender` interface for the email channel, delegating delivery to the SendGrid API. Before constructing the message, it resolves the recipient's address from the user repository and rejects the notification early if no email is on record. Custom headers carrying the notification ID and type are attached to every outbound message so that open and click events reported by SendGrid webhooks can be correlated back to the originating notification record.

```go
// sender/email_sender.go
package sender

import (
    "context"
    "fmt"

    "github.com/sendgrid/sendgrid-go"
    "github.com/sendgrid/sendgrid-go/helpers/mail"
    "yourproject/types"
    "yourproject/worker"
)

// EmailSender sends email notifications
type EmailSender struct {
    client     *sendgrid.Client
    fromEmail  string
    fromName   string
    userRepo   UserRepository
}

// NewEmailSender creates a new email sender
func NewEmailSender(apiKey, fromEmail, fromName string, userRepo UserRepository) *EmailSender {
    return &EmailSender{
        client:    sendgrid.NewSendClient(apiKey),
        fromEmail: fromEmail,
        fromName:  fromName,
        userRepo:  userRepo,
    }
}

// Channel returns the channel type
func (e *EmailSender) Channel() types.Channel {
    return types.ChannelEmail
}

// Send sends an email notification
func (e *EmailSender) Send(ctx context.Context, notification *types.Notification, content *worker.RenderedContent) error {
    // Get user email
    user, err := e.userRepo.GetUser(ctx, notification.UserID)
    if err != nil {
        return fmt.Errorf("get user: %w", err)
    }

    if user.Email == "" {
        return fmt.Errorf("user has no email address")
    }

    // Build email
    from := mail.NewEmail(e.fromName, e.fromEmail)
    to := mail.NewEmail(user.Name, user.Email)

    message := mail.NewSingleEmail(from, content.Subject, to, content.Body, content.HTML)

    // Add tracking
    message.SetClickTracking(true)
    message.SetOpenTracking(true)

    // Add custom headers for tracking
    message.Headers = map[string]string{
        "X-Notification-ID": notification.ID,
        "X-Notification-Type": notification.Type,
    }

    // Send
    response, err := e.client.Send(message)
    if err != nil {
        return fmt.Errorf("send email: %w", err)
    }

    if response.StatusCode >= 400 {
        return fmt.Errorf("sendgrid error: %d - %s", response.StatusCode, response.Body)
    }

    return nil
}
```

### SMS Sender

The `SMSSender` uses the Twilio REST client to deliver SMS messages, looking up the recipient's phone number from the user repository before dispatching. Because SMS messages are limited to 160 characters, the sender truncates any longer body with an ellipsis rather than silently dropping content. A `StatusCallback` URL is included in the Twilio request so that delivery receipts are posted back to the system, enabling the notification status to be updated asynchronously without polling the Twilio API.

```go
// sender/sms_sender.go
package sender

import (
    "context"
    "fmt"
    "unicode/utf8"

    "github.com/twilio/twilio-go"
    openapi "github.com/twilio/twilio-go/rest/api/v2010"
    "yourproject/types"
    "yourproject/worker"
)

// SMSSender sends SMS notifications
type SMSSender struct {
    client     *twilio.RestClient
    fromNumber string
    userRepo   UserRepository
}

// NewSMSSender creates a new SMS sender
func NewSMSSender(accountSID, authToken, fromNumber string, userRepo UserRepository) *SMSSender {
    client := twilio.NewRestClientWithParams(twilio.ClientParams{
        Username: accountSID,
        Password: authToken,
    })

    return &SMSSender{
        client:     client,
        fromNumber: fromNumber,
        userRepo:   userRepo,
    }
}

// Channel returns the channel type
func (s *SMSSender) Channel() types.Channel {
    return types.ChannelSMS
}

// Send sends an SMS notification
func (s *SMSSender) Send(ctx context.Context, notification *types.Notification, content *worker.RenderedContent) error {
    // Get user phone
    user, err := s.userRepo.GetUser(ctx, notification.UserID)
    if err != nil {
        return fmt.Errorf("get user: %w", err)
    }

    if user.Phone == "" {
        return fmt.Errorf("user has no phone number")
    }

    // Truncate body for SMS. Slice runes, not bytes: a byte slice
    // can cut a multibyte character in half and produce invalid UTF-8.
    body := content.Body
    if utf8.RuneCountInString(body) > 160 {
        runes := []rune(body)
        body = string(runes[:157]) + "..."
    }

    // Send SMS
    params := &openapi.CreateMessageParams{}
    params.SetTo(user.Phone)
    params.SetFrom(s.fromNumber)
    params.SetBody(body)

    // Add status callback URL for tracking
    params.SetStatusCallback(fmt.Sprintf("https://api.example.com/webhooks/sms/status?id=%s", notification.ID))

    _, err = s.client.Api.CreateMessage(params)
    if err != nil {
        return fmt.Errorf("send sms: %w", err)
    }

    return nil
}
```

### Push Notification Sender

The `PushSender` uses Firebase Cloud Messaging (FCM) to fan a single notification out to all of a user's registered device tokens in one multicast call. Both Android and APNs platform-specific configs are populated to control priority and sound behavior on each OS. After the multicast response is received, any token that FCM reports as unregistered is immediately removed from the user's device token list, keeping the token registry clean and preventing wasteful retries against stale registrations.

```go
// sender/push_sender.go
package sender

import (
    "context"
    "fmt"

    firebase "firebase.google.com/go/v4"
    "firebase.google.com/go/v4/messaging"
    "yourproject/types"
    "yourproject/worker"
)

// PushSender sends push notifications via FCM
type PushSender struct {
    client   *messaging.Client
    userRepo UserRepository
}

// NewPushSender creates a new push notification sender
func NewPushSender(app *firebase.App, userRepo UserRepository) (*PushSender, error) {
    ctx := context.Background()
    client, err := app.Messaging(ctx)
    if err != nil {
        return nil, err
    }

    return &PushSender{
        client:   client,
        userRepo: userRepo,
    }, nil
}

// Channel returns the channel type
func (p *PushSender) Channel() types.Channel {
    return types.ChannelPush
}

// Send sends a push notification
func (p *PushSender) Send(ctx context.Context, notification *types.Notification, content *worker.RenderedContent) error {
    // Get user device tokens
    tokens, err := p.userRepo.GetDeviceTokens(ctx, notification.UserID)
    if err != nil {
        return fmt.Errorf("get device tokens: %w", err)
    }

    if len(tokens) == 0 {
        return fmt.Errorf("user has no device tokens")
    }

    // Build message
    message := &messaging.MulticastMessage{
        Tokens: tokens,
        Notification: &messaging.Notification{
            Title: content.Subject,
            Body:  content.Body,
        },
        Data: map[string]string{
            "notification_id":   notification.ID,
            "notification_type": notification.Type,
        },
        Android: &messaging.AndroidConfig{
            Priority: "high",
            Notification: &messaging.AndroidNotification{
                ClickAction: "OPEN_NOTIFICATION",
            },
        },
        APNS: &messaging.APNSConfig{
            Payload: &messaging.APNSPayload{
                Aps: &messaging.Aps{
                    Sound: "default",
                    Badge: &[]int{1}[0],
                },
            },
        },
    }

    // Send to all devices. SendEachForMulticast issues one HTTP/2
    // request per token, the older SendMulticast relied on FCM's batch
    // endpoint, which Google discontinued in June 2024.
    response, err := p.client.SendEachForMulticast(ctx, message)
    if err != nil {
        return fmt.Errorf("send push: %w", err)
    }

    // Check for failures
    if response.FailureCount > 0 {
        // Handle failed tokens (remove stale tokens)
        for i, resp := range response.Responses {
            if !resp.Success {
                if messaging.IsUnregistered(resp.Error) {
                    // Remove invalid token
                    p.userRepo.RemoveDeviceToken(ctx, notification.UserID, tokens[i])
                }
            }
        }
    }

    if response.SuccessCount == 0 {
        return fmt.Errorf("all push notifications failed")
    }

    return nil
}
```

### Junior -> FAANG: Worker Pool Patterns and Graceful Shutdown

The base worker implementation introduces three patterns that appear throughout production Go services: the worker pool (a fixed number of goroutines draining a shared job channel), the filter-by-header pattern (reading a Kafka message but skipping it if it belongs to a different channel), and graceful shutdown via a `stopCh` channel plus `sync.WaitGroup`.

The filter-by-header approach in the worker deserves scrutiny in an interview. The worker reads a message from the queue, checks the channel header, and commits it if it does not match. This works but is wasteful: every email worker also reads and discards SMS and push messages. The better design uses separate Kafka topics per channel (not just per priority), so each worker pool only consumes messages meant for it. Bringing this up unprompted in an interview shows that you can identify implicit inefficiencies in existing designs.

The exponential retrier is a first-job essential. Never retry with a fixed sleep: it creates synchronized retry storms where all failed workers sleep for exactly one second and then simultaneously hammer the provider. Exponential backoff with jitter (the "full jitter" algorithm from the AWS architecture blog) distributes retries over time. Know the formula: `sleep = random_between(0, min(max_backoff, base * 2^attempt))`.

For the `EmailSender`: the `X-Notification-ID` and `X-Notification-Type` custom headers are the bridge between outbound send and inbound webhook. Without them, the SendGrid delivery webhook has no way to correlate an event back to the originating notification. This is a detail that junior candidates often miss and senior candidates consider mandatory.

### Senior @ FAANG: Worker Fleet Sizing, Circuit Breakers, and Provider Abstraction

**Worker fleet sizing is a capacity planning exercise**

The `concurrency` parameter passed to `NewNotificationWorker` is not arbitrary. For an email worker using SendGrid, the right concurrency is bounded by SendGrid's rate limit on your plan (e.g., 600 requests/minute per IP = 10/second), your average email send latency (roughly 200-500ms per call), and your target throughput. At 500ms average latency, a single goroutine delivers 2 emails/second. To reach 100 emails/second per worker process, you need 50 concurrent goroutines. Getting to this number from first principles during an interview signals production-level capacity thinking.

**Circuit breakers belong in the base worker**

The current implementation retries three times without a circuit breaker. At scale, if SendGrid's API is returning 500s, every notification worker will exhaust its three retries, commit the message as failed, and the failure rate metric will spike. A circuit breaker (using a library like `sony/gobreaker` or a custom half-open state machine) opens after N consecutive failures and short-circuits all subsequent attempts for a configurable window, allowing the provider time to recover without consuming worker goroutines on futile retries.

The circuit breaker open state must distinguish between failing fast (return error immediately, let the message be requeued) and blocking (hold the goroutine until the breaker closes). For notification workers, failing fast is correct: return the message to the queue for later processing rather than holding a goroutine that could be processing other messages.

**Provider abstraction as a scaling strategy**

The `NotificationSender` interface is the boundary between the generic worker lifecycle (dequeue, render, retry, track) and the provider-specific delivery logic. This abstraction enables multi-provider failover at the worker level: the worker can hold a `[]NotificationSender` and try providers in order until one succeeds. The `EmailSender` for SendGrid and an `EmailSender` for AWS SES implement the same interface, so switching providers requires no changes to the worker infrastructure. Explaining this design choice in an interview demonstrates interface-segregation thinking applied to a concrete production scenario.

**The commit-after-process ordering is a correctness guarantee**

The pattern of processing the message before calling `CommitMessages` is a correctness guarantee, not a performance optimization. Kafka's consumer group offset is only advanced after the message is committed. If the process crashes between processing and committing, the message is redelivered on restart. This is the at-least-once delivery guarantee. The trade-off is that a crash after processing but before committing causes duplicate processing, which is why idempotency at the delivery layer (storing the notification ID in Redis before sending) is essential. Senior candidates can explain this whole chain without being prompted.

---
