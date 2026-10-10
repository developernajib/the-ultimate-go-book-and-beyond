// internal/whitelabel/email_templates.go
package whitelabel

import (
    "bytes"
    "context"
    "fmt"
    "html/template"

    "github.com/example/saas-platform/internal/isolation"
    "github.com/example/saas-platform/internal/tenant"
    "github.com/example/saas-platform/pkg/logger"
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
