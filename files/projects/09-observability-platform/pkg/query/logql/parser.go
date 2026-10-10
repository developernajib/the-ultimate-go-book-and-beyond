// pkg/query/logql/parser.go
package logql

import (
	"fmt"
	"strings"
	"time"

	"github.com/example/observability-platform/pkg/models"
)

// Parser parses LogQL queries
type Parser struct{}

// ParseQuery parses a LogQL query string
// Example: {service="api"} |= "error" | json | level="error"
func (p *Parser) ParseQuery(queryStr string, start, end time.Time) (*models.LogQuery, error) {
	query := &models.LogQuery{
		StartTime: start,
		EndTime:   end,
		Labels:    make(models.Labels, 0),
	}

	// Split into stream selector and filters
	parts := strings.Split(queryStr, "|")
	if len(parts) == 0 {
		return nil, fmt.Errorf("invalid query")
	}

	// Parse stream selector: {label="value", ...}
	selector := strings.TrimSpace(parts[0])
	if err := p.parseStreamSelector(selector, query); err != nil {
		return nil, err
	}

	// Parse filters
	for i := 1; i < len(parts); i++ {
		filter := strings.TrimSpace(parts[i])
		if err := p.parseFilter(filter, query); err != nil {
			return nil, err
		}
	}

	return query, nil
}

// parseStreamSelector parses the stream selector
func (p *Parser) parseStreamSelector(selector string, query *models.LogQuery) error {
	// Remove braces
	selector = strings.TrimPrefix(selector, "{")
	selector = strings.TrimSuffix(selector, "}")

	if selector == "" {
		return nil
	}

	// Split by comma
	pairs := strings.SplitSeq(selector, ",")
	for pair := range pairs {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}

		// Parse key=value or key="value"
		parts := strings.SplitN(pair, "=", 2)
		if len(parts) != 2 {
			return fmt.Errorf("invalid label selector: %s", pair)
		}

		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		value = strings.Trim(value, `"`)

		// Handle special fields
		switch key {
		case "service":
			query.Service = value
		case "host":
			query.Host = value
		case "namespace":
			query.Namespace = value
		case "level":
			level := models.ParseLogLevel(value)
			query.Level = &level
		case "trace_id":
			query.TraceID = value
		default:
			query.Labels = append(query.Labels, models.Label{
				Name:  key,
				Value: value,
			})
		}
	}

	return nil
}

// parseFilter parses a filter expression
func (p *Parser) parseFilter(filter string, query *models.LogQuery) error {
	filter = strings.TrimSpace(filter)

	// Line filter: |= "text" or != "text" or |~ "regex" or !~ "regex"
	if strings.HasPrefix(filter, "=") || strings.HasPrefix(filter, "~") {
		op := filter[0:1]
		text := strings.TrimSpace(filter[1:])
		text = strings.Trim(text, `"`)

		if op == "=" {
			// Contains filter
			query.SearchQuery = text
		} else {
			// Regex filter
			// Store for later processing
			query.SearchQuery = text
		}

		return nil
	}

	// JSON parser
	if filter == "json" {
		// Enable JSON parsing
		return nil
	}

	// Label filter: label="value"
	parts := strings.SplitN(filter, "=", 2)
	if len(parts) == 2 {
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		value = strings.Trim(value, `"`)

		query.Labels = append(query.Labels, models.Label{
			Name:  key,
			Value: value,
		})
		return nil
	}

	return fmt.Errorf("unknown filter: %s", filter)
}
