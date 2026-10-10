package parser

import (
	"testing"
)

func TestParser_ParseValidPipeline(t *testing.T) {
	yamlData := `
name: ci-build
on:
  push:
    branches:
      - main
stages:
  - name: test
    jobs:
      - name: unit-test
        image: golang:1.24-alpine
        steps:
          - name: run tests
            run: go test ./...
`
	p := NewParser(false)
	cfg, err := p.Parse([]byte(yamlData))
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}

	if cfg.Name != "ci-build" {
		t.Errorf("expected name 'ci-build', got %q", cfg.Name)
	}
	if len(cfg.Stages) != 1 {
		t.Fatalf("expected 1 stage, got %d", len(cfg.Stages))
	}
	if len(cfg.Stages[0].Jobs) != 1 {
		t.Fatalf("expected 1 job, got %d", len(cfg.Stages[0].Jobs))
	}
	if cfg.Stages[0].Jobs[0].Name != "unit-test" {
		t.Errorf("expected job name 'unit-test', got %s", cfg.Stages[0].Jobs[0].Name)
	}
}

func TestValidator_ImageAndNames(t *testing.T) {
	v := NewValidator()
	v.SetAllowedImages([]string{"golang:", "alpine:latest"})

	if err := v.ValidateImage("golang:1.24"); err != nil {
		t.Errorf("expected golang:1.24 to be allowed: %v", err)
	}
	if err := v.ValidateImage("python:3.11"); err == nil {
		t.Errorf("expected python:3.11 to be rejected")
	}

	if err := v.ValidateJobName("test-job_1"); err != nil {
		t.Errorf("expected valid job name: %v", err)
	}
	if err := v.ValidateJobName("test job!"); err == nil {
		t.Errorf("expected invalid job name to fail")
	}

	if err := v.ValidateSecretName("DB_PASSWORD"); err != nil {
		t.Errorf("expected valid secret name: %v", err)
	}
	if err := v.ValidateSecretName("db_password"); err == nil {
		t.Errorf("expected lowercase secret name to fail")
	}
}
