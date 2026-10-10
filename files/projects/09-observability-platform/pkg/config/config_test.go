package config_test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/example/observability-platform/pkg/config"
)

func TestLoadConfig(t *testing.T) {
	cfgPath := filepath.Join("..", "..", "configs", "config.yaml")
	cfg, err := config.LoadConfig(cfgPath)
	if err != nil {
		t.Fatalf("Failed to load config: %v", err)
	}

	if cfg.Server.HTTPAddr != ":8080" {
		t.Errorf("Expected HTTPAddr :8080, got %s", cfg.Server.HTTPAddr)
	}

	if cfg.Server.GRPCAddr != ":9090" {
		t.Errorf("Expected GRPCAddr :9090, got %s", cfg.Server.GRPCAddr)
	}

	if cfg.Ingestion.Workers <= 0 {
		t.Errorf("Expected positive workers, got %d", cfg.Ingestion.Workers)
	}

	if cfg.Query.QueryTimeout <= 0 {
		t.Errorf("Expected positive query timeout, got %v", cfg.Query.QueryTimeout)
	}
}

func TestConfigValidation(t *testing.T) {
	cfg := &config.Config{
		Server: config.ServerConfig{
			HTTPAddr: "",
		},
		Ingestion: config.IngestionConfig{
			Workers: 5,
		},
	}

	if err := cfg.Validate(); err == nil {
		t.Error("Expected validation error for empty HTTPAddr, got nil")
	}

	cfg.Server.HTTPAddr = ":8080"
	cfg.Server.TLSEnabled = true
	if err := cfg.Validate(); err == nil {
		t.Error("Expected validation error for missing TLS cert/key, got nil")
	}

	cfg.Server.TLSCertFile = "cert.pem"
	cfg.Server.TLSKeyFile = "key.pem"
	cfg.Server.GracefulTimeout = 5 * time.Second
	if err := cfg.Validate(); err != nil {
		t.Errorf("Expected valid config, got %v", err)
	}
}
