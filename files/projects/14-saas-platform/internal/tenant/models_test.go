package tenant

import (
	"testing"
)

func TestJSONBValueAndScan(t *testing.T) {
	data := JSONB{"foo": "bar", "count": float64(10)}
	val, err := data.Value()
	if err != nil {
		t.Fatalf("JSONB.Value failed: %v", err)
	}

	var scanned JSONB
	if err := scanned.Scan(val); err != nil {
		t.Fatalf("JSONB.Scan failed: %v", err)
	}

	if scanned["foo"] != "bar" {
		t.Errorf("expected foo=bar, got %v", scanned["foo"])
	}

	// Test scan nil
	var nilScanned JSONB
	if err := nilScanned.Scan(nil); err != nil {
		t.Fatalf("JSONB.Scan(nil) failed: %v", err)
	}
	if nilScanned == nil {
		t.Error("expected non-nil map after scanning nil")
	}
}

func TestTenantSettingsValueAndScan(t *testing.T) {
	settings := TenantSettings{
		Timezone:   "America/New_York",
		Language:   "en",
		RequireMFA: true,
	}

	val, err := settings.Value()
	if err != nil {
		t.Fatalf("TenantSettings.Value failed: %v", err)
	}

	var scanned TenantSettings
	if err := scanned.Scan(val); err != nil {
		t.Fatalf("TenantSettings.Scan failed: %v", err)
	}

	if scanned.Timezone != "America/New_York" || !scanned.RequireMFA {
		t.Errorf("scanned mismatch: %+v", scanned)
	}
}

func TestFeatureFlagsValueAndScan(t *testing.T) {
	flags := FeatureFlags{
		"analytics": true,
		"beta_ui":   false,
	}

	val, err := flags.Value()
	if err != nil {
		t.Fatalf("FeatureFlags.Value failed: %v", err)
	}

	var scanned FeatureFlags
	if err := scanned.Scan(val); err != nil {
		t.Fatalf("FeatureFlags.Scan failed: %v", err)
	}

	if !scanned["analytics"] || scanned["beta_ui"] {
		t.Errorf("scanned mismatch: %+v", scanned)
	}
}

func TestPlanLimitsValueAndScan(t *testing.T) {
	limits := PlanLimits{
		MaxUsers:            100,
		MaxStorageGB:        500,
		MaxAPICallsPerMonth: 1000000,
	}

	val, err := limits.Value()
	if err != nil {
		t.Fatalf("PlanLimits.Value failed: %v", err)
	}

	var scanned PlanLimits
	if err := scanned.Scan(val); err != nil {
		t.Fatalf("PlanLimits.Scan failed: %v", err)
	}

	if scanned.MaxUsers != 100 || scanned.MaxStorageGB != 500 {
		t.Errorf("scanned mismatch: %+v", scanned)
	}
}
