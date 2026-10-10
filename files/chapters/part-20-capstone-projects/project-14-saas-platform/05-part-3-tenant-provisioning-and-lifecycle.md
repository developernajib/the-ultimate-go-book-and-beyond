## Part 3: Tenant Provisioning and Lifecycle

When a new customer signs up for your SaaS platform, a lot needs to happen behind the scenes: creating the tenant record, setting up their database or schema, provisioning storage buckets, creating the initial admin user, and configuring billing. This process is called tenant provisioning, and it must be reliable, idempotent, and fast. This section covers the full tenant lifecycle from initial provisioning through onboarding, and eventually suspension or deletion.

### Tenant Provisioner
The provisioner orchestrates all the steps needed to set up a new tenant. It runs each step in order: creating the tenant record, setting up isolated database resources, configuring billing in Stripe, creating a storage bucket, and publishing events so other services can react. If any step fails, the provisioner rolls back the previous steps to avoid leaving the system in a half-configured state. This kind of careful orchestration is essential because a partially provisioned tenant leads to confusing errors and support tickets.

```go
// internal/tenant/provisioner.go
package tenant

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// ProvisionRequest contains all parameters required to set up a new tenant.
type ProvisionRequest struct {
	Name       string `json:"name"`
	Slug       string `json:"slug"`
	AdminEmail string `json:"admin_email"`
	AdminName  string `json:"admin_name"`
	PlanID     string `json:"plan_id"`
	Region     string `json:"region"`
}

// ProvisionResult captures identifiers created during provisioning.
type ProvisionResult struct {
	TenantID   uuid.UUID `json:"tenant_id"`
	AdminID    uuid.UUID `json:"admin_id"`
	BucketName string    `json:"bucket_name"`
	Database   string    `json:"database_name"`
	CreatedAt  time.Time `json:"created_at"`
}

// Provisioner orchestrates reliable multi-step tenant provisioning with rollback.
type Provisioner struct {
	tenants  Repository
	database DatabaseProvisioner
	storage  StorageProvisioner
	billing  BillingProvisioner
	events   EventPublisher
}

func NewProvisioner(
	tenants Repository,
	db DatabaseProvisioner,
	storage StorageProvisioner,
	billing BillingProvisioner,
	events EventPublisher,
) *Provisioner {
	return &Provisioner{
		tenants:  tenants,
		database: db,
		storage:  storage,
		billing:  billing,
		events:   events,
	}
}

// Provision executes the provisioning sequence and rolls back on failure.
func (p *Provisioner) Provision(ctx context.Context, req ProvisionRequest) (*ProvisionResult, error) {
	tenant := &Tenant{
		ID:        uuid.New(),
		Name:      req.Name,
		Slug:      req.Slug,
		PlanID:    req.PlanID,
		Status:    TenantStatusPending,
		CreatedAt: time.Now().UTC(),
	}

	if err := p.tenants.Create(ctx, tenant); err != nil {
		return nil, fmt.Errorf("failed to create tenant record: %w", err)
	}

	var rollbackStack []func(context.Context) error
	rollback := func() {
		for i := len(rollbackStack) - 1; i >= 0; i-- {
			_ = rollbackStack[i](ctx)
		}
		_ = p.tenants.UpdateStatus(ctx, tenant.ID, TenantStatusFailed)
	}

	// Step 1: Provision isolated database resources
	dbName, err := p.database.CreateSchema(ctx, tenant.ID)
	if err != nil {
		rollback()
		return nil, fmt.Errorf("database provisioning failed: %w", err)
	}
	rollbackStack = append(rollbackStack, func(ctx context.Context) error {
		return p.database.DropSchema(ctx, tenant.ID)
	})

	// Step 2: Configure storage bucket
	bucket, err := p.storage.CreateBucket(ctx, tenant.ID)
	if err != nil {
		rollback()
		return nil, fmt.Errorf("storage bucket creation failed: %w", err)
	}
	rollbackStack = append(rollbackStack, func(ctx context.Context) error {
		return p.storage.DeleteBucket(ctx, bucket)
	})

	// Step 3: Configure billing
	if err := p.billing.SetupCustomer(ctx, tenant.ID, req.AdminEmail, req.PlanID); err != nil {
		rollback()
		return nil, fmt.Errorf("billing setup failed: %w", err)
	}

	// Step 4: Publish provisioning event
	if err := p.events.Publish(ctx, "tenant.provisioned", tenant.ID); err != nil {
		rollback()
		return nil, fmt.Errorf("event publishing failed: %w", err)
	}

	_ = p.tenants.UpdateStatus(ctx, tenant.ID, TenantStatusActive)

	return &ProvisionResult{
		TenantID:   tenant.ID,
		BucketName: bucket,
		Database:   dbName,
		CreatedAt:  tenant.CreatedAt,
	}, nil
}
```

