## Part 7: White-Labeling and Customization

White-labeling lets tenants customize the look and feel of your platform so it appears as their own product. This includes custom logos, color schemes, email templates, and even custom domains. For example, a tenant might want their users to see `app.theircompany.com` instead of `theircompany.tenantflow.com`, with their own branding everywhere. The service below handles branding configuration, custom domain setup with automatic SSL certificates, and asset management. White-labeling is a powerful differentiator for B2B SaaS products because enterprise customers often need the platform to feel like an internal tool.

```go
// internal/whitelabel/service.go
package whitelabel

import (
    "context"
    "fmt"
    "net/url"

    "github.com/google/uuid"
    "github.com/yourorg/tenantflow/internal/isolation"
    "github.com/yourorg/tenantflow/internal/tenant"
)

// Service handles white-labeling operations
type Service struct {
    tenantRepo tenant.Repository
    storage    storage.Service
    cdn        CDNService
    logger     logger.Logger
}

func NewService(
    tenantRepo tenant.Repository,
    storage storage.Service,
    cdn CDNService,
    logger logger.Logger,
) *Service {
    return &Service{
        tenantRepo: tenantRepo,
        storage:    storage,
        cdn:        cdn,
        logger:     logger,
    }
}

// UpdateBranding updates tenant branding settings
func (s *Service) UpdateBranding(ctx context.Context, branding *tenant.BrandingSettings) error {
    tenantID, err := isolation.TenantID(ctx)
    if err != nil {
        return err
    }

    // Validate colors
    if err := s.validateColor(branding.PrimaryColor); err != nil {
        return fmt.Errorf("invalid primary color: %w", err)
    }
    if err := s.validateColor(branding.SecondaryColor); err != nil {
        return fmt.Errorf("invalid secondary color: %w", err)
    }
    if err := s.validateColor(branding.AccentColor); err != nil {
        return fmt.Errorf("invalid accent color: %w", err)
    }

    // Update in database
    if err := s.tenantRepo.UpdateBranding(ctx, tenantID, branding); err != nil {
        return err
    }

    // Generate and cache CSS
    if err := s.generateCustomCSS(ctx, tenantID, branding); err != nil {
        s.logger.Error("failed to generate custom CSS", "error", err)
    }

    return nil
}

// UploadLogo uploads and processes a tenant's logo
func (s *Service) UploadLogo(ctx context.Context, file []byte, filename string) (string, error) {
    tenantID, err := isolation.TenantID(ctx)
    if err != nil {
        return "", err
    }

    // Process image (resize, optimize)
    processed, err := s.processImage(file, 200, 200)
    if err != nil {
        return "", fmt.Errorf("failed to process logo: %w", err)
    }

    // Upload to storage
    path := fmt.Sprintf("tenants/%s/branding/logo_%s", tenantID, filename)
    url, err := s.storage.Upload(ctx, path, processed)
    if err != nil {
        return "", fmt.Errorf("failed to upload logo: %w", err)
    }

    // Update tenant branding
    t, err := s.tenantRepo.GetByID(ctx, tenantID)
    if err != nil {
        return "", err
    }

    t.Branding.LogoURL = url

    if err := s.tenantRepo.UpdateBranding(ctx, tenantID, &t.Branding); err != nil {
        return "", err
    }

    return url, nil
}

// SetupCustomDomain configures a custom domain for a tenant
func (s *Service) SetupCustomDomain(ctx context.Context, domain string) error {
    tenantID, err := isolation.TenantID(ctx)
    if err != nil {
        return err
    }

    // Validate domain
    if err := s.validateDomain(domain); err != nil {
        return fmt.Errorf("invalid domain: %w", err)
    }

    // Check if domain is already in use
    exists, err := s.tenantRepo.CustomDomainExists(ctx, domain)
    if err != nil {
        return err
    }
    if exists {
        return fmt.Errorf("domain already in use")
    }

    // Verify domain ownership (DNS TXT record)
    if err := s.verifyDomainOwnership(ctx, domain, tenantID); err != nil {
        return fmt.Errorf("domain verification failed: %w", err)
    }

    // Set up SSL certificate (Let's Encrypt)
    if err := s.provisionSSLCertificate(ctx, domain); err != nil {
        return fmt.Errorf("failed to provision SSL: %w", err)
    }

    // Update tenant
    if err := s.tenantRepo.SetCustomDomain(ctx, tenantID, domain); err != nil {
        return err
    }

    s.logger.Info("custom domain configured", "tenant_id", tenantID, "domain", domain)

    return nil
}

// GetBranding retrieves branding settings for current tenant
func (s *Service) GetBranding(ctx context.Context) (*tenant.BrandingSettings, error) {
    tenantID, err := isolation.TenantID(ctx)
    if err != nil {
        return nil, err
    }

    t, err := s.tenantRepo.GetByID(ctx, tenantID)
    if err != nil {
        return nil, err
    }

    return &t.Branding, nil
}

// GenerateThemeCSS generates custom CSS based on branding
func (s *Service) generateCustomCSS(ctx context.Context, tenantID uuid.UUID, branding *tenant.BrandingSettings) error {
    css := fmt.Sprintf(`
