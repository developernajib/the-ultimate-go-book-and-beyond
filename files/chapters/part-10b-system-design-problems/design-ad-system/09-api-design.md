## API Design

### REST Endpoints

These API endpoints define how advertisers, publishers, and the auction system interact with the platform. The most latency-sensitive endpoint is the auction bid endpoint, which must complete within 100ms. Campaign management endpoints (create, update, stats) have more relaxed latency requirements but must enforce strict input validation and authorization. Notice how tracking endpoints use lightweight designs (redirect-based clicks, pixel-based impressions) to minimize impact on the user's browsing experience.

```go
package api

import (
	"time"
)

// POST /api/v1/auction/bid - SSP calls this to initiate RTB auction
// Request: OpenRTB BidRequest
// Response: BidResponse with winning ad markup
// Latency SLA: < 100ms end-to-end

// POST /api/v1/campaigns - Create a new advertising campaign
type CreateCampaignRequest struct {
	AdvertiserID string            `json:"advertiser_id" validate:"required"`
	Name         string            `json:"name" validate:"required,max=300"`
	DailyBudget  float64           `json:"daily_budget" validate:"gt=0"`
	TotalBudget  float64           `json:"total_budget" validate:"gt=0"`
	CPMBid       float64           `json:"cpm_bid" validate:"gt=0"`
	Targeting    TargetingConfig   `json:"targeting"`
	StartDate    time.Time         `json:"start_date"`
	EndDate      time.Time         `json:"end_date"`
	Creatives    []CreativeConfig  `json:"creatives"`
}

type TargetingConfig struct {
	Countries      []string `json:"countries"`
	Cities         []string `json:"cities"`
	AgeMin         int      `json:"age_min"`
	AgeMax         int      `json:"age_max"`
	Genders        []string `json:"genders"`
	Interests      []string `json:"interests"`
	Devices        []string `json:"devices"`
	Languages      []string `json:"languages"`
	HoursOfDay     []int    `json:"hours_of_day"`
	DaysOfWeek     []int    `json:"days_of_week"`
	Keywords       []string `json:"keywords"`
	ExcludeDomains []string `json:"exclude_domains"`
}

type CreativeConfig struct {
	Format         string   `json:"format"`
	Width          int      `json:"width"`
	Height         int      `json:"height"`
	ContentURL     string   `json:"content_url"`
	ClickURL       string   `json:"click_url"`
	TrackingPixels []string `json:"tracking_pixels"`
}

// GET /api/v1/campaigns/{id}/stats - Campaign performance metrics
type CampaignStatsResponse struct {
	CampaignID  string  `json:"campaign_id"`
	Impressions int64   `json:"impressions"`
	Clicks      int64   `json:"clicks"`
	Conversions int64   `json:"conversions"`
	CTR         float64 `json:"ctr"`
	CVR         float64 `json:"cvr"`
	SpendToday  float64 `json:"spend_today"`
	SpendTotal  float64 `json:"spend_total"`
	AvgCPM      float64 `json:"avg_cpm"`
	AvgCPC      float64 `json:"avg_cpc"`
	ROAS        float64 `json:"roas"`
}

// PUT /api/v1/campaigns/{id}/budget - Update campaign budget
// GET  /api/v1/track/impression - Track ad impression (pixel callback)
// GET  /api/v1/track/click - Track ad click (redirect endpoint)
// POST /api/v1/track/conversion - Track conversion (advertiser postback)
// GET /api/v1/reports/campaign/{id} - Campaign report with grouping
// POST /api/v1/creatives/upload - Upload ad creative
// GET /api/v1/publisher/{id}/earnings - Publisher revenue report
```

---
