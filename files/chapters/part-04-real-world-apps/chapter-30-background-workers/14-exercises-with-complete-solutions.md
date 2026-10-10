## Exercises with Complete Solutions

### Exercise 1: Build an Email Queue with Rate Limiting

Create an email queue that:
- Respects provider rate limits (e.g., 100 emails/minute)
- Handles bounces and tracks delivery status
- Supports templates

**Complete Solution:**

```go
// internal/email/queue.go
package email

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/time/rate"
)

type EmailJob struct {
	ID           uuid.UUID   `json:"id"`
	To           []string    `json:"to"`
	CC           []string    `json:"cc,omitempty"`
	BCC          []string    `json:"bcc,omitempty"`
	Subject      string      `json:"subject"`
	TemplateName string      `json:"template_name,omitempty"`
	TemplateData any `json:"template_data,omitempty"`
	PlainText    string      `json:"plain_text,omitempty"`
	HTML         string      `json:"html,omitempty"`
	Priority     int         `json:"priority"`
	CreatedAt    time.Time   `json:"created_at"`
}

type DeliveryStatus string

const (
	StatusQueued    DeliveryStatus = "queued"
	StatusSent      DeliveryStatus = "sent"
	StatusDelivered DeliveryStatus = "delivered"
	StatusBounced   DeliveryStatus = "bounced"
	StatusFailed    DeliveryStatus = "failed"
)

type EmailDelivery struct {
	ID        uuid.UUID      `json:"id"`
	JobID     uuid.UUID      `json:"job_id"`
	Recipient string         `json:"recipient"`
	Status    DeliveryStatus `json:"status"`
	MessageID string         `json:"message_id,omitempty"`
	Error     string         `json:"error,omitempty"`
	SentAt    *time.Time     `json:"sent_at,omitempty"`
	UpdatedAt time.Time      `json:"updated_at"`
}

type EmailService struct {
	queue          Queue
	templateEngine *TemplateEngine
	sender         EmailSender
	rateLimiter    *rate.Limiter
	deliveryStore  DeliveryStore

	mu             sync.RWMutex
	workerCount    int
}

type EmailSender interface {
	Send(ctx context.Context, email *Email) (messageID string, err error)
}

func NewEmailService(
	queue Queue,
	sender EmailSender,
	ratePerMinute int,
) *EmailService {
	// Rate limiter: ratePerMinute emails per minute
	limiter := rate.NewLimiter(rate.Limit(float64(ratePerMinute)/60), 1)

	return &EmailService{
		queue:          queue,
		sender:         sender,
		rateLimiter:    limiter,
		templateEngine: NewTemplateEngine(),
		workerCount:    5,
	}
}

func (s *EmailService) Enqueue(ctx context.Context, job *EmailJob) error {
	if job.ID == uuid.Nil {
		job.ID = uuid.New()
	}
	job.CreatedAt = time.Now()

	// Create delivery records for tracking
	for _, recipient := range append(job.To, append(job.CC, job.BCC...)...) {
		delivery := &EmailDelivery{
			ID:        uuid.New(),
			JobID:     job.ID,
			Recipient: recipient,
			Status:    StatusQueued,
			UpdatedAt: time.Now(),
		}
		s.deliveryStore.Save(ctx, delivery)
	}

	queueJob, err := queue.NewJob("emails", "send_email", job,
		queue.WithPriority(job.Priority),
	)
	if err != nil {
		return err
	}

	return s.queue.Enqueue(ctx, queueJob)
}

func (s *EmailService) ProcessJob(ctx context.Context, job *queue.Job) error {
	var emailJob EmailJob
	if err := json.Unmarshal(job.Payload, &emailJob); err != nil {
		return fmt.Errorf("invalid email job payload: %w", err)
	}

	// Wait for rate limiter
	if err := s.rateLimiter.Wait(ctx); err != nil {
		return err
	}

	// Render template if specified
	var htmlBody, textBody string
	if emailJob.TemplateName != "" {
		var err error
		htmlBody, textBody, err = s.templateEngine.Render(
			emailJob.TemplateName,
			emailJob.TemplateData,
		)
		if err != nil {
			return fmt.Errorf("template render error: %w", err)
		}
	} else {
		htmlBody = emailJob.HTML
		textBody = emailJob.PlainText
	}

	// Send to each recipient
	allRecipients := append(emailJob.To, append(emailJob.CC, emailJob.BCC...)...)

	for _, recipient := range allRecipients {
		email := &Email{
			To:        recipient,
			Subject:   emailJob.Subject,
			HTML:      htmlBody,
			PlainText: textBody,
		}

		// Wait for rate limiter before each send
		if err := s.rateLimiter.Wait(ctx); err != nil {
			return err
		}

		messageID, err := s.sender.Send(ctx, email)

		// Update delivery status
		delivery, _ := s.deliveryStore.GetByJobAndRecipient(ctx, emailJob.ID, recipient)
		now := time.Now()

		if err != nil {
			delivery.Status = StatusFailed
			delivery.Error = err.Error()
		} else {
			delivery.Status = StatusSent
			delivery.MessageID = messageID
			delivery.SentAt = &now
		}
		delivery.UpdatedAt = now
		s.deliveryStore.Save(ctx, delivery)

		if err != nil {
			// Log but continue with other recipients
			continue
		}
	}

	return nil
}

// Template engine for email templates
type TemplateEngine struct {
	templates map[string]*Template
}

type Template struct {
	HTMLTemplate *template.Template
	TextTemplate *template.Template
}

func (e *TemplateEngine) Render(name string, data any) (html, text string, err error) {
	tmpl, ok := e.templates[name]
	if !ok {
		return "", "", fmt.Errorf("template not found: %s", name)
	}

	var htmlBuf, textBuf bytes.Buffer

	if err := tmpl.HTMLTemplate.Execute(&htmlBuf, data); err != nil {
		return "", "", err
	}
	if err := tmpl.TextTemplate.Execute(&textBuf, data); err != nil {
		return "", "", err
	}

	return htmlBuf.String(), textBuf.String(), nil
}

// Bounce handling webhook
func (s *EmailService) HandleBounce(ctx context.Context, bounceEvent BounceEvent) error {
	delivery, err := s.deliveryStore.GetByMessageID(ctx, bounceEvent.MessageID)
	if err != nil {
		return err
	}

	delivery.Status = StatusBounced
	delivery.Error = bounceEvent.Reason
	delivery.UpdatedAt = time.Now()

	return s.deliveryStore.Save(ctx, delivery)
}

// Stats
func (s *EmailService) GetStats(ctx context.Context) (*EmailStats, error) {
	return s.deliveryStore.GetStats(ctx)
}

type EmailStats struct {
	TotalSent      int64 `json:"total_sent"`
	TotalDelivered int64 `json:"total_delivered"`
	TotalBounced   int64 `json:"total_bounced"`
	TotalFailed    int64 `json:"total_failed"`
	DeliveryRate   float64 `json:"delivery_rate"`
	BounceRate     float64 `json:"bounce_rate"`
}
```

