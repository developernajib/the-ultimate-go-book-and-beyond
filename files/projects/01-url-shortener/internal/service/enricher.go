// internal/service/enricher.go
package service

import (
	"net"
	"strings"

	"github.com/mileusna/useragent"
	"github.com/example/url-shortener/internal/models"
)

// EventEnricher enriches click events with parsed metadata
type EventEnricher struct {
	geoIP GeoIPService
}

// GeoIPService defines geo-location lookup
type GeoIPService interface {
	Lookup(ip string) (country, city string, err error)
}

// NewEventEnricher creates a new event enricher
func NewEventEnricher(geoIP GeoIPService) *EventEnricher {
	return &EventEnricher{
		geoIP: geoIP,
	}
}

// Enrich adds parsed metadata to the event
func (e *EventEnricher) Enrich(event *models.ClickEvent) {
	// Parse user agent
	e.parseUserAgent(event)

	// Lookup geographic location
	e.enrichGeolocation(event)
}

// parseUserAgent extracts device info from user agent
func (e *EventEnricher) parseUserAgent(event *models.ClickEvent) {
	ua := useragent.Parse(event.UserAgent)

	// Determine device type
	if ua.Bot {
		event.DeviceType = "bot"
	} else if ua.Mobile {
		event.DeviceType = "mobile"
	} else if ua.Tablet {
		event.DeviceType = "tablet"
	} else {
		event.DeviceType = "desktop"
	}

	// Extract OS and browser
	event.OS = ua.OS
	event.Browser = ua.Name
}

// enrichGeolocation adds geographic data
func (e *EventEnricher) enrichGeolocation(event *models.ClickEvent) {
	// Skip if invalid IP
	if event.IPAddress == "" || event.IPAddress == "::1" ||
		strings.HasPrefix(event.IPAddress, "127.") {
		return
	}

	// Lookup location
	country, city, err := e.geoIP.Lookup(event.IPAddress)
	if err == nil {
		event.CountryCode = country
		event.City = city
	}
}

// MockGeoIPService is a simple mock for development
type MockGeoIPService struct{}

func (m *MockGeoIPService) Lookup(ip string) (string, string, error) {
	// In production, use MaxMind GeoIP2 or similar
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		return "", "", nil
	}

	// Mock data for demo
	return "US", "New York", nil
}
