## Deep Dive: Real-Time Location Streaming

Once a driver is matched to a rider, the rider's app needs to show the driver's car moving on the map in real time. This is achieved through a WebSocket connection that pushes the driver's latest GPS coordinates to the rider. The streamer recalculates the ETA with each update so the rider sees a continuously improving arrival estimate.

Start with the push interval, because the obvious answer is wrong. Pushing every 2 seconds sounds twice as smooth as pushing every 4, and it is not: drivers report every 4 seconds, so every second push carries coordinates the rider already has. You cannot stream information you have not received. Doubling the tick doubles the frames, the wakeups, and the bandwidth across 3M rider connections in exchange for nothing. Smooth animation is the client's job: it interpolates between fixes, which it must do anyway, since even a 2 second update would still show a car teleporting between points.

The rest of this component is about surviving 8M connections and a network that lies to you.

```go
package streaming

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Drivers report every 4s. Pushing faster resends what we already sent.
	streamInterval = 4 * time.Second
	writeTimeout   = 10 * time.Second
	pongTimeout    = 60 * time.Second
	pingInterval   = (pongTimeout * 9) / 10 // must be comfortably under pongTimeout
)

// safeConn serializes writes to one websocket connection.
//
// gorilla/websocket allows at most one concurrent reader and one concurrent
// writer, and it does not enforce this for you. The location ticker and the
// keepalive pinger below are two writers on the same connection, so without
// this mutex their frames interleave and corrupt the stream. Corrupted frames
// do not fail cleanly, they desynchronize the protocol, and the bug surfaces
// later as a nonsense parse error on a client you cannot reproduce locally.
type safeConn struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (c *safeConn) write(msgType int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	// A write with no deadline blocks forever against a client that stopped
	// reading but never closed (a phone that drove into a tunnel). The
	// goroutine and its buffers are pinned until the OS gives up, which can be
	// many minutes. Multiply by a fraction of 8M connections and the gateway
	// exhausts memory while every health check still reports green.
	if err := c.conn.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return err
	}
	return c.conn.WriteMessage(msgType, data)
}

type TripStreamer struct {
	locSvc LocationService
	etaSvc ETAService
	log    *slog.Logger
}

// Stream pushes the driver's position to one rider until the trip ends or the
// connection dies.
func (s *TripStreamer) Stream(ctx context.Context, conn *websocket.Conn, driverID string, dLat, dLng float64) {
	sc := &safeConn{conn: conn}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer conn.Close()

	// A TCP connection to a phone that lost signal stays open indefinitely from
	// our side: no FIN ever arrives. Ping/pong is the only way to learn the peer
	// is gone. Every pong pushes the read deadline out, and when they stop
	// arriving the read below fails and takes the whole stream down with it.
	conn.SetReadDeadline(time.Now().Add(pongTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongTimeout))
	})

	// The read pump exists even though riders send nothing. Gorilla only
	// processes control frames (pong, close) from inside a read call, so
	// without this loop the pong handler never runs and the deadline never
	// advances. A stream with no reader cannot detect a dead peer.
	go func() {
		defer cancel()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return // peer gone, closed, or read deadline expired
			}
		}
	}()

	go s.keepalive(ctx, sc)

	ticker := time.NewTicker(streamInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.push(ctx, sc, driverID, dLat, dLng); err != nil {
				s.log.DebugContext(ctx, "stream ended", "driver", driverID, "err", err)
				return
			}
		}
	}
}

func (s *TripStreamer) push(ctx context.Context, sc *safeConn, driverID string, dLat, dLng float64) error {
	loc, err := s.locSvc.GetDriver(ctx, driverID)
	if err != nil {
		// A stale read is not fatal to the stream. Skip this tick and try again
		// in 4s rather than tearing down the rider's map.
		s.log.DebugContext(ctx, "driver location unavailable", "driver", driverID, "err", err)
		return nil
	}

	update := LocationUpdate{DriverLat: loc.Lat, DriverLng: loc.Lng, Heading: loc.Heading}

	// The ETA is a nice-to-have, the position is the point. Discarding this
	// error and reading eta.DurationSeconds anyway would dereference nil the
	// first time the routing API times out, panicking the goroutine and
	// dropping the rider's live map over a service that was merely slow.
	eta, err := s.etaSvc.PredictETA(ctx, ETARequest{
		OriginLat: loc.Lat, OriginLng: loc.Lng,
		DestLat: dLat, DestLng: dLng,
		RequestAt: time.Now(),
	})
	if err != nil {
		s.log.DebugContext(ctx, "eta unavailable, sending position only", "err", err)
	} else {
		update.EtaMinutes = float64(eta.DurationSeconds) / 60
	}

	data, err := json.Marshal(update)
	if err != nil {
		return err
	}
	return sc.write(websocket.TextMessage, data)
}

func (s *TripStreamer) keepalive(ctx context.Context, sc *safeConn) {
	t := time.NewTicker(pingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			// Goes through safeConn: this is the second writer the mutex exists for.
			if err := sc.write(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
```

If the connection drops, the client reconnects and resumes. Design the resume to be stateless: the rider's app reconnects, names the trip, and receives the current position. Do not try to replay the fixes it missed. Nobody wants to watch where the car used to be.

---
