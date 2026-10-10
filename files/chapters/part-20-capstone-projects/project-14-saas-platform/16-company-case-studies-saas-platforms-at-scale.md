## Company Case Studies: SaaS Platforms at Scale

### Stripe: Multi-Product SaaS Platform

Stripe's platform for payments and financial services:

```go
// Stripe-style multi-product SaaS platform
package stripe

import (
    "context"
    "time"
)

// PlatformService manages Stripe Connect
type PlatformService struct {
    accountService   *ConnectedAccountService
    paymentService   *PaymentService
    payoutService    *PayoutService
    webhookService   *WebhookService
}

// ConnectedAccount represents a Stripe Connect account
type ConnectedAccount struct {
    ID               string            `json:"id"`
    Type             string            `json:"type"` // standard, express, custom
    BusinessType     string            `json:"business_type"`
    ChargesEnabled   bool              `json:"charges_enabled"`
    PayoutsEnabled   bool              `json:"payouts_enabled"`
    Requirements     *AccountRequirements `json:"requirements"`
    Capabilities     map[string]string `json:"capabilities"`
    Metadata         map[string]string `json:"metadata"`
    Created          time.Time         `json:"created"`
}

// CreateConnectedAccount onboards a new merchant
func (s *PlatformService) CreateConnectedAccount(ctx context.Context, req *CreateAccountRequest) (*ConnectedAccount, error) {
    account := &ConnectedAccount{
        ID:           generateAccountID(),
        Type:         req.Type,
        BusinessType: req.BusinessType,
        Metadata:     req.Metadata,
        Created:      time.Now(),
    }

    // Set capabilities based on account type
    account.Capabilities = s.getDefaultCapabilities(req.Type)

    // Check requirements
    account.Requirements = s.calculateRequirements(account)

    // Create account
    if err := s.accountService.Create(ctx, account); err != nil {
        return nil, err
    }

    // Generate onboarding link
    if req.Type == "express" {
        link := s.generateOnboardingLink(account)
        // Return link for redirect
    }

    return account, nil
}

// ProcessPayment handles destination charges
func (s *PlatformService) ProcessPayment(ctx context.Context, req *PaymentRequest) (*PaymentIntent, error) {
    // Validate connected account
    account, err := s.accountService.Get(ctx, req.DestinationAccount)
    if err != nil {
        return nil, err
    }

    if !account.ChargesEnabled {
        return nil, ErrChargesNotEnabled
    }

    // Create payment intent
    intent := &PaymentIntent{
        Amount:             req.Amount,
        Currency:           req.Currency,
        ApplicationFeeAmount: req.ApplicationFee,
        TransferData: &TransferData{
            Destination: req.DestinationAccount,
            Amount:      req.Amount - req.ApplicationFee,
        },
    }

    // Process payment
    result, err := s.paymentService.CreatePaymentIntent(ctx, intent)
    if err != nil {
        return nil, err
    }

    // Schedule payout if instant payouts enabled
    if req.InstantPayout && account.Capabilities["instant_payouts"] == "active" {
        s.payoutService.ScheduleInstantPayout(ctx, account.ID, result.TransferID)
    }

    return result, nil
}
```

### Salesforce: Enterprise CRM Platform

Salesforce's multi-tenant architecture:

```go
// Salesforce-style multi-tenant CRM platform
package salesforce

import (
    "context"
    "time"
)

// CRMPlatform manages multi-tenant CRM
type CRMPlatform struct {
    orgService      *OrganizationService
    objectService   *CustomObjectService
    queryEngine     *SOQLEngine
    apexRuntime     *ApexRuntime
}

// Organization represents a Salesforce org
type Organization struct {
    ID              string            `json:"id"`
    Name            string            `json:"name"`
    Edition         string            `json:"edition"` // enterprise, unlimited, developer
    Features        []string          `json:"features"`
    StorageLimit    int64             `json:"storage_limit_mb"`
    APICallLimit    int64             `json:"api_calls_per_day"`
    CustomObjects   int               `json:"custom_objects"`
    Schema          *OrgSchema        `json:"schema"`
    CreatedAt       time.Time         `json:"created_at"`
}

// SObject represents a Salesforce object
type SObject struct {
    Name           string              `json:"name"`
    Label          string              `json:"label"`
    Custom         bool                `json:"custom"`
    Fields         []*Field            `json:"fields"`
    RecordTypes    []*RecordType       `json:"recordTypes"`
    Triggers       []*ApexTrigger      `json:"triggers"`
    ValidationRules []*ValidationRule  `json:"validationRules"`
}

// Query executes SOQL with tenant isolation
func (p *CRMPlatform) Query(ctx context.Context, orgID, soql string) (*QueryResult, error) {
    // Parse SOQL
    query, err := p.queryEngine.Parse(soql)
    if err != nil {
        return nil, err
    }

    // Get org schema
    org, err := p.orgService.Get(ctx, orgID)
    if err != nil {
        return nil, err
    }

    // Validate query against schema
    if err := p.queryEngine.Validate(query, org.Schema); err != nil {
        return nil, err
    }

    // Inject tenant filter
    query = p.queryEngine.AddTenantFilter(query, orgID)

    // Check governor limits
    if err := p.checkGovernorLimits(ctx, org, query); err != nil {
        return nil, err
    }

    // Execute query
    result, err := p.queryEngine.Execute(ctx, query)
    if err != nil {
        return nil, err
    }

    // Track API usage
    p.orgService.IncrementAPIUsage(ctx, orgID)

    return result, nil
}

// CreateCustomObject adds a custom object to an org
func (p *CRMPlatform) CreateCustomObject(ctx context.Context, orgID string, obj *SObject) error {
    org, err := p.orgService.Get(ctx, orgID)
    if err != nil {
        return err
    }

    // Check custom object limit
    if org.CustomObjects >= p.getCustomObjectLimit(org.Edition) {
        return ErrCustomObjectLimitReached
    }

    // Validate object definition
    if err := p.objectService.Validate(obj); err != nil {
        return err
    }

    // Create table in metadata-driven schema
    if err := p.objectService.CreateTable(ctx, orgID, obj); err != nil {
        return err
    }

    // Update org schema
    org.Schema.Objects = append(org.Schema.Objects, obj)
    org.CustomObjects++

    return p.orgService.Update(ctx, org)
}
```

