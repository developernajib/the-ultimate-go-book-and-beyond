## Go Implementation: Venue Configuration

Before tickets can be sold, the system must initialize the seat inventory for a specific event at a specific venue. This service takes a venue layout (sections, rows, seats per row) and creates corresponding records in both PostgreSQL (durable, authoritative) and Redis (the fast availability cache). The initialization happens once when an event is created, and the bulk insert uses PostgreSQL's `unnest` to load tens of thousands of seats in a single statement rather than one round trip per seat.

The ordering is deliberate: PostgreSQL first, Redis second. Seeding the cache first means that if the insert then fails, Redis is advertising seats that do not exist in the database, every hold on them succeeds, and every confirm fails on a `status = 'available'` predicate that has no row to match. Populating the source of truth first makes the worst case a cold cache, which reconciliation repairs on its next pass.

```go
package venue

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// VenueService manages venue layouts and seat inventory
type VenueService struct {
	db  *pgxpool.Pool
	rdb *redis.Client
}

type Venue struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Address  string         `json:"address"`
	City     string         `json:"city"`
	Capacity int            `json:"capacity"`
	Sections []VenueSection `json:"sections"`
}

type VenueSection struct {
	Name        string `json:"name"`
	Tier        string `json:"tier"` // VIP, Floor, GA, Balcony
	Rows        int    `json:"rows"`
	SeatsPerRow int    `json:"seats_per_row"`
	Capacity    int    `json:"capacity"`
}

// defaultPriceCents applies when an event does not price a tier explicitly.
const defaultPriceCents int64 = 10_000 // $100.00

func (vs *VenueService) getVenue(ctx context.Context, venueID string) (*Venue, error) {
	return &Venue{
		ID:       venueID,
		Name:     "Sample Arena",
		Capacity: 20000,
		Sections: []VenueSection{
			{Name: "Floor", Tier: "Floor", Rows: 20, SeatsPerRow: 25, Capacity: 500},
			{Name: "101", Tier: "Lower", Rows: 30, SeatsPerRow: 30, Capacity: 900},
		},
	}, nil
}

// InitializeEventInventory creates seat records for a new event.
// Called when an event is created: seeds PostgreSQL, then Redis.
func (vs *VenueService) InitializeEventInventory(ctx context.Context, eventID, venueID string, priceTiers map[string]int64) error {
	venue, err := vs.getVenue(ctx, venueID)
	if err != nil {
		return err
	}

	// unnest takes one array per column, so the rows are built as parallel
	// slices. Flattening every seat's fields into a single []any and passing
	// it as args instead sends 6*N positional parameters to a statement that
	// declares six, and PostgreSQL rejects the whole insert.
	n := venue.Capacity
	ids := make([]string, 0, n)
	sections := make([]string, 0, n)
	rows := make([]string, 0, n)
	numbers := make([]int32, 0, n)
	tiers := make([]string, 0, n)
	prices := make([]int64, 0, n)

	for _, section := range venue.Sections {
		// Comma-ok, so that a tier explicitly priced at 0 (a comp or a
		// giveaway) is honored rather than silently re-priced at $100.
		price, ok := priceTiers[section.Tier]
		if !ok {
			price = defaultPriceCents
		}

		for row := 0; row < section.Rows; row++ {
			label := rowLabel(row)
			for seat := 1; seat <= section.SeatsPerRow; seat++ {
				ids = append(ids, fmt.Sprintf("%s-%s-%d", section.Name, label, seat))
				sections = append(sections, section.Name)
				rows = append(rows, label)
				numbers = append(numbers, int32(seat))
				tiers = append(tiers, section.Tier)
				prices = append(prices, price)
			}
		}
	}

	// Source of truth first. eventID is a bound parameter, not interpolated
	// into the statement text.
	_, err = vs.db.Exec(ctx, `
		INSERT INTO seats (id, event_id, section, row, seat_number, tier, price_cents, status)
		SELECT t.id, $1, t.section, t.row, t.seat_number, t.tier, t.price_cents, 'available'
		FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::bigint[])
		     AS t(id, section, row, seat_number, tier, price_cents)`,
		eventID, ids, sections, rows, numbers, tiers, prices)
	if err != nil {
		return fmt.Errorf("insert seats: %w", err)
	}

	// Then the cache, in chunks. One pipeline holding 100K commands buffers
	// the entire venue in memory on both ends before anything is sent.
	seatKey := fmt.Sprintf("seats:%s", eventID)
	const chunk = 1000
	for start := 0; start < len(ids); start += chunk {
		end := min(start+chunk, len(ids))
		fields := make([]any, 0, (end-start)*2)
		for _, id := range ids[start:end] {
			fields = append(fields, id, "available")
		}
		if err := vs.rdb.HSet(ctx, seatKey, fields...).Err(); err != nil {
			// The seats exist and are sellable - the cache is merely cold.
			// Reconciliation rebuilds it from PostgreSQL.
			return fmt.Errorf("seed seat cache (seats are committed): %w", err)
		}
	}

	return nil
}

// rowLabel converts a zero-based row index into a venue row label:
// 0 -> A, 25 -> Z, 26 -> AA, 27 -> AB.
//
// The obvious string(rune('A'+row)) works right up to row 26, where it starts
// emitting '[', '\', ']' and produces seat IDs like "FLOOR-[-12". Plenty of
// venues have more than 26 rows in a section.
func rowLabel(row int) string {
	var sb strings.Builder
	var buf []byte
	for row >= 0 {
		buf = append([]byte{byte('A' + row%26)}, buf...)
		row = row/26 - 1
	}
	sb.Write(buf)
	return sb.String()
}

// GetAvailabilitySummary returns a quick overview for the event listing page.
//
// This scans every seat in the venue, so it is not something to call per
// request during a sale: the listing page should read the cached snapshot from
// the seat map service instead. It is fine for admin views and for
// reconciliation checks.
func (vs *VenueService) GetAvailabilitySummary(ctx context.Context, eventID string) (map[string]int, error) {
	seats, err := vs.rdb.HGetAll(ctx, fmt.Sprintf("seats:%s", eventID)).Result()
	if err != nil {
		return nil, err
	}

	summary := map[string]int{
		"available": 0,
		"held":      0,
		"sold":      0,
		"total":     len(seats),
	}

	for _, status := range seats {
		switch {
		case status == "available":
			summary["available"]++
		case strings.HasPrefix(status, "held:"):
			summary["held"]++
		case strings.HasPrefix(status, "sold:"):
			summary["sold"]++
		}
	}

	return summary, nil
}
```

---
