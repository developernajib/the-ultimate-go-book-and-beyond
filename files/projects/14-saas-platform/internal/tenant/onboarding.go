// internal/tenant/onboarding.go
package tenant

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
	"github.com/example/saas-platform/pkg/logger"
)

// OnboardingService handles tenant onboarding flow
type OnboardingService struct {
	tenantRepo   Repository
	userRepo     UserRepository
	emailService EmailService
	logger       logger.Logger
}

func NewOnboardingService(tenantRepo Repository, userRepo UserRepository, emailService EmailService, log logger.Logger) *OnboardingService {
	return &OnboardingService{
		tenantRepo:   tenantRepo,
		userRepo:     userRepo,
		emailService: emailService,
		logger:       log,
	}
}

// OnboardingStep represents a step in the onboarding process
type OnboardingStep string

const (
	StepSetPassword       OnboardingStep = "set_password"
	StepVerifyEmail       OnboardingStep = "verify_email"
	StepSetupBilling      OnboardingStep = "setup_billing"
	StepCustomizeBranding OnboardingStep = "customize_branding"
	StepInviteTeam        OnboardingStep = "invite_team"
	StepComplete          OnboardingStep = "complete"
)

// OnboardingStatus tracks onboarding progress
type OnboardingStatus struct {
	TenantID       uuid.UUID      `json:"tenant_id"`
	CurrentStep    OnboardingStep `json:"current_step"`
	CompletedSteps []OnboardingStep `json:"completed_steps"`
	IsComplete     bool           `json:"is_complete"`
	StepData       map[string]any `json:"step_data"`
}

// CompleteSetup finalizes tenant setup
func (s *OnboardingService) CompleteSetup(ctx context.Context, tenantID uuid.UUID, userID uuid.UUID, password string) error {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}

	if err := s.userRepo.UpdatePassword(ctx, userID, string(hashedPassword)); err != nil {
		return fmt.Errorf("failed to set password: %w", err)
	}

	if err := s.userRepo.VerifyEmail(ctx, userID); err != nil {
		return fmt.Errorf("failed to verify email: %w", err)
	}

	if err := s.tenantRepo.UpdateStatus(ctx, tenantID, TenantStatusActive); err != nil {
		return fmt.Errorf("failed to activate tenant: %w", err)
	}

	return nil
}

// GetOnboardingStatus retrieves current onboarding status
func (s *OnboardingService) GetOnboardingStatus(ctx context.Context, tenantID uuid.UUID) (*OnboardingStatus, error) {
	status := &OnboardingStatus{
		TenantID:       tenantID,
		CompletedSteps: []OnboardingStep{},
		StepData:       make(map[string]any),
		CurrentStep:    StepSetPassword,
	}

	_, err := s.tenantRepo.GetByID(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	return status, nil
}

// CustomizeBranding updates tenant branding settings
func (s *OnboardingService) CustomizeBranding(ctx context.Context, tenantID uuid.UUID, branding *BrandingSettings) error {
	return s.tenantRepo.UpdateBranding(ctx, tenantID, branding)
}

// TeamInvite holds invite details
type TeamInvite struct {
	Email     string
	FirstName string
	LastName  string
	Role      Role
	Message   string
}

// InviteTeamMembers sends invitations to team members
func (s *OnboardingService) InviteTeamMembers(ctx context.Context, tenantID uuid.UUID, invites []TeamInvite) error {
	for _, invite := range invites {
		user := &User{
			ID:        uuid.New(),
			TenantID:  tenantID,
			Email:     invite.Email,
			FirstName: invite.FirstName,
			LastName:  invite.LastName,
			Role:      invite.Role,
			Status:    UserStatusPending,
			CreatedAt: time.Now().UTC(),
			UpdatedAt: time.Now().UTC(),
		}

		if err := s.userRepo.Create(ctx, user); err != nil {
			s.logger.Error("failed to create invited user", "error", err, "email", invite.Email)
			continue
		}

		if err := s.emailService.SendVerification(ctx, invite.Email, ""); err != nil {
			s.logger.Error("failed to send invitation", "error", err, "email", invite.Email)
		}
	}

	return nil
}
