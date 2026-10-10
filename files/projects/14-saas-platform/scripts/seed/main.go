// scripts/seed/main.go
// Populates the database with demo tenant, plans, and users for development.
package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"time"

	_ "github.com/lib/pq"
)

func main() {
	dsn := getEnv("DATABASE_URL", "postgres://saas:password@localhost:5432/saas?sslmode=disable")

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		log.Fatalf("ping db: %v", err)
	}

	log.Println("Seeding plans...")
	if err := seedPlans(db); err != nil {
		log.Fatalf("seed plans: %v", err)
	}

	log.Println("Seeding demo tenant...")
	tenantID, err := seedTenant(db)
	if err != nil {
		log.Fatalf("seed tenant: %v", err)
	}

	log.Println("Seeding demo users...")
	if err := seedUsers(db, tenantID); err != nil {
		log.Fatalf("seed users: %v", err)
	}

	log.Println("Seed complete.")
}

func seedPlans(db *sql.DB) error {
	plans := []struct {
		name         string
		displayName  string
		priceMonthly int64
		priceYearly  int64
		trialDays    int
		limits       string
	}{
		{
			"starter", "Starter", 0, 0, 14,
			`{"max_users":5,"max_projects":3,"max_storage_gb":5,"max_api_calls_per_month":10000}`,
		},
		{
			"growth", "Growth", 4900, 47000, 14,
			`{"max_users":25,"max_projects":20,"max_storage_gb":50,"max_api_calls_per_month":250000}`,
		},
		{
			"business", "Business", 14900, 143000, 14,
			`{"max_users":100,"max_projects":100,"max_storage_gb":500,"max_api_calls_per_month":1000000}`,
		},
		{
			"enterprise", "Enterprise", 0, 0, 30,
			`{"max_users":0,"max_projects":0,"max_storage_gb":0,"max_api_calls_per_month":0}`,
		},
	}

	for _, p := range plans {
		_, err := db.Exec(`
			INSERT INTO plans (name, display_name, price_monthly, price_yearly, trial_days, limits)
			VALUES ($1, $2, $3, $4, $5, $6::jsonb)
			ON CONFLICT (name) DO NOTHING`,
			p.name, p.displayName, p.priceMonthly, p.priceYearly, p.trialDays, p.limits,
		)
		if err != nil {
			return fmt.Errorf("insert plan %q: %w", p.name, err)
		}
	}
	return nil
}

func seedTenant(db *sql.DB) (string, error) {
	var planID string
	err := db.QueryRow(`SELECT id FROM plans WHERE name = 'growth'`).Scan(&planID)
	if err != nil {
		return "", fmt.Errorf("find growth plan: %w", err)
	}

	trialEnds := time.Now().Add(14 * 24 * time.Hour)

	var tenantID string
	err = db.QueryRow(`
		INSERT INTO tenants
			(name, slug, subdomain, status, isolation_strategy, plan_id, trial_ends_at, billing_email, settings, branding, features, metadata)
		VALUES
			('Demo Corp', 'demo-corp', 'demo', 'active', 'shared_schema', $1, $2,
			 'admin@democorp.example',
			 '{"timezone":"UTC","language":"en","require_mfa":false,"session_timeout":60}'::jsonb,
			 '{"company_name":"Demo Corp","primary_color":"#6366f1","support_email":"support@democorp.example"}'::jsonb,
			 '{"analytics":true,"api_access":true,"custom_domain":false}'::jsonb,
			 '{}'::jsonb)
		ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
		RETURNING id`,
		planID, trialEnds,
	).Scan(&tenantID)
	if err != nil {
		return "", fmt.Errorf("insert tenant: %w", err)
	}

	log.Printf("  Tenant ID: %s", tenantID)
	return tenantID, nil
}

func seedUsers(db *sql.DB, tenantID string) error {
	// Password hash is bcrypt for "password123" - replace with real hashes in production
	const demoHash = "$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewKyDAXOKHkgFhqa"

	users := []struct {
		email     string
		firstName string
		lastName  string
		role      string
	}{
		{"owner@democorp.example", "Alice", "Owner", "owner"},
		{"admin@democorp.example", "Bob", "Admin", "admin"},
		{"member@democorp.example", "Carol", "Member", "member"},
	}

	for _, u := range users {
		_, err := db.Exec(`
			INSERT INTO users (tenant_id, email, email_verified, password_hash, first_name, last_name, role, status)
			VALUES ($1, $2, TRUE, $3, $4, $5, $6, 'active')
			ON CONFLICT (tenant_id, email) DO NOTHING`,
			tenantID, u.email, demoHash, u.firstName, u.lastName, u.role,
		)
		if err != nil {
			return fmt.Errorf("insert user %q: %w", u.email, err)
		}
		log.Printf("  User: %s (%s)", u.email, u.role)
	}
	return nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
