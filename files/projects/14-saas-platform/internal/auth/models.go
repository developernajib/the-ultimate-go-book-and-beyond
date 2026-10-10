// internal/auth/models.go
package auth

import (
    "time"

    "github.com/google/uuid"
)

// User represents an individual user within a tenant
type User struct {
    ID                uuid.UUID         `json:"id" db:"id"`
    TenantID          uuid.UUID         `json:"tenant_id" db:"tenant_id"`
    Email             string            `json:"email" db:"email"`
    EmailVerified     bool              `json:"email_verified" db:"email_verified"`
    PasswordHash      string            `json:"-" db:"password_hash"`
    FirstName         string            `json:"first_name" db:"first_name"`
    LastName          string            `json:"last_name" db:"last_name"`
    AvatarURL         *string           `json:"avatar_url,omitempty" db:"avatar_url"`

    // Role and permissions
    Role              Role              `json:"role" db:"role"`
    Permissions       []string          `json:"permissions" db:"permissions"`

    // MFA
    MFAEnabled        bool              `json:"mfa_enabled" db:"mfa_enabled"`
    MFASecret         *string           `json:"-" db:"mfa_secret"`

    // SSO
    SSOProvider       *string           `json:"sso_provider,omitempty" db:"sso_provider"`
    SSOExternalID     *string           `json:"sso_external_id,omitempty" db:"sso_external_id"`

    // Status
    Status            UserStatus        `json:"status" db:"status"`
    LastLoginAt       *time.Time        `json:"last_login_at,omitempty" db:"last_login_at"`
    LastLoginIP       *string           `json:"last_login_ip,omitempty" db:"last_login_ip"`

    // Invitation
    InvitedBy         *uuid.UUID        `json:"invited_by,omitempty" db:"invited_by"`
    InvitedAt         *time.Time        `json:"invited_at,omitempty" db:"invited_at"`
    InviteAcceptedAt  *time.Time        `json:"invite_accepted_at,omitempty" db:"invite_accepted_at"`

    // Metadata
    Metadata          JSONB             `json:"metadata" db:"metadata"`

    // Timestamps
    CreatedAt         time.Time         `json:"created_at" db:"created_at"`
    UpdatedAt         time.Time         `json:"updated_at" db:"updated_at"`
    DeletedAt         *time.Time        `json:"deleted_at,omitempty" db:"deleted_at"`
}

type UserStatus string

const (
    UserStatusActive    UserStatus = "active"
    UserStatusInvited   UserStatus = "invited"
    UserStatusSuspended UserStatus = "suspended"
    UserStatusDeleted   UserStatus = "deleted"
)

type Role string

const (
    RoleOwner       Role = "owner"
    RoleAdmin       Role = "admin"
    RoleMember      Role = "member"
    RoleReadOnly    Role = "readonly"
    RoleCustom      Role = "custom"
)

// Permission represents a granular permission
type Permission struct {
    ID          uuid.UUID  `json:"id" db:"id"`
    TenantID    uuid.UUID  `json:"tenant_id" db:"tenant_id"`
    Name        string     `json:"name" db:"name"`
    Resource    string     `json:"resource" db:"resource"`
    Action      string     `json:"action" db:"action"`
    Description string     `json:"description" db:"description"`
    CreatedAt   time.Time  `json:"created_at" db:"created_at"`
}

// RolePermission maps roles to permissions
type RolePermission struct {
    ID           uuid.UUID  `json:"id" db:"id"`
    TenantID     uuid.UUID  `json:"tenant_id" db:"tenant_id"`
    Role         Role       `json:"role" db:"role"`
    PermissionID uuid.UUID  `json:"permission_id" db:"permission_id"`
    CreatedAt    time.Time  `json:"created_at" db:"created_at"`
}

// Session represents an active user session
type Session struct {
    ID           uuid.UUID  `json:"id" db:"id"`
    UserID       uuid.UUID  `json:"user_id" db:"user_id"`
    TenantID     uuid.UUID  `json:"tenant_id" db:"tenant_id"`
    RefreshToken string     `json:"-" db:"refresh_token"`
    DeviceInfo   string     `json:"device_info" db:"device_info"`
    IPAddress    string     `json:"ip_address" db:"ip_address"`
    ExpiresAt    time.Time  `json:"expires_at" db:"expires_at"`
    CreatedAt    time.Time  `json:"created_at" db:"created_at"`
}

// SSOConfig represents SSO configuration for a tenant
type SSOConfig struct {
    ID           uuid.UUID   `json:"id" db:"id"`
    TenantID     uuid.UUID   `json:"tenant_id" db:"tenant_id"`
    Provider     SSOProvider `json:"provider" db:"provider"`
    Enabled      bool        `json:"enabled" db:"enabled"`

    // SAML
    SAMLMetadataURL  *string `json:"saml_metadata_url,omitempty" db:"saml_metadata_url"`
    SAMLEntityID     *string `json:"saml_entity_id,omitempty" db:"saml_entity_id"`
    SAMLCertificate  *string `json:"saml_certificate,omitempty" db:"saml_certificate"`

    // OIDC
    OIDCIssuer       *string `json:"oidc_issuer,omitempty" db:"oidc_issuer"`
    OIDCClientID     *string `json:"oidc_client_id,omitempty" db:"oidc_client_id"`
    OIDCClientSecret *string `json:"-" db:"oidc_client_secret"`

    // Attribute mapping
    AttributeMapping map[string]string `json:"attribute_mapping" db:"attribute_mapping"`

    CreatedAt    time.Time  `json:"created_at" db:"created_at"`
    UpdatedAt    time.Time  `json:"updated_at" db:"updated_at"`
}

type SSOProvider string

const (
    SSOProviderSAML   SSOProvider = "saml"
    SSOProviderOIDC   SSOProvider = "oidc"
    SSOProviderOAuth2 SSOProvider = "oauth2"
)