### Exercise 2: Build a Scheduled Report Generator

Create a system that generates and delivers reports on a schedule.

**Complete Solution:**

```go
// internal/reports/generator.go
package reports

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type ReportType string

const (
	ReportTypeDaily   ReportType = "daily"
	ReportTypeWeekly  ReportType = "weekly"
	ReportTypeMonthly ReportType = "monthly"
	ReportTypeCustom  ReportType = "custom"
)

type ReportConfig struct {
	ID           uuid.UUID         `json:"id"`
	Name         string            `json:"name"`
	Type         ReportType        `json:"type"`
	Schedule     string            `json:"schedule"` // Cron expression
	Query        string            `json:"query"`
	Format       string            `json:"format"` // csv, xlsx, pdf
	Recipients   []string          `json:"recipients"`
	Parameters   map[string]string `json:"parameters"`
	Enabled      bool              `json:"enabled"`
	LastRunAt    *time.Time        `json:"last_run_at"`
	NextRunAt    *time.Time        `json:"next_run_at"`
	CreatedAt    time.Time         `json:"created_at"`
}

type ReportJob struct {
	ConfigID   uuid.UUID         `json:"config_id"`
	Parameters map[string]string `json:"parameters"`
	RequestedBy string           `json:"requested_by"`
}

type ReportResult struct {
	ID          uuid.UUID  `json:"id"`
	ConfigID    uuid.UUID  `json:"config_id"`
	Status      string     `json:"status"`
	FilePath    string     `json:"file_path,omitempty"`
	FileSize    int64      `json:"file_size,omitempty"`
	RowCount    int        `json:"row_count,omitempty"`
	Error       string     `json:"error,omitempty"`
	StartedAt   time.Time  `json:"started_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