:root {
    --primary-color: %s;
    --secondary-color: %s;
    --accent-color: %s;
}

.btn-primary {
    background-color: var(--primary-color);
}

.btn-secondary {
    background-color: var(--secondary-color);
}

.link, .btn-link {
    color: var(--accent-color);
}

%s
`, branding.PrimaryColor, branding.SecondaryColor, branding.AccentColor, branding.CustomCSS)

    // Upload to CDN
    path := fmt.Sprintf("tenants/%s/theme.css", tenantID)
    _, err := s.cdn.Upload(ctx, path, []byte(css))
    return err
}

func (s *Service) validateColor(color string) error {
    // Validate hex color format
    if len(color) != 7 || color[0] != '#' {
        return fmt.Errorf("invalid color format: must be #RRGGBB")
    }
    return nil
}

func (s *Service) validateDomain(domain string) error {
    parsed, err := url.Parse("https://" + domain)
    if err != nil {
        return err
    }
    if parsed.Host != domain {
        return fmt.Errorf("invalid domain format")
    }
    return nil
}

func (s *Service) verifyDomainOwnership(ctx context.Context, domain string, tenantID uuid.UUID) error {
    // Check for DNS TXT record: _tenantflow-verification=<tenant_id>
    // Implementation depends on DNS library
    return nil
}

func (s *Service) provisionSSLCertificate(ctx context.Context, domain string) error {
    // Use Let's Encrypt ACME protocol to provision certificate
    // Implementation depends on ACME client
    return nil
}

func (s *Service) processImage(data []byte, maxWidth, maxHeight int) ([]byte, error) {
    // Resize and optimize image
    // Implementation depends on image library
    return data, nil
}
```

### Email Template Customization

Transactional emails (like welcome messages, password resets, and invoices) need to match each tenant's branding. The email template system below lets tenants customize the HTML templates, colors, and logos used in outgoing emails. Templates use Go's `html/template` package with placeholder variables that get filled in at send time. A fallback mechanism ensures that if a tenant has not customized a particular template, the platform's default template is used instead.

```go
// internal/whitelabel/email_templates.go
package whitelabel

import (
    "bytes"
    "context"
    "fmt"
    "html/template"

    "github.com/google/uuid"
    "github.com/yourorg/tenantflow/internal/tenant"
)

// EmailTemplateService manages customizable email templates
type EmailTemplateService struct {
    tenantRepo tenant.Repository
    templates  *template.Template
    logger     logger.Logger
}

func NewEmailTemplateService(tenantRepo tenant.Repository, logger logger.Logger) *EmailTemplateService {
    // Load base templates
    templates := template.Must(template.ParseGlob("templates/emails/*.html"))

    return &EmailTemplateService{
        tenantRepo: tenantRepo,
        templates:  templates,
        logger:     logger,
    }
}

// RenderEmail renders an email template with tenant branding
func (s *EmailTemplateService) RenderEmail(ctx context.Context, templateName string, data any) (string, error) {
    tenantID, err := isolation.TenantID(ctx)
    if err != nil {
        return "", err
    }

    t, err := s.tenantRepo.GetByID(ctx, tenantID)
    if err != nil {
        return "", err
    }

    // Prepare template data with branding
    templateData := map[string]any{
        "Branding": t.Branding,
        "Tenant":   t,
        "Data":     data,
    }

    var buf bytes.Buffer
    if err := s.templates.ExecuteTemplate(&buf, templateName, templateData); err != nil {
        return "", fmt.Errorf("failed to render template: %w", err)
    }

    return buf.String(), nil
}

// Base email template (templates/emails/base.html)
const baseEmailTemplate = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
        }
        .header {
            background-color: {{.Branding.PrimaryColor}};
            color: white;
            padding: 20px;
            text-align: center;
        }
        .logo {
            max-width: 200px;
        }
        .content {
            padding: 20px;
        }
        .button {
            display: inline-block;
            padding: 10px 20px;
            background-color: {{.Branding.AccentColor}};
            color: white;
            text-decoration: none;
            border-radius: 5px;
        }
        .footer {
            background-color: #f5f5f5;
            padding: 20px;
            text-align: center;
            font-size: 12px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="header">
        {{if .Branding.LogoURL}}
        <img src="{{.Branding.LogoURL}}" alt="Logo" class="logo">
        {{else}}
        <h1>{{.Branding.CompanyName}}</h1>
        {{end}}
    </div>
    <div class="content">
        {{block "content" .}}{{end}}
    </div>
    <div class="footer">
        <p>&copy; {{.Branding.CompanyName}}. All rights reserved.</p>
        <p>Need help? Contact us at <a href="mailto:{{.Branding.SupportEmail}}">{{.Branding.SupportEmail}}</a></p>
    </div>
</body>
</html>
`
```
