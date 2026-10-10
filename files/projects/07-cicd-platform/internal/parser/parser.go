package parser

import (
	"fmt"
	"maps"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Parser parses pipeline YAML files
type Parser struct {
	strict bool // Enable strict validation
}

// NewParser creates a new pipeline parser
func NewParser(strict bool) *Parser {
	return &Parser{strict: strict}
}

// Parse parses a pipeline YAML file
func (p *Parser) Parse(data []byte) (*PipelineConfig, error) {
	var config PipelineConfig

	// Use strict unmarshaling to catch unknown fields
	decoder := yaml.NewDecoder(strings.NewReader(string(data)))
	decoder.KnownFields(p.strict)

	if err := decoder.Decode(&config); err != nil {
		return nil, fmt.Errorf("parse yaml: %w", err)
	}

	// Validate the parsed configuration
	if err := p.validate(&config); err != nil {
		return nil, fmt.Errorf("validate pipeline: %w", err)
	}

	// Apply defaults
	p.applyDefaults(&config)

	return &config, nil
}

// ParseFile parses a pipeline YAML file from disk
func (p *Parser) ParseFile(filename string) (*PipelineConfig, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}

	return p.Parse(data)
}

// validate performs validation on the parsed configuration
func (p *Parser) validate(config *PipelineConfig) error {
	if config.Name == "" {
		return fmt.Errorf("pipeline name is required")
	}

	if len(config.Stages) == 0 {
		return fmt.Errorf("at least one stage is required")
	}

	// Validate each stage
	stageNames := make(map[string]bool)
	for i, stage := range config.Stages {
		if stage.Name == "" {
			return fmt.Errorf("stage %d: name is required", i)
		}

		// Check for duplicate stage names
		if stageNames[stage.Name] {
			return fmt.Errorf("duplicate stage name: %s", stage.Name)
		}
		stageNames[stage.Name] = true

		// Validate jobs in stage
		if len(stage.Jobs) == 0 {
			return fmt.Errorf("stage %s: at least one job is required", stage.Name)
		}

		jobNames := make(map[string]bool)
		for j, job := range stage.Jobs {
			if job.Name == "" {
				return fmt.Errorf("stage %s, job %d: name is required", stage.Name, j)
			}

			// Check for duplicate job names within stage
			if jobNames[job.Name] {
				return fmt.Errorf("stage %s: duplicate job name: %s", stage.Name, job.Name)
			}
			jobNames[job.Name] = true

			// Validate image
			if job.Image == "" {
				return fmt.Errorf("stage %s, job %s: image is required", stage.Name, job.Name)
			}

			// Validate steps
			if len(job.Steps) == 0 {
				return fmt.Errorf("stage %s, job %s: at least one step is required", stage.Name, job.Name)
			}

			for k, step := range job.Steps {
				if step.Run == "" {
					return fmt.Errorf("stage %s, job %s, step %d: run command is required", stage.Name, job.Name, k)
				}
			}

			// Validate timeout
			if job.Timeout < 0 {
				return fmt.Errorf("stage %s, job %s: timeout must be non-negative", stage.Name, job.Name)
			}

			// Validate retry
			if job.Retry != nil {
				if job.Retry.Max < 0 {
					return fmt.Errorf("stage %s, job %s: retry max must be non-negative", stage.Name, job.Name)
				}
				if job.Retry.Backoff < 0 {
					return fmt.Errorf("stage %s, job %s: retry backoff must be non-negative", stage.Name, job.Name)
				}
			}
		}
	}

	// Validate job dependencies (depends_on)
	allJobs := p.collectAllJobs(config)
	for _, stage := range config.Stages {
		for _, job := range stage.Jobs {
			for _, dep := range job.DependsOn {
				if !allJobs[dep] {
					return fmt.Errorf("job %s: dependency %s not found", job.Name, dep)
				}
			}
		}
	}

	return nil
}

// applyDefaults applies default values to the configuration
func (p *Parser) applyDefaults(config *PipelineConfig) {
	// Apply global env to all jobs if not overridden
	for i := range config.Stages {
		stage := &config.Stages[i]

		// Default parallel to 1 (sequential)
		if stage.Parallel == 0 {
			stage.Parallel = 1
		}

		for j := range stage.Jobs {
			job := &stage.Jobs[j]

			// Merge global env with job env (job env takes precedence)
			if job.Env == nil {
				job.Env = make(map[string]string)
			}
			for k, v := range config.Env {
				if _, exists := job.Env[k]; !exists {
					job.Env[k] = v
				}
			}

			// Default timeout to 30 minutes
			if job.Timeout == 0 {
				job.Timeout = 30 * time.Minute
			}

			// Default shell to /bin/sh
			for k := range job.Steps {
				step := &job.Steps[k]
				if step.Shell == "" {
					step.Shell = "/bin/sh"
				}
			}

			// Default artifact expiration to 30 days
			if job.Artifacts != nil && job.Artifacts.ExpireIn == 0 {
				job.Artifacts.ExpireIn = 30 * 24 * time.Hour
			}
		}
	}
}

// collectAllJobs creates a map of all job names in the pipeline
func (p *Parser) collectAllJobs(config *PipelineConfig) map[string]bool {
	jobs := make(map[string]bool)
	for _, stage := range config.Stages {
		for _, job := range stage.Jobs {
			jobs[job.Name] = true
		}
	}
	return jobs
}

// ExpandVariables expands variable references in the configuration
// Supports ${VAR} and ${VAR:default} syntax
func (p *Parser) ExpandVariables(config *PipelineConfig, vars map[string]string) {
	// Merge config variables with provided vars
	allVars := make(map[string]string)
	maps.Copy(allVars, config.Variables)
	maps.Copy(allVars, vars)

	// Expand variables in all string fields
	for i := range config.Stages {
		stage := &config.Stages[i]
		stage.Condition = p.expandString(stage.Condition, allVars)

		for j := range stage.Jobs {
			job := &stage.Jobs[j]
			job.Image = p.expandString(job.Image, allVars)
			job.Condition = p.expandString(job.Condition, allVars)

			// Expand env values
			for k, v := range job.Env {
				job.Env[k] = p.expandString(v, allVars)
			}

			// Expand steps
			for k := range job.Steps {
				step := &job.Steps[k]
				step.Run = p.expandString(step.Run, allVars)
				step.WorkDir = p.expandString(step.WorkDir, allVars)

				for envKey, envVal := range step.Env {
					step.Env[envKey] = p.expandString(envVal, allVars)
				}
			}
		}
	}
}

// expandString expands variables in a string
func (p *Parser) expandString(s string, vars map[string]string) string {
	result := s

	// Simple variable expansion: ${VAR} or ${VAR:default}
	for strings.Contains(result, "${") {
		start := strings.Index(result, "${")
		end := strings.Index(result[start:], "}")
		if end == -1 {
			break // Malformed variable reference
		}
		end += start

		varRef := result[start+2 : end]
		varName := varRef
		defaultVal := ""

		// Check for default value syntax: ${VAR:default}
		if before, after, ok := strings.Cut(varRef, ":"); ok {
			varName = before
			defaultVal = after
		}

		// Replace with value or default
		val, exists := vars[varName]
		if !exists {
			val = defaultVal
		}

		result = result[:start] + val + result[end+1:]
	}

	return result
}