type ReportService struct {
	queue         Queue
	configStore   ConfigStore
	resultStore   ResultStore
	dataSource    DataSource
	fileStorage   FileStorage
	emailService  *EmailService
	scheduler     *Scheduler
}

func NewReportService(
	queue Queue,
	dataSource DataSource,
	fileStorage FileStorage,
	emailService *EmailService,
) *ReportService {
	return &ReportService{
		queue:        queue,
		dataSource:   dataSource,
		fileStorage:  fileStorage,
		emailService: emailService,
	}
}

// Schedule reports based on their cron expressions
func (s *ReportService) StartScheduler(ctx context.Context) {
	s.scheduler = NewScheduler()

	// Load all enabled report configs
	configs, _ := s.configStore.ListEnabled(ctx)

	for _, config := range configs {
		cfg := config // capture
		s.scheduler.AddJob(cfg.ID.String(), cfg.Schedule, func(ctx context.Context) error {
			return s.EnqueueReport(ctx, cfg.ID, nil)
		})
	}

	go s.scheduler.Start(ctx)
}

func (s *ReportService) EnqueueReport(ctx context.Context, configID uuid.UUID, params map[string]string) error {
	config, err := s.configStore.Get(ctx, configID)
	if err != nil {
		return err
	}

	job := &ReportJob{
		ConfigID:   configID,
		Parameters: mergeParams(config.Parameters, params),
	}

	queueJob, err := queue.NewJob("reports", "generate_report", job,
		queue.WithPriority(1),
	)
	if err != nil {
		return err
	}

	return s.queue.Enqueue(ctx, queueJob)
}

func (s *ReportService) ProcessReport(ctx context.Context, job *queue.Job) error {
	var reportJob ReportJob
	if err := json.Unmarshal(job.Payload, &reportJob); err != nil {
		return err
	}

	config, err := s.configStore.Get(ctx, reportJob.ConfigID)
	if err != nil {
		return err
	}

	// Create result record
	result := &ReportResult{
		ID:        uuid.New(),
		ConfigID:  reportJob.ConfigID,
		Status:    "running",
		StartedAt: time.Now(),
	}
	s.resultStore.Save(ctx, result)

	// Execute query
	query := s.interpolateQuery(config.Query, reportJob.Parameters)
	data, err := s.dataSource.Query(ctx, query)
	if err != nil {
		result.Status = "failed"
		result.Error = err.Error()
		s.resultStore.Save(ctx, result)
		return err
	}

	// Generate report file
	filename := fmt.Sprintf("%s_%s.%s",
		config.Name,
		time.Now().Format("2006-01-02"),
		config.Format,
	)

	var fileData []byte
	switch config.Format {
	case "csv":
		fileData, err = s.generateCSV(data)
	case "xlsx":
		fileData, err = s.generateXLSX(data)
	case "pdf":
		fileData, err = s.generatePDF(data)
	default:
		err = fmt.Errorf("unsupported format: %s", config.Format)
	}

	if err != nil {
		result.Status = "failed"
		result.Error = err.Error()
		s.resultStore.Save(ctx, result)
		return err
	}

	// Upload to storage
	filePath, err := s.fileStorage.Upload(ctx, filename, fileData)
	if err != nil {
		result.Status = "failed"
		result.Error = err.Error()
		s.resultStore.Save(ctx, result)
		return err
	}

	// Update result
	now := time.Now()
	result.Status = "completed"
	result.FilePath = filePath
	result.FileSize = int64(len(fileData))
	result.RowCount = len(data)
	result.CompletedAt = &now
	s.resultStore.Save(ctx, result)

	// Send to recipients
	if len(config.Recipients) > 0 {
		downloadURL := s.fileStorage.GetSignedURL(ctx, filePath, 24*time.Hour)

		emailJob := &EmailJob{
			To:           config.Recipients,
			Subject:      fmt.Sprintf("Report: %s - %s", config.Name, time.Now().Format("2006-01-02")),
			TemplateName: "report_delivery",
			TemplateData: map[string]any{
				"report_name":  config.Name,
				"download_url": downloadURL,
				"row_count":    result.RowCount,
				"generated_at": result.CompletedAt,
			},
		}
		s.emailService.Enqueue(ctx, emailJob)
	}

	// Update last run time
	config.LastRunAt = &now
	s.configStore.Save(ctx, config)

	return nil
}

