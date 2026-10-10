## Deep Dive: Real-Time Reporting Pipeline

Advertisers need to see how their campaigns are performing in near-real time so they can adjust bids, budgets, and targeting. The reporting service queries ClickHouse to aggregate impressions, clicks, conversions, and spend across multiple dimensions (day, geography, device, creative, publisher). ClickHouse is ideal here because its columnar storage and vectorized query execution can scan billions of rows in seconds. The service also computes derived metrics like CTR (click-through rate), CPA (cost per acquisition), and ROAS (return on ad spend) that advertisers use to evaluate campaign effectiveness. Materialized views in ClickHouse pre-aggregate hourly metrics so that dashboard queries return instantly without scanning raw event data.

```go
package reporting

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
)

// ReportingService provides real-time and historical campaign analytics
type ReportingService struct {
	conn clickhouse.Conn
}

// CampaignReport contains aggregated metrics for a campaign
type CampaignReport struct {
	CampaignID   string             `json:"campaign_id"`
	Period       string             `json:"period"`
	Summary      CampaignSummary    `json:"summary"`
	ByDay        []DailyMetrics     `json:"by_day"`
	ByGeo        []GeoMetrics       `json:"by_geo"`
	ByDevice     []DeviceMetrics    `json:"by_device"`
	ByCreative   []CreativeMetrics  `json:"by_creative"`
	ByPublisher  []PublisherMetrics `json:"by_publisher"`
}

type CampaignSummary struct {
	Impressions    int64   `json:"impressions"`
	ViewableImps   int64   `json:"viewable_impressions"`
	Clicks         int64   `json:"clicks"`
	Conversions    int64   `json:"conversions"`
	Spend          float64 `json:"spend"`
	CTR            float64 `json:"ctr"`
	CVR            float64 `json:"cvr"`
	ViewabilityRate float64 `json:"viewability_rate"`
	AvgCPM         float64 `json:"avg_cpm"`
	AvgCPC         float64 `json:"avg_cpc"`
	CPA            float64 `json:"cpa"`
	ROAS           float64 `json:"roas"`
	FraudRate      float64 `json:"fraud_rate"`
}

type DailyMetrics struct {
	Date        string  `json:"date"`
	Impressions int64   `json:"impressions"`
	Clicks      int64   `json:"clicks"`
	Spend       float64 `json:"spend"`
	CTR         float64 `json:"ctr"`
}

type GeoMetrics struct {
	Country     string  `json:"country"`
	Impressions int64   `json:"impressions"`
	Clicks      int64   `json:"clicks"`
	CTR         float64 `json:"ctr"`
	Spend       float64 `json:"spend"`
}

type DeviceMetrics struct {
	DeviceType  string  `json:"device_type"` // mobile, desktop, tablet
	Impressions int64   `json:"impressions"`
	Clicks      int64   `json:"clicks"`
	CTR         float64 `json:"ctr"`
}

type CreativeMetrics struct {
	CreativeID  string  `json:"creative_id"`
	Impressions int64   `json:"impressions"`
	Clicks      int64   `json:"clicks"`
	CTR         float64 `json:"ctr"`
	Spend       float64 `json:"spend"`
}

type PublisherMetrics struct {
	PublisherID string  `json:"publisher_id"`
	Domain      string  `json:"domain"`
	Impressions int64   `json:"impressions"`
	Clicks      int64   `json:"clicks"`
	CTR         float64 `json:"ctr"`
	Spend       float64 `json:"spend"`
	FraudRate   float64 `json:"fraud_rate"`
}

// GetCampaignReport generates a comprehensive report for a campaign
func (s *ReportingService) GetCampaignReport(ctx context.Context, campaignID string, start, end time.Time) (*CampaignReport, error) {
	report := &CampaignReport{
		CampaignID: campaignID,
		Period:     fmt.Sprintf("%s to %s", start.Format("2006-01-02"), end.Format("2006-01-02")),
	}

	// Summary query
	err := s.conn.QueryRow(ctx, `
		SELECT
			countIf(event_type = 'impression' AND is_fraud = 0) AS impressions,
			countIf(event_type = 'impression' AND is_viewable = 1 AND is_fraud = 0) AS viewable_imps,
			countIf(event_type = 'click' AND is_fraud = 0) AS clicks,
			countIf(event_type = 'conversion' AND is_fraud = 0) AS conversions,
			sumIf(cost, event_type = 'impression' AND is_fraud = 0) AS spend,
			countIf(is_fraud = 1) / count() AS fraud_rate
		FROM ad_events
		WHERE campaign_id = $1
		  AND timestamp BETWEEN $2 AND $3`,
		campaignID, start, end,
	).Scan(
		&report.Summary.Impressions,
		&report.Summary.ViewableImps,
		&report.Summary.Clicks,
		&report.Summary.Conversions,
		&report.Summary.Spend,
		&report.Summary.FraudRate,
	)
	if err != nil {
		return nil, err
	}

	// Compute derived metrics
	if report.Summary.Impressions > 0 {
		report.Summary.CTR = float64(report.Summary.Clicks) / float64(report.Summary.Impressions)
		report.Summary.ViewabilityRate = float64(report.Summary.ViewableImps) / float64(report.Summary.Impressions)
		report.Summary.AvgCPM = report.Summary.Spend / float64(report.Summary.Impressions) * 1000
	}
	if report.Summary.Clicks > 0 {
		report.Summary.CVR = float64(report.Summary.Conversions) / float64(report.Summary.Clicks)
		report.Summary.AvgCPC = report.Summary.Spend / float64(report.Summary.Clicks)
	}
	if report.Summary.Conversions > 0 {
		report.Summary.CPA = report.Summary.Spend / float64(report.Summary.Conversions)
	}

	// Daily breakdown
	rows, err := s.conn.Query(ctx, `
		SELECT
			toDate(timestamp) AS day,
			countIf(event_type = 'impression') AS impressions,
			countIf(event_type = 'click') AS clicks,
			sumIf(cost, event_type = 'impression') AS spend
		FROM ad_events
		WHERE campaign_id = $1 AND timestamp BETWEEN $2 AND $3 AND is_fraud = 0
		GROUP BY day
		ORDER BY day`,
		campaignID, start, end,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var dm DailyMetrics
		var day time.Time
		rows.Scan(&day, &dm.Impressions, &dm.Clicks, &dm.Spend)
		dm.Date = day.Format("2006-01-02")
		if dm.Impressions > 0 {
			dm.CTR = float64(dm.Clicks) / float64(dm.Impressions)
		}
		report.ByDay = append(report.ByDay, dm)
	}

	// Geo breakdown
	geoRows, err := s.conn.Query(ctx, `
		SELECT
			country,
			countIf(event_type = 'impression') AS impressions,
			countIf(event_type = 'click') AS clicks,
			sumIf(cost, event_type = 'impression') AS spend
		FROM ad_events
		WHERE campaign_id = $1 AND timestamp BETWEEN $2 AND $3 AND is_fraud = 0
		GROUP BY country
		ORDER BY impressions DESC
		LIMIT 20`,
		campaignID, start, end,
	)
	if err == nil {
		defer geoRows.Close()
		for geoRows.Next() {
			var gm GeoMetrics
			geoRows.Scan(&gm.Country, &gm.Impressions, &gm.Clicks, &gm.Spend)
			if gm.Impressions > 0 {
				gm.CTR = float64(gm.Clicks) / float64(gm.Impressions)
			}
			report.ByGeo = append(report.ByGeo, gm)
		}
	}

	return report, nil
}

// MaterializedViews for real-time aggregation (created once in ClickHouse)
/*
CREATE MATERIALIZED VIEW campaign_hourly_mv
ENGINE = SummingMergeTree()
ORDER BY (campaign_id, hour)
AS SELECT
    campaign_id,
    toStartOfHour(timestamp) AS hour,
    countIf(event_type = 'impression') AS impressions,
    countIf(event_type = 'click') AS clicks,
    sum(cost) AS spend
FROM ad_events
GROUP BY campaign_id, hour;
*/
```

---
