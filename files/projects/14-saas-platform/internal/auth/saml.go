// internal/auth/saml.go
package auth

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/crewjam/saml"
	"github.com/crewjam/saml/samlsp"
	"github.com/example/saas-platform/internal/isolation"
	"github.com/example/saas-platform/pkg/logger"
	"github.com/google/uuid"
)

// SAMLService handles SAML SSO authentication
type SAMLService struct {
	ssoConfigRepo SSOConfigRepository
	userRepo      UserRepository
	jwtService    *JWTService
	logger        logger.Logger
}

func NewSAMLService(
	ssoConfigRepo SSOConfigRepository,
	userRepo UserRepository,
	jwtService *JWTService,
	log logger.Logger,
) *SAMLService {
	return &SAMLService{
		ssoConfigRepo: ssoConfigRepo,
		userRepo:      userRepo,
		jwtService:    jwtService,
		logger:        log,
	}
}

// GetSAMLMiddleware returns a SAML middleware for a tenant
func (s *SAMLService) GetSAMLMiddleware(ctx context.Context, tenantID uuid.UUID) (*samlsp.Middleware, error) {
	config, err := s.ssoConfigRepo.GetByTenantAndProvider(ctx, tenantID, SSOProviderSAML)
	if err != nil {
		return nil, fmt.Errorf("SAML not configured for tenant: %w", err)
	}

	if !config.Enabled {
		return nil, fmt.Errorf("SAML is disabled for this tenant")
	}

	// Parse certificate
	block, _ := pem.Decode([]byte(*config.SAMLCertificate))
	if block == nil {
		return nil, fmt.Errorf("failed to parse certificate PEM")
	}

	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse certificate: %w", err)
	}

	// Parse the metadata URL
	metaURL, err := url.Parse(*config.SAMLMetadataURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse SAML metadata URL: %w", err)
	}

	// Create SAML middleware
	samlMiddleware, err := samlsp.New(samlsp.Options{
		URL:         *metaURL,
		Certificate: cert,
		EntityID:    *config.SAMLEntityID,
	})

	if err != nil {
		return nil, fmt.Errorf("failed to create SAML middleware: %w", err)
	}

	return samlMiddleware, nil
}

// HandleSAMLCallback processes SAML assertion and creates/updates user
func (s *SAMLService) HandleSAMLCallback(ctx context.Context, assertion *saml.Assertion) (*User, error) {
	tenantID, err := isolation.TenantID(ctx)
	if err != nil {
		return nil, err
	}

	config, err := s.ssoConfigRepo.GetByTenantAndProvider(ctx, tenantID, SSOProviderSAML)
	if err != nil {
		return nil, err
	}

	// Extract user attributes from SAML assertion
	attributes := s.extractAttributes(assertion, config.AttributeMapping)

	email, ok := attributes["email"].(string)
	if !ok || email == "" {
		return nil, fmt.Errorf("email not found in SAML assertion")
	}

	// Find or create user
	user, err := s.userRepo.GetByEmail(ctx, tenantID, email)
	if err != nil {
		// User doesn't exist, create new one
		user = &User{
			ID:            uuid.New(),
			TenantID:      tenantID,
			Email:         email,
			EmailVerified: true, // SSO users are pre-verified
			FirstName:     getStringAttribute(attributes, "first_name"),
			LastName:      getStringAttribute(attributes, "last_name"),
			Role:          RoleMember, // Default role
			Status:        UserStatusActive,
			SSOProvider:   new(string(SSOProviderSAML)),
			SSOExternalID: new(assertion.Subject.NameID.Value),
			CreatedAt:     time.Now().UTC(),
			UpdatedAt:     time.Now().UTC(),
		}

		if err := s.userRepo.Create(ctx, user); err != nil {
			return nil, fmt.Errorf("failed to create SSO user: %w", err)
		}
	} else {
		// Update existing user with SSO info
		user.SSOProvider = new(string(SSOProviderSAML))
		user.SSOExternalID = new(assertion.Subject.NameID.Value)
		user.EmailVerified = true
		user.LastLoginAt = new(time.Now().UTC())

		if err := s.userRepo.Update(ctx, user); err != nil {
			return nil, fmt.Errorf("failed to update SSO user: %w", err)
		}
	}

	return user, nil
}

func getStringAttribute(attrs map[string]any, key string) string {
	if v, ok := attrs[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

//go:fix inline
func stringPtr(s string) *string { return new(s) }

//go:fix inline
func timePtr(t time.Time) *time.Time { return new(t) }

func (s *SAMLService) extractAttributes(assertion *saml.Assertion, mapping map[string]string) map[string]any {
	attributes := make(map[string]any)

	for key, samlAttr := range mapping {
		for _, stmt := range assertion.AttributeStatements {
			for _, attr := range stmt.Attributes {
				if attr.Name == samlAttr {
					if len(attr.Values) > 0 {
						attributes[key] = attr.Values[0].Value
					}
				}
			}
		}
	}

	return attributes
}

// SAMLLoginHandler handles SAML login initiation
func (s *SAMLService) SAMLLoginHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		tenantID, err := isolation.TenantID(ctx)
		if err != nil {
			http.Error(w, "Tenant not found", http.StatusBadRequest)
			return
		}

		middleware, err := s.GetSAMLMiddleware(ctx, tenantID)
		if err != nil {
			s.logger.Error("failed to get SAML middleware", "error", err)
			http.Error(w, "SAML not configured", http.StatusBadRequest)
			return
		}

		// Redirect to IdP
		middleware.HandleStartAuthFlow(w, r)
	}
}

// SAMLCallbackHandler handles SAML assertion callback
func (s *SAMLService) SAMLCallbackHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Extract SAML session from context (set by samlsp.Middleware)
		session := samlsp.SessionFromContext(ctx)
		if session == nil {
			http.Error(w, "Invalid SAML assertion", http.StatusBadRequest)
			return
		}
		// Build a minimal assertion from session attributes
		var assertion saml.Assertion
		if sa, ok := session.(samlsp.SessionWithAttributes); ok {
			for name, vals := range sa.GetAttributes() {
				attrVals := make([]saml.AttributeValue, len(vals))
				for i, v := range vals {
					attrVals[i] = saml.AttributeValue{Value: v}
				}
				assertion.AttributeStatements = append(assertion.AttributeStatements, saml.AttributeStatement{
					Attributes: []saml.Attribute{{Name: name, Values: attrVals}},
				})
			}
		}

		// Process assertion and get/create user
		user, err := s.HandleSAMLCallback(ctx, &assertion)
		if err != nil {
			s.logger.Error("SAML callback failed", "error", err)
			http.Error(w, "Authentication failed", http.StatusInternalServerError)
			return
		}

		// Generate JWT tokens
		accessToken, refreshToken, err := s.jwtService.GenerateTokenPair(user)
		if err != nil {
			s.logger.Error("failed to generate tokens", "error", err)
			http.Error(w, "Authentication failed", http.StatusInternalServerError)
			return
		}

		// Return tokens (or set cookies, or redirect with tokens)
		json.NewEncoder(w).Encode(map[string]string{
			"access_token":  accessToken,
			"refresh_token": refreshToken,
		})
	}
}