func (s *ReportService) generateCSV(data []map[string]any) ([]byte, error) {
	if len(data) == 0 {
		return nil, nil
	}

	var buf bytes.Buffer
	writer := csv.NewWriter(&buf)

	// Write header
	var headers []string
	for key := range data[0] {
		headers = append(headers, key)
	}
	slices.Sort(headers)
	writer.Write(headers)

	// Write data
	for _, row := range data {
		var values []string
		for _, h := range headers {
			values = append(values, fmt.Sprintf("%v", row[h]))
		}
		writer.Write(values)
	}

	writer.Flush()
	return buf.Bytes(), writer.Error()
}

func (s *ReportService) interpolateQuery(query string, params map[string]string) string {
	for key, value := range params {
		query = strings.ReplaceAll(query, "{{"+key+"}}", value)
	}

	// Handle date placeholders
	now := time.Now()
	query = strings.ReplaceAll(query, "{{today}}", now.Format("2006-01-02"))
	query = strings.ReplaceAll(query, "{{yesterday}}", now.AddDate(0, 0, -1).Format("2006-01-02"))
	query = strings.ReplaceAll(query, "{{last_week}}", now.AddDate(0, 0, -7).Format("2006-01-02"))
	query = strings.ReplaceAll(query, "{{last_month}}", now.AddDate(0, -1, 0).Format("2006-01-02"))

	return query
}
```

### Junior to FAANG: extending the exercises toward production

Both exercises look complete. Neither is production-ready. A junior working through them should attempt the following extensions.

**Exercise 1 extensions.**

1. Add an idempotency key to `EmailJob` derived from the business event (e.g. user_id plus template_name plus day-bucket) and record it in a `sent_emails` table with a unique constraint, so a retry that finds the key already present skips the send. Without this, retries send duplicates.
2. Separate validation errors (bad recipient format) from transient (provider 5xx). Validation failures go straight to DLQ.
3. Replace `s.rateLimiter.Wait(ctx)` with a token-bucket per-provider per-domain. Providers and recipient mail servers throttle by sending domain, so a single customer with thousands of recipients can starve others.
4. SQL injection in `interpolateQuery`. The snippet does `strings.ReplaceAll(query, "{{key}}", value)`. A parameter value like `'; DROP TABLE users; --` wins. Use parameterized queries. This is a security blocker.
5. Bounce handling must also update the user record to mark the address invalid, otherwise future emails keep bouncing.
6. Template engine has no fallback when a template is missing. Ship with a default "rendering failed" template and an alert.

**Exercise 2 extensions.**

1. Report generation reads rows into memory (`data []map[string]any`). For a 10M-row report, you OOM. Stream rows from the DB to a streaming CSV writer.
2. `s.fileStorage.Upload` accepts `[]byte`. Change to `io.Reader` for streaming uploads.
3. `config.LastRunAt = &now` writes without optimistic locking. Two concurrent runs of the same schedule overwrite each other. Add `version` column.
4. The scheduler is in-process. Multiple replicas run the same report. Add distributed leader election or per-schedule lock.
5. `GetSignedURL` duration is 24h but recipients may forward. Short-lived URLs (1h) plus a re-auth-required download flow for PII reports.
6. No cost limit. A report that scans 1B rows costs thousands of dollars. Add per-report cost ceiling (e.g. max_scan_bytes) and kill the query if it exceeds.

