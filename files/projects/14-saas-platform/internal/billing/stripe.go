// internal/billing/stripe.go
package billing

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/example/saas-platform/pkg/logger"
	"github.com/google/uuid"
	"github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/customer"
	"github.com/stripe/stripe-go/v76/subscription"
	"github.com/stripe/stripe-go/v76/webhook"
)

// StripeService handles Stripe billing operations
type StripeService struct {
	subscriptionRepo SubscriptionRepository
	invoiceRepo      InvoiceRepository
	tenantRepo       TenantRepository
	webhookSecret    string
	logger           logger.Logger
}

func NewStripeService(
	subscriptionRepo SubscriptionRepository,
	invoiceRepo InvoiceRepository,
	tenantRepo TenantRepository,
	apiKey string,
	webhookSecret string,
	logger logger.Logger,
) *StripeService {
	stripe.Key = apiKey

	return &StripeService{
		subscriptionRepo: subscriptionRepo,
		invoiceRepo:      invoiceRepo,
		tenantRepo:       tenantRepo,
		webhookSecret:    webhookSecret,
		logger:           logger,
	}
}

// CreateCustomer creates a Stripe customer for a tenant
func (s *StripeService) CreateCustomer(ctx context.Context, tenantID uuid.UUID) (*stripe.Customer, error) {
	t, err := s.tenantRepo.GetByID(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	params := &stripe.CustomerParams{
		Email: new(t.BillingEmail),
		Name:  new(t.Name),
		Metadata: map[string]string{
			"tenant_id": tenantID.String(),
		},
	}

	cust, err := customer.New(params)
	if err != nil {
		return nil, fmt.Errorf("failed to create Stripe customer: %w", err)
	}

	s.logger.Info("created Stripe customer", "customer_id", cust.ID, "tenant_id", tenantID)

	return cust, nil
}

// CreateSubscription creates a Stripe subscription for a tenant
func (s *StripeService) CreateSubscription(ctx context.Context, req *CreateSubscriptionRequest) (*Subscription, error) {
	// Get or create Stripe customer
	var customerID string
	if req.CustomerID != "" {
		customerID = req.CustomerID
	} else {
		cust, err := s.CreateCustomer(ctx, req.TenantID)
		if err != nil {
			return nil, err
		}
		customerID = cust.ID
	}

	// Get plan details
	plan, err := s.tenantRepo.GetPlanByID(ctx, req.PlanID)
	if err != nil {
		return nil, err
	}

	// Determine price ID based on billing interval
	var priceID string
	if req.BillingInterval == BillingIntervalYearly {
		priceID = plan.StripePriceIDYr
	} else {
		priceID = plan.StripePriceIDMo
	}

	// Create Stripe subscription
	params := &stripe.SubscriptionParams{
		Customer: new(customerID),
		Items: []*stripe.SubscriptionItemsParams{
			{
				Price: new(priceID),
			},
		},
		Metadata: map[string]string{
			"tenant_id": req.TenantID.String(),
			"plan_id":   req.PlanID.String(),
		},
	}

	// Add trial period if applicable
	if req.TrialDays > 0 {
		params.TrialPeriodDays = new(int64(req.TrialDays))
	}

	// Add default payment method if provided
	if req.PaymentMethodID != "" {
		params.DefaultPaymentMethod = new(req.PaymentMethodID)
	}

	stripeSub, err := subscription.New(params)
	if err != nil {
		return nil, fmt.Errorf("failed to create Stripe subscription: %w", err)
	}

	// Create local subscription record
	sub := &Subscription{
		ID:                   uuid.New(),
		TenantID:             req.TenantID,
		PlanID:               req.PlanID,
		Status:               mapStripeStatus(stripeSub.Status),
		BillingInterval:      req.BillingInterval,
		StripeCustomerID:     customerID,
		StripeSubscriptionID: stripeSub.ID,
		CurrentPeriodStart:   time.Unix(stripeSub.CurrentPeriodStart, 0),
		CurrentPeriodEnd:     time.Unix(stripeSub.CurrentPeriodEnd, 0),
		Amount:               stripeSub.Items.Data[0].Price.UnitAmount,
		Currency:             string(stripeSub.Currency),
		CreatedAt:            time.Now().UTC(),
		UpdatedAt:            time.Now().UTC(),
	}

	if stripeSub.TrialStart != 0 {
		trialStart := time.Unix(stripeSub.TrialStart, 0)
		sub.TrialStart = &trialStart
	}

	if stripeSub.TrialEnd != 0 {
		trialEnd := time.Unix(stripeSub.TrialEnd, 0)
		sub.TrialEnd = &trialEnd
	}

	if err := s.subscriptionRepo.Create(ctx, sub); err != nil {
		return nil, fmt.Errorf("failed to create subscription record: %w", err)
	}

	s.logger.Info("created subscription", "subscription_id", sub.ID, "tenant_id", req.TenantID)

	return sub, nil
}

type CreateSubscriptionRequest struct {
	TenantID        uuid.UUID
	PlanID          uuid.UUID
	BillingInterval BillingInterval
	CustomerID      string
	PaymentMethodID string
	TrialDays       int
}

// UpdateSubscription updates a subscription (upgrade/downgrade)
func (s *StripeService) UpdateSubscription(ctx context.Context, subscriptionID uuid.UUID, newPlanID uuid.UUID) error {
	sub, err := s.subscriptionRepo.GetByID(ctx, subscriptionID)
	if err != nil {
		return err
	}

	newPlan, err := s.tenantRepo.GetPlanByID(ctx, newPlanID)
	if err != nil {
		return err
	}

	// Determine new price ID
	var priceID string
	if sub.BillingInterval == BillingIntervalYearly {
		priceID = newPlan.StripePriceIDYr
	} else {
		priceID = newPlan.StripePriceIDMo
	}

	// Get current Stripe subscription
	stripeSub, err := subscription.Get(sub.StripeSubscriptionID, nil)
	if err != nil {
		return fmt.Errorf("failed to get Stripe subscription: %w", err)
	}

	// Update subscription in Stripe
	params := &stripe.SubscriptionParams{
		Items: []*stripe.SubscriptionItemsParams{
			{
				ID:    new(stripeSub.Items.Data[0].ID),
				Price: new(priceID),
			},
		},
		ProrationBehavior: new("create_prorations"),
	}

	stripeSub, err = subscription.Update(sub.StripeSubscriptionID, params)
	if err != nil {
		return fmt.Errorf("failed to update Stripe subscription: %w", err)
	}

	// Update local record
	sub.PlanID = newPlanID
	sub.Amount = stripeSub.Items.Data[0].Price.UnitAmount
	sub.UpdatedAt = time.Now().UTC()

	if err := s.subscriptionRepo.Update(ctx, sub); err != nil {
		return err
	}

	s.logger.Info("updated subscription", "subscription_id", subscriptionID, "new_plan_id", newPlanID)

	return nil
}

// CancelSubscription cancels a subscription
func (s *StripeService) CancelSubscription(ctx context.Context, subscriptionID uuid.UUID, immediately bool) error {
	sub, err := s.subscriptionRepo.GetByID(ctx, subscriptionID)
	if err != nil {
		return err
	}

	params := &stripe.SubscriptionParams{
		CancelAtPeriodEnd: new(!immediately),
	}

	if immediately {
		params.CancelAt = new(time.Now().Unix())
	}

	_, err = subscription.Update(sub.StripeSubscriptionID, params)
	if err != nil {
		return fmt.Errorf("failed to cancel Stripe subscription: %w", err)
	}

	// Update local record
	if immediately {
		now := time.Now().UTC()
		sub.CanceledAt = &now
		sub.Status = SubscriptionStatusCanceled
	} else {
		sub.CancelAtPeriodEnd = true
	}
	sub.UpdatedAt = time.Now().UTC()

	if err := s.subscriptionRepo.Update(ctx, sub); err != nil {
		return err
	}

	s.logger.Info("canceled subscription", "subscription_id", subscriptionID, "immediately", immediately)

	return nil
}

// HandleWebhook processes Stripe webhooks
func (s *StripeService) HandleWebhook(ctx context.Context, payload []byte, signature string) error {
	event, err := webhook.ConstructEvent(payload, signature, s.webhookSecret)
	if err != nil {
		return fmt.Errorf("failed to verify webhook signature: %w", err)
	}

	s.logger.Info("received Stripe webhook", "type", event.Type)

	switch event.Type {
	case "customer.subscription.created":
		return s.handleSubscriptionCreated(ctx, event)
	case "customer.subscription.updated":
		return s.handleSubscriptionUpdated(ctx, event)
	case "customer.subscription.deleted":
		return s.handleSubscriptionDeleted(ctx, event)
	case "invoice.payment_succeeded":
		return s.handleInvoicePaymentSucceeded(ctx, event)
	case "invoice.payment_failed":
		return s.handleInvoicePaymentFailed(ctx, event)
	case "customer.subscription.trial_will_end":
		return s.handleTrialWillEnd(ctx, event)
	default:
		s.logger.Debug("unhandled webhook event", "type", event.Type)
	}

	return nil
}

func (s *StripeService) handleSubscriptionCreated(ctx context.Context, event stripe.Event) error {
	var stripeSub stripe.Subscription
	if err := json.Unmarshal(event.Data.Raw, &stripeSub); err != nil {
		return err
	}

	if _, parseErr := uuid.Parse(stripeSub.Metadata["tenant_id"]); parseErr != nil {
		return fmt.Errorf("invalid tenant_id in metadata")
	}

	// Subscription should already exist from CreateSubscription
	// Update with any missing info
	sub, err := s.subscriptionRepo.GetByStripeID(ctx, stripeSub.ID)
	if err != nil {
		s.logger.Warn("subscription not found for webhook", "stripe_id", stripeSub.ID)
		return nil
	}

	sub.Status = mapStripeStatus(stripeSub.Status)
	sub.UpdatedAt = time.Now().UTC()

	return s.subscriptionRepo.Update(ctx, sub)
}

func (s *StripeService) handleSubscriptionUpdated(ctx context.Context, event stripe.Event) error {
	var stripeSub stripe.Subscription
	if err := json.Unmarshal(event.Data.Raw, &stripeSub); err != nil {
		return err
	}

	sub, err := s.subscriptionRepo.GetByStripeID(ctx, stripeSub.ID)
	if err != nil {
		return err
	}

	sub.Status = mapStripeStatus(stripeSub.Status)
	sub.CurrentPeriodStart = time.Unix(stripeSub.CurrentPeriodStart, 0)
	sub.CurrentPeriodEnd = time.Unix(stripeSub.CurrentPeriodEnd, 0)
	sub.UpdatedAt = time.Now().UTC()

	if stripeSub.CancelAtPeriodEnd {
		sub.CancelAtPeriodEnd = true
	}

	return s.subscriptionRepo.Update(ctx, sub)
}

func (s *StripeService) handleSubscriptionDeleted(ctx context.Context, event stripe.Event) error {
	var stripeSub stripe.Subscription
	if err := json.Unmarshal(event.Data.Raw, &stripeSub); err != nil {
		return err
	}

	sub, err := s.subscriptionRepo.GetByStripeID(ctx, stripeSub.ID)
	if err != nil {
		return err
	}

	sub.Status = SubscriptionStatusCanceled
	now := time.Now().UTC()
	sub.CanceledAt = &now
	sub.UpdatedAt = now

	return s.subscriptionRepo.Update(ctx, sub)
}

func (s *StripeService) handleInvoicePaymentSucceeded(ctx context.Context, event stripe.Event) error {
	var stripeInvoice stripe.Invoice
	if err := json.Unmarshal(event.Data.Raw, &stripeInvoice); err != nil {
		return err
	}

	// Create or update invoice record
	invoice, err := s.invoiceRepo.GetByStripeID(ctx, stripeInvoice.ID)
	if err != nil {
		// Create new invoice
		tenantID, _ := uuid.Parse(stripeInvoice.Subscription.Metadata["tenant_id"])

		invoice = &Invoice{
			ID:               uuid.New(),
			TenantID:         tenantID,
			StripeInvoiceID:  stripeInvoice.ID,
			InvoiceNumber:    stripeInvoice.Number,
			Status:           InvoiceStatusPaid,
			Subtotal:         stripeInvoice.Subtotal,
			Tax:              stripeInvoice.Tax,
			Total:            stripeInvoice.Total,
			AmountDue:        stripeInvoice.AmountDue,
			AmountPaid:       stripeInvoice.AmountPaid,
			Currency:         string(stripeInvoice.Currency),
			PeriodStart:      time.Unix(stripeInvoice.PeriodStart, 0),
			PeriodEnd:        time.Unix(stripeInvoice.PeriodEnd, 0),
			DueDate:          time.Unix(stripeInvoice.DueDate, 0),
			InvoicePDF:       &stripeInvoice.InvoicePDF,
			HostedInvoiceURL: &stripeInvoice.HostedInvoiceURL,
			CreatedAt:        time.Now().UTC(),
			UpdatedAt:        time.Now().UTC(),
		}

		if stripeInvoice.StatusTransitions.PaidAt != 0 {
			paidAt := time.Unix(stripeInvoice.StatusTransitions.PaidAt, 0)
			invoice.PaidAt = &paidAt
		}

		return s.invoiceRepo.Create(ctx, invoice)
	}

	// Update existing invoice
	invoice.Status = InvoiceStatusPaid
	invoice.AmountPaid = stripeInvoice.AmountPaid
	now := time.Now().UTC()
	invoice.PaidAt = &now
	invoice.UpdatedAt = now

	return s.invoiceRepo.Update(ctx, invoice)
}

func (s *StripeService) handleInvoicePaymentFailed(ctx context.Context, event stripe.Event) error {
	var stripeInvoice stripe.Invoice
	if err := json.Unmarshal(event.Data.Raw, &stripeInvoice); err != nil {
		return err
	}

	// Update subscription status to past_due
	if stripeInvoice.Subscription != nil {
		sub, err := s.subscriptionRepo.GetByStripeID(ctx, stripeInvoice.Subscription.ID)
		if err != nil {
			return err
		}

		sub.Status = SubscriptionStatusPastDue
		sub.UpdatedAt = time.Now().UTC()

		if err := s.subscriptionRepo.Update(ctx, sub); err != nil {
			return err
		}

		// Send notification to tenant
		s.logger.Warn("payment failed", "tenant_id", sub.TenantID, "invoice_id", stripeInvoice.ID)
	}

	return nil
}

func (s *StripeService) handleTrialWillEnd(ctx context.Context, event stripe.Event) error {
	var stripeSub stripe.Subscription
	if err := json.Unmarshal(event.Data.Raw, &stripeSub); err != nil {
		return err
	}

	tenantID, err := uuid.Parse(stripeSub.Metadata["tenant_id"])
	if err != nil {
		return err
	}

	// Send notification to tenant about trial ending
	s.logger.Info("trial ending soon", "tenant_id", tenantID, "trial_end", time.Unix(stripeSub.TrialEnd, 0))

	return nil
}

func mapStripeStatus(status stripe.SubscriptionStatus) SubscriptionStatus {
	switch status {
	case stripe.SubscriptionStatusTrialing:
		return SubscriptionStatusTrialing
	case stripe.SubscriptionStatusActive:
		return SubscriptionStatusActive
	case stripe.SubscriptionStatusPastDue:
		return SubscriptionStatusPastDue
	case stripe.SubscriptionStatusCanceled:
		return SubscriptionStatusCanceled
	case stripe.SubscriptionStatusUnpaid:
		return SubscriptionStatusUnpaid
	default:
		return SubscriptionStatusActive
	}
}