### Slack: Workspace Collaboration Platform

Slack's workspace and channel architecture:

```go
// Slack-style workspace collaboration platform
package slack

import (
    "context"
    "time"
)

// WorkspacePlatform manages Slack workspaces
type WorkspacePlatform struct {
    workspaceService *WorkspaceService
    channelService   *ChannelService
    messageService   *MessageService
    appService       *SlackAppService
    billingService   *BillingService
}

// Workspace represents a Slack workspace
type Workspace struct {
    ID              string            `json:"id"`
    Name            string            `json:"name"`
    Domain          string            `json:"domain"`
    Plan            string            `json:"plan"` // free, pro, business+, enterprise
    MemberCount     int               `json:"member_count"`
    GuestCount      int               `json:"guest_count"`
    Features        *WorkspaceFeatures `json:"features"`
    Settings        *WorkspaceSettings `json:"settings"`
    EnterpriseID    string            `json:"enterprise_id,omitempty"`
    CreatedAt       time.Time         `json:"created_at"`
}

// WorkspaceFeatures defines plan-specific features
type WorkspaceFeatures struct {
    MessageHistory      int    `json:"message_history"` // -1 = unlimited
    FileStorageGB       int    `json:"file_storage_gb"`
    IntegrationsLimit   int    `json:"integrations_limit"` // -1 = unlimited
    GuestAccess         bool   `json:"guest_access"`
    SingleChannelGuests bool   `json:"single_channel_guests"`
    SharedChannels      bool   `json:"shared_channels"`
    EnterpriseGrid      bool   `json:"enterprise_grid"`
    DataExport          bool   `json:"data_export"`
    CustomRetention     bool   `json:"custom_retention"`
    SSO                 bool   `json:"sso"`
}

// CreateSharedChannel creates a channel shared between workspaces
func (p *WorkspacePlatform) CreateSharedChannel(ctx context.Context, req *SharedChannelRequest) (*Channel, error) {
    // Validate both workspaces have shared channels feature
    sourceWs, err := p.workspaceService.Get(ctx, req.SourceWorkspaceID)
    if err != nil {
        return nil, err
    }

    if !sourceWs.Features.SharedChannels {
        return nil, ErrSharedChannelsNotAvailable
    }

    targetWs, err := p.workspaceService.Get(ctx, req.TargetWorkspaceID)
    if err != nil {
        return nil, err
    }

    if !targetWs.Features.SharedChannels {
        return nil, ErrSharedChannelsNotAvailable
    }

    // Create channel in source workspace
    channel := &Channel{
        ID:          generateChannelID(),
        Name:        req.Name,
        WorkspaceID: req.SourceWorkspaceID,
        IsShared:    true,
        SharedWith:  []string{req.TargetWorkspaceID},
        CreatedAt:   time.Now(),
    }

    if err := p.channelService.Create(ctx, channel); err != nil {
        return nil, err
    }

    // Send invitation to target workspace
    p.sendSharedChannelInvite(ctx, channel, targetWs)

    return channel, nil
}

// InstallApp installs a Slack app to a workspace
func (p *WorkspacePlatform) InstallApp(ctx context.Context, workspaceID, appID string, scopes []string) (*AppInstallation, error) {
    workspace, err := p.workspaceService.Get(ctx, workspaceID)
    if err != nil {
        return nil, err
    }

    // Check integration limit
    currentInstalls := p.appService.GetInstallCount(ctx, workspaceID)
    if workspace.Features.IntegrationsLimit > 0 && currentInstalls >= workspace.Features.IntegrationsLimit {
        return nil, ErrIntegrationLimitReached
    }

    // Get app manifest
    app, err := p.appService.GetApp(ctx, appID)
    if err != nil {
        return nil, err
    }

    // Validate requested scopes
    if err := p.appService.ValidateScopes(app, scopes); err != nil {
        return nil, err
    }

    // Create installation
    installation := &AppInstallation{
        ID:          generateInstallID(),
        AppID:       appID,
        WorkspaceID: workspaceID,
        Scopes:      scopes,
        BotToken:    generateBotToken(),
        InstalledAt: time.Now(),
    }

    if err := p.appService.CreateInstallation(ctx, installation); err != nil {
        return nil, err
    }

    return installation, nil
}
```

