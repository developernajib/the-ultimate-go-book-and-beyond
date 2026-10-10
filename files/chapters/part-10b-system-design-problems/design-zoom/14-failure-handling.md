## Failure Handling

In a real-time system like video conferencing, server failures are especially disruptive because participants experience an immediate call drop rather than a slow page load. The failover strategy detects when a media server goes down, finds all meetings it was hosting, and migrates each one to a healthy server. Participants receive a migration signal through the signaling channel and automatically reconnect to the new server. To avoid losing participants during the brief migration window, the system holds their slot for 30 seconds, showing a "Reconnecting..." status to other attendees.

```go
package failover

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// ServerPool hands out healthy media servers, excluding the one that died.
type ServerPool interface {
	FindAvailable(ctx context.Context, exclude string) (string, error)
}

type MediaServerFailover struct {
	rdb  *redis.Client
	pool ServerPool
}

type migrationSignal struct {
	Type      string `json:"type"`
	NewServer string `json:"new_server"`
}

func (f *MediaServerFailover) HandleServerDown(ctx context.Context, failed string) error {
	// Do not discard this error. On a Redis blip SMembers returns an empty
	// slice, the loop body never runs, and the function reports success
	// while every meeting on the dead server stays pointed at it.
	meetings, err := f.rdb.SMembers(ctx, fmt.Sprintf("server:meetings:%s", failed)).Result()
	if err != nil {
		return fmt.Errorf("list meetings on %s: %w", failed, err)
	}

	var errs []error
	for _, mid := range meetings {
		newServer, err := f.pool.FindAvailable(ctx, failed)
		if err != nil {
			errs = append(errs, fmt.Errorf("meeting %s: %w", mid, err))
			continue
		}

		if err := f.rdb.HSet(ctx,
			fmt.Sprintf("meeting:active:%s", mid), "media_server", newServer).Err(); err != nil {
			errs = append(errs, fmt.Errorf("meeting %s: repoint: %w", mid, err))
			continue
		}

		// Marshal the signal rather than splicing newServer into a JSON
		// string with Sprintf. A server address carrying a quote would
		// break out of the literal and inject arbitrary fields into a
		// message every client in the meeting parses.
		payload, err := json.Marshal(migrationSignal{
			Type:      "server_migration",
			NewServer: newServer,
		})
		if err != nil {
			errs = append(errs, err)
			continue
		}

		if err := f.rdb.Publish(ctx,
			fmt.Sprintf("meeting:signal:%s", mid), payload).Err(); err != nil {
			// The pointer moved but nobody was told. Clients still find
			// the new server on their reconnect timer, just slower.
			errs = append(errs, fmt.Errorf("meeting %s: signal: %w", mid, err))
		}
	}

	// Report partial failure. Returning nil unconditionally means the
	// caller retries nothing and the alert never fires.
	return errors.Join(errs...)
}

// Client reconnection: hold participant slot for 30s, resume on reconnect.
// Other participants see "Reconnecting..." status.
```

One caveat this code does not solve. "Server is down" is a guess: a health check that fails may mean a dead server or just a partitioned one. If the media server is alive and still holding participants, this migration produces two servers serving one meeting. For media that is survivable, since the worst case is a few seconds of duplicate or split audio until clients converge on the address in Redis. It would not be survivable if the same logic guarded something that must not run twice, like billing the meeting or writing the recording, which is why the recording pipeline keys its output on a single recording ID rather than on whichever server believes it is in charge.

---