### Tenant Onboarding

After a tenant is provisioned, the onboarding process guides them through initial setup. This typically includes creating the first admin user, choosing a subscription plan, configuring basic settings, and optionally importing data from another system. The onboarding service tracks which steps have been completed so that users can resume where they left off if they close the browser. A smooth onboarding experience is critical for SaaS products because it directly affects whether new customers stick around or abandon the product.

```go
// internal/tenant/onboarding.go
package tenant

import (
    "context"
    "fmt"

    "github.com/google/uuid"
)

// OnboardingService handles tenant onboarding flow
type OnboardingService struct {
    tenantRepo    Repository
    userRepo      UserRepository
    stripeClient  *stripe.Client
    emailService  EmailService
    logger        logger.Logger
}

// OnboardingStep represents a step in the onboarding process
type OnboardingStep string

const (
    StepSetPassword      OnboardingStep = "set_password"
    StepVerifyEmail      OnboardingStep = "verify_email"
    StepSetupBilling     OnboardingStep = "setup_billing"
    StepCustomizeBranding OnboardingStep = "customize_branding"
    StepInviteTeam       OnboardingStep = "invite_team"
    StepComplete         OnboardingStep = "complete"
)

// OnboardingStatus tracks onboarding progress
type OnboardingStatus struct {
    TenantID        uuid.UUID                `json:"tenant_id"`
    CurrentStep     OnboardingStep           `json:"current_step"`
    CompletedSteps  []OnboardingStep         `json:"completed_steps"`
    IsComplete      bool                     `json:"is_complete"`
    StepData        map[string]any   `json:"step_data"`
}

// CompleteSetup finalizes tenant setup from onboarding token
func (s *OnboardingService) CompleteSetup(ctx context.Context, token string, password string) error {
    // Validate setup token
    claims, err := s.validateSetupToken(token)
    if err != nil {
        return fmt.Errorf("invalid setup token: %w", err)
    }

    tenantID, err := uuid.Parse(claims["tenant_id"].(string))
    if err != nil {
        return fmt.Errorf("invalid tenant ID in token")
    }

    userID, err := uuid.Parse(claims["user_id"].(string))
    if err != nil {
        return fmt.Errorf("invalid user ID in token")
    }

    // Set user password
    hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
    if err != nil {
        return fmt.Errorf("failed to hash password: %w", err)
    }

    if err := s.userRepo.UpdatePassword(ctx, userID, string(hashedPassword)); err != nil {
        return fmt.Errorf("failed to set password: %w", err)
    }

    // Mark email as verified
    if err := s.userRepo.VerifyEmail(ctx, userID); err != nil {
        return fmt.Errorf("failed to verify email: %w", err)
    }

    // Update tenant status to active
    if err := s.tenantRepo.UpdateStatus(ctx, tenantID, TenantStatusActive); err != nil {
        return fmt.Errorf("failed to activate tenant: %w", err)
    }

    return nil
}

// GetOnboardingStatus retrieves current onboarding status
func (s *OnboardingService) GetOnboardingStatus(ctx context.Context, tenantID uuid.UUID) (*OnboardingStatus, error) {
    // Retrieve from database or cache
    status := &OnboardingStatus{
        TenantID:       tenantID,
        CompletedSteps: []OnboardingStep{},
        StepData:       make(map[string]any),
    }

    // Check which steps are complete
    tenant, err := s.tenantRepo.GetByID(ctx, tenantID)
    if err != nil {
        return nil, err
    }

    owner, err := s.userRepo.GetOwnerByTenantID(ctx, tenantID)
    if err != nil {
        return nil, err
    }

    // Check password set
    if owner.PasswordHash != "" {
        status.CompletedSteps = append(status.CompletedSteps, StepSetPassword)
    } else {
        status.CurrentStep = StepSetPassword
        return status, nil
    }

    // Check email verified
    if owner.EmailVerified {
        status.CompletedSteps = append(status.CompletedSteps, StepVerifyEmail)
    } else {
        status.CurrentStep = StepVerifyEmail
        return status, nil
    }

    // Check billing setup
    if tenant.SubscriptionID != nil && *tenant.SubscriptionID != "" {
        status.CompletedSteps = append(status.CompletedSteps, StepSetupBilling)
    } else {
        status.CurrentStep = StepSetupBilling
        return status, nil
    }

    // Other steps are optional
    status.CurrentStep = StepComplete
    status.IsComplete = true

    return status, nil
}

// SetupBilling sets up Stripe billing for a tenant
func (s *OnboardingService) SetupBilling(ctx context.Context, tenantID uuid.UUID, paymentMethodID string) error {
    tenant, err := s.tenantRepo.GetByID(ctx, tenantID)
    if err != nil {
        return err
    }

    subscription, err := s.tenantRepo.GetSubscriptionByTenantID(ctx, tenantID)
    if err != nil {
        return err
    }

    // Create Stripe customer
    customerParams := &stripe.CustomerParams{
        Email: stripe.String(tenant.BillingEmail),
        Name:  stripe.String(tenant.Name),
        Metadata: map[string]string{
            "tenant_id": tenantID.String(),
        },
    }

    customer, err := s.stripeClient.Customers.New(customerParams)
    if err != nil {
        return fmt.Errorf("failed to create Stripe customer: %w", err)
    }

    // Attach payment method
    if paymentMethodID != "" {
        _, err = s.stripeClient.PaymentMethods.Attach(paymentMethodID, &stripe.PaymentMethodAttachParams{
            Customer: stripe.String(customer.ID),
        })
        if err != nil {
            return fmt.Errorf("failed to attach payment method: %w", err)
        }

        // Set as default
        _, err = s.stripeClient.Customers.Update(customer.ID, &stripe.CustomerParams{
            InvoiceSettings: &stripe.CustomerInvoiceSettingsParams{
                DefaultPaymentMethod: stripe.String(paymentMethodID),
            },
        })
        if err != nil {
            return fmt.Errorf("failed to set default payment method: %w", err)
        }
    }

    // Create subscription if not in trial
    if subscription.Status != billing.SubscriptionStatusTrialing {
        plan, err := s.tenantRepo.GetPlanByID(ctx, tenant.PlanID)
        if err != nil {
            return err
        }

        subParams := &stripe.SubscriptionParams{
            Customer: stripe.String(customer.ID),
            Items: []*stripe.SubscriptionItemsParams{
                {
                    Price: stripe.String(plan.StripePriceIDMo),
                },
            },
            Metadata: map[string]string{
                "tenant_id": tenantID.String(),
            },
        }

        stripeSub, err := s.stripeClient.Subscriptions.New(subParams)
        if err != nil {
            return fmt.Errorf("failed to create Stripe subscription: %w", err)
        }

        // Update local subscription
        subscription.StripeCustomerID = customer.ID
        subscription.StripeSubscriptionID = stripeSub.ID
        subscription.Status = billing.SubscriptionStatusActive

        if err := s.tenantRepo.UpdateSubscription(ctx, subscription); err != nil {
            return err
        }
    }

    return nil
}

// CustomizeBranding updates tenant branding settings
func (s *OnboardingService) CustomizeBranding(ctx context.Context, tenantID uuid.UUID, branding *BrandingSettings) error {
    return s.tenantRepo.UpdateBranding(ctx, tenantID, branding)
}

// InviteTeamMembers sends invitations to team members
func (s *OnboardingService) InviteTeamMembers(ctx context.Context, tenantID uuid.UUID, invites []TeamInvite) error {
    for _, invite := range invites {
        // Create user with invited status
        user := &User{
            ID:        uuid.New(),
            TenantID:  tenantID,
            Email:     invite.Email,
            FirstName: invite.FirstName,
            LastName:  invite.LastName,
            Role:      invite.Role,
            Status:    UserStatusInvited,
            CreatedAt: time.Now().UTC(),
            UpdatedAt: time.Now().UTC(),
        }

        if err := s.userRepo.Create(ctx, user); err != nil {
            s.logger.Error("failed to create invited user", "error", err, "email", invite.Email)
            continue
        }

        // Send invitation email
        if err := s.emailService.SendInvitation(ctx, tenant, user, invite.Message); err != nil {
            s.logger.Error("failed to send invitation", "error", err, "email", invite.Email)
        }
    }

    return nil
}

type TeamInvite struct {
    Email     string
    FirstName string
    LastName  string
    Role      Role
    Message   string
}
```