### Notion: All-in-One Workspace Platform

Notion's blocks-based collaboration:

```go
// Notion-style blocks-based collaboration platform
package notion

import (
    "context"
    "time"
)

// NotionPlatform manages workspaces and content
type NotionPlatform struct {
    workspaceService *WorkspaceService
    pageService      *PageService
    blockService     *BlockService
    databaseService  *DatabaseService
}

// Block represents a Notion block
type Block struct {
    ID          string            `json:"id"`
    Type        string            `json:"type"` // paragraph, heading, todo, code, table, etc.
    Parent      *ParentRef        `json:"parent"`
    CreatedTime time.Time         `json:"created_time"`
    CreatedBy   *UserRef          `json:"created_by"`
    Properties  map[string]any `json:"properties"`
    Children    []*Block          `json:"children,omitempty"`
    Archived    bool              `json:"archived"`
}

// Database represents a Notion database
type Database struct {
    ID          string                 `json:"id"`
    Title       []*RichText            `json:"title"`
    Properties  map[string]*PropertyDef `json:"properties"`
    Parent      *ParentRef             `json:"parent"`
    IsInline    bool                   `json:"is_inline"`
    CreatedTime time.Time              `json:"created_time"`
}

// CreateDatabasePage adds a row to a database
func (p *NotionPlatform) CreateDatabasePage(ctx context.Context, databaseID string, properties map[string]any) (*Page, error) {
    // Get database
    db, err := p.databaseService.Get(ctx, databaseID)
    if err != nil {
        return nil, err
    }

    // Validate properties against schema
    if err := p.validateProperties(db.Properties, properties); err != nil {
        return nil, err
    }

    // Create page (row)
    page := &Page{
        ID:          generatePageID(),
        Parent:      &ParentRef{Type: "database_id", DatabaseID: databaseID},
        Properties:  properties,
        CreatedTime: time.Now(),
    }

    // Handle relations
    for propName, propDef := range db.Properties {
        if propDef.Type == "relation" {
            if val, ok := properties[propName]; ok {
                // Validate relation exists
                p.validateRelation(ctx, propDef.Relation.DatabaseID, val)
            }
        }
    }

    // Handle rollups (computed)
    for propName, propDef := range db.Properties {
        if propDef.Type == "rollup" {
            page.Properties[propName] = p.computeRollup(ctx, page, propDef.Rollup)
        }
    }

    if err := p.pageService.Create(ctx, page); err != nil {
        return nil, err
    }

    return page, nil
}

// QueryDatabase executes a filtered database query
func (p *NotionPlatform) QueryDatabase(ctx context.Context, databaseID string, query *DatabaseQuery) (*QueryResponse, error) {
    db, err := p.databaseService.Get(ctx, databaseID)
    if err != nil {
        return nil, err
    }

    // Build filter
    filter := p.buildFilter(db, query.Filter)

    // Build sorts
    sorts := p.buildSorts(db, query.Sorts)

    // Execute query
    pages, cursor, err := p.databaseService.Query(ctx, databaseID, filter, sorts, query.PageSize, query.StartCursor)
    if err != nil {
        return nil, err
    }

    return &QueryResponse{
        Results:    pages,
        HasMore:    cursor != "",
        NextCursor: cursor,
    }, nil
}
```

### Key Takeaways from Industry Leaders

The table below summarizes the standout architectural decisions from each company and the scale at which they operate. Notice that every platform found its own approach to multi-tenancy based on its specific requirements, proving there is no single "correct" answer. What they all share is a commitment to strong tenant isolation, flexible scaling strategies, and investing heavily in operational tooling.

| Company | Key Innovation | Scale |
|---------|---------------|-------|
| Stripe | Connect platform, instant payouts | Millions of businesses |
| Salesforce | Metadata-driven, governor limits | 150K+ customers |
| Slack | Shared channels, enterprise grid | 750K+ organizations |
| Notion | Blocks architecture, real-time collab | 30M+ users |

---