Walkthrough for a junior stretching into FAANG readiness. Pick exercise 1. Add idempotency. Add typed errors. Replace rate limiter with per-domain token bucket. Write load test that sends 10k emails in 10s. Observe metrics. Profile for bottlenecks. Document what you learned. This is a week of work and turns "I can code" into "I can ship".

Interview entry point. "Here is your email queue exercise. What would you change before production." A candidate who names idempotency, typed errors, SQL injection (if they read exercise 2), and per-domain rate limit is a strong hire.

### Senior at FAANG: turning exercises into platform offerings

A staff engineer at a FAANG would not let teams write email queues or report generators from scratch. Both are platform offerings. The exercise answers become ADRs for consolidation.

**Email as a platform service.** At Uber, Stripe, and Netflix, email delivery is a shared internal service, not a per-team queue. Why. (1) Email provider is centralized (one SendGrid account, one pool of reputation). (2) Compliance (CAN-SPAM, GDPR unsubscribe handling) is centralized. (3) Bounce processing requires a single webhook endpoint. (4) Rate limiting across providers must coordinate globally. (5) Template registry is centralized for brand compliance.

Platform design. Teams call `EmailService.Send(ctx, tenant, template, params)`. The service. (1) Validates tenant quota. (2) Renders template with tenant-specific branding. (3) Enqueues on the platform queue. (4) Workers respect per-provider rate limits and per-domain backoff. (5) Bounces are processed centrally and propagate to tenant-visible delivery status. (6) Unsubscribe suppression list is shared across tenants (with per-tenant overrides). SLO, 99.9% delivered within 5 minutes, tier-1. Platform charges tenants per-email.

**Reports as a platform service.** Analytics platforms at FAANG (Airflow, Looker, internal tools) handle report generation. Teams do not write custom report runners. They write SQL against a data warehouse, define schedule, define delivery. The platform handles. Capacity management (query concurrency limits), cost caps (max_scan_bytes), PII compliance (column-level access control), streaming output (never materialize 10M rows in memory), and distribution (email, Slack, S3, Snowflake share).

Staff-level decision for a team looking at exercise 2. Do not build. Adopt Airflow, dbt, or internal equivalent. Exception, if the report is tightly coupled to application state (not data warehouse), then a small report service makes sense but should still use the platform email service and platform file storage.

**Migration story from exercise-quality to platform-quality.** 18-month arc.

- Month 1 to 3. Inventory all team-owned email queues and report generators. Typically 10 to 30 per org.
- Month 4 to 6. Build platform email service with tier-1 SLO. Onboard 3 early-adopter teams.
- Month 7 to 9. Bounce handling, suppression list, template registry. Open to all tiers.
- Month 10 to 12. Deprecate team-owned email. Migrate top 10 by volume.
- Month 13 to 18. Long tail migration. Retire team queues.

Budget, 2 to 3 engineers full time for the duration. Savings, estimated 5 to 10 team-weeks per year per team (30 teams means 150 to 300 team-weeks annual savings). ROI positive in year 2.

**Compliance layer.** Email platforms must handle. GDPR data subject access (user can request all emails sent to them). CAN-SPAM unsubscribe (honored within 10 days, link in every marketing email). HIPAA (if healthcare data). Data residency (email content stored in region). These are not exercise-level concerns. They are the bulk of a platform team's year-2 work.

**Observability for platform email.** Per-tenant dashboards, per-template dashboards, per-provider dashboards. Three-dimensional views. Delivery rate by tenant, by template, by provider. Anomalies trigger investigation. Stripe publishes that they detect campaign-level deliverability issues within 30 minutes via automated anomaly detection on their email platform.

**ADR template, email consolidation.** Status, accepted. Context, 22 team-owned email queues, 3 SEVs in the last year due to inconsistent retry and missing idempotency. Decision, all email goes through platform service within 12 months. Consequences, consistent bounce handling, GDPR compliance, reduced SEV rate. Platform team adds 3 FTE. Team-level savings, 150 engineer-weeks per year.

---
