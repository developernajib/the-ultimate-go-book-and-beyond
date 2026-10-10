package parser

import (
	"fmt"
	"regexp"
	"strings"
)

// Validator provides additional validation rules
type Validator struct {
	allowedImages map[string]bool
	maxTimeout    int // seconds
}

// NewValidator creates a new validator
func NewValidator() *Validator {
	return &Validator{
		allowedImages: make(map[string]bool),
		maxTimeout:    7200, // 2 hours default
	}
}

// SetAllowedImages restricts which Docker images can be used
func (v *Validator) SetAllowedImages(images []string) {
	v.allowedImages = make(map[string]bool)
	for _, img := range images {
		v.allowedImages[img] = true
	}
}

// SetMaxTimeout sets the maximum allowed job timeout
func (v *Validator) SetMaxTimeout(seconds int) {
	v.maxTimeout = seconds
}

// ValidateImage checks if an image is allowed
func (v *Validator) ValidateImage(image string) error {
	// If no allowed images specified, allow all
	if len(v.allowedImages) == 0 {
		return nil
	}

	// Check exact match
	if v.allowedImages[image] {
		return nil
	}

	// Check prefix match (e.g., "golang:" matches "golang:1.26")
	for allowed := range v.allowedImages {
		if strings.HasSuffix(allowed, ":") && strings.HasPrefix(image, allowed) {
			return nil
		}
	}

	return fmt.Errorf("image %s is not allowed", image)
}

// ValidateCondition validates a condition expression
func (v *Validator) ValidateCondition(condition string) error {
	if condition == "" {
		return nil
	}

	// Simple validation: check for allowed syntax
	// In production, use a proper expression parser
	allowed := regexp.MustCompile(`^[\w\s\(\)&|!=<>'"]+$`)
	if !allowed.MatchString(condition) {
		return fmt.Errorf("invalid condition syntax: %s", condition)
	}

	return nil
}

// ValidateJobName validates a job name
func (v *Validator) ValidateJobName(name string) error {
	// Job names must be valid identifiers
	validName := regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
	if !validName.MatchString(name) {
		return fmt.Errorf("invalid job name: %s (must contain only alphanumeric, underscore, hyphen)", name)
	}

	if len(name) > 255 {
		return fmt.Errorf("job name too long: %s (max 255 characters)", name)
	}

	return nil
}

// ValidateSecretName validates a secret name
func (v *Validator) ValidateSecretName(name string) error {
	validName := regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
	if !validName.MatchString(name) {
		return fmt.Errorf("invalid secret name: %s (must be uppercase with underscores)", name)
	}

	return nil
}
