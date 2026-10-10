## Deep Dive: Queue and Playback State Management

Playback state management is what powers Spotify Connect: control music from any device, and move playback between your phone, laptop, and smart speaker without losing your place. The state (which track, position, shuffle mode, queue) lives in Redis for fast access, and Redis Pub/Sub notifies every connected device the moment it changes, so pausing on your phone greys out the play button on your desktop.

The thing that makes this harder than it looks is that the state is shared mutable data with several concurrent writers, and the writers are on different continents. The naive implementation reads the state, modifies it in Go, and writes it back. That is a read-modify-write race, and it loses data whenever two devices act at once. Your phone adds a song to the queue while your laptop skips a track: both read the same state, both write their own version back, and the last writer silently erases the other's change. The queue addition just vanishes, with no error anywhere.

Note that last-write-wins is the correct policy for a scalar like volume, where the newest command genuinely should win. It is the wrong policy for the queue, where "add a track" is not a new value but a modification of the old one. That distinction is what the compare-and-swap below enforces: `Watch` aborts the transaction if anyone else touched the key since the read, and the retry loop re-reads and re-applies the change to the state that actually exists now. Same reason `PopNext` cannot be a plain read-then-write: two devices asking for the next track at the same moment would both receive the same one, and the queue would lose an entry.

```go
package playback

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"time"

	"github.com/redis/go-redis/v9"
)

type CatalogService interface {
	TracksForContext(ctx context.Context, contextURI string) ([]string, error)
}

// PlaybackStateService manages real-time playback state across devices.
type PlaybackStateService struct {
	rdb     *redis.Client
	catalog CatalogService // resolves a context URI to its track list
}

const (
	stateTTL    = 30 * time.Minute
	maxCASTries = 5
)

type PlaybackState struct {
	UserID     string    `json:"user_id"`
	DeviceID   string    `json:"device_id"`
	DeviceName string    `json:"device_name"`
	TrackID    string    `json:"track_id"`
	PositionMs int       `json:"position_ms"`
	IsPlaying  bool      `json:"is_playing"`
	Shuffle    bool      `json:"shuffle"`
	RepeatMode string    `json:"repeat_mode"` // off, track, context
	Volume     int       `json:"volume"`      // 0-100
	Queue      []string  `json:"queue"`       // user-queued track IDs
	ContextURI string    `json:"context_uri"` // playlist, album, artist radio
	Order      []string  `json:"order"`       // resolved play order for the context
	Cursor     int       `json:"cursor"`      // position within Order
	UpdatedAt  time.Time `json:"updated_at"`
}

func stateKey(userID string) string  { return fmt.Sprintf("playback:%s", userID) }
func eventsKey(userID string) string { return fmt.Sprintf("playback:events:%s", userID) }

// GetState returns the current playback state for a user.
func (s *PlaybackStateService) GetState(ctx context.Context, userID string) (*PlaybackState, error) {
	data, err := s.rdb.Get(ctx, stateKey(userID)).Bytes()
	if err != nil {
		return nil, err
	}
	var state PlaybackState
	// Checked: a corrupt blob would otherwise return a zero-valued state, which
	// reads as "nothing playing, volume 0" and would then be written back.
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("decode playback state for %s: %w", userID, err)
	}
	return &state, nil
}

// mutate applies fn to the user's playback state atomically, then publishes the
// result. Watch fails the transaction if another writer touched the key between
// our read and our write, so we re-read and re-apply rather than clobbering.
func (s *PlaybackStateService) mutate(ctx context.Context, userID string, fn func(*PlaybackState) error) (*PlaybackState, error) {
	key := stateKey(userID)
	var out *PlaybackState

	txf := func(tx *redis.Tx) error {
		data, err := tx.Get(ctx, key).Bytes()
		if err != nil {
			return err
		}
		var state PlaybackState
		if err := json.Unmarshal(data, &state); err != nil {
			return fmt.Errorf("decode playback state: %w", err)
		}
		if err := fn(&state); err != nil {
			return err
		}
		state.UpdatedAt = time.Now()

		encoded, err := json.Marshal(state)
		if err != nil {
			return err
		}
		// Both commands run only if the key was untouched since tx.Get.
		_, err = tx.TxPipelined(ctx, func(p redis.Pipeliner) error {
			p.Set(ctx, key, encoded, stateTTL)
			p.Publish(ctx, eventsKey(userID), encoded)
			return nil
		})
		if err == nil {
			out = &state
		}
		return err
	}

	for i := 0; i < maxCASTries; i++ {
		err := s.rdb.Watch(ctx, txf, key)
		if err == nil {
			return out, nil
		}
		if errors.Is(err, redis.TxFailedErr) {
			continue // another device won the race, re-read and re-apply
		}
		return nil, err
	}
	return nil, fmt.Errorf("playback state for %s contended after %d attempts", userID, maxCASTries)
}

// TransferPlayback moves playback to another device, keeping the position.
func (s *PlaybackStateService) TransferPlayback(ctx context.Context, userID, toDeviceID string) error {
	_, err := s.mutate(ctx, userID, func(st *PlaybackState) error {
		st.DeviceID = toDeviceID
		return nil
	})
	return err
}

// AddToQueue appends a track to the user's up-next queue.
func (s *PlaybackStateService) AddToQueue(ctx context.Context, userID, trackID string) error {
	_, err := s.mutate(ctx, userID, func(st *PlaybackState) error {
		st.Queue = append(st.Queue, trackID)
		return nil
	})
	return err
}

// PopNext advances playback and returns the track to play. The advance and the
// read happen inside one CAS, so two devices racing cannot receive the same
// track or drop a queue entry.
func (s *PlaybackStateService) PopNext(ctx context.Context, userID string) (string, error) {
	var next string

	_, err := s.mutate(ctx, userID, func(st *PlaybackState) error {
		// Repeat-one wins and does not consume the queue.
		if st.RepeatMode == "track" && st.TrackID != "" {
			next = st.TrackID
			return nil
		}

		// An explicitly queued track outranks the context.
		if len(st.Queue) > 0 {
			next = st.Queue[0]
			st.Queue = st.Queue[1:]
			st.TrackID, st.PositionMs = next, 0
			return nil
		}

		// Otherwise walk the resolved context order.
		if st.Cursor+1 < len(st.Order) {
			st.Cursor++
		} else if st.RepeatMode == "context" && len(st.Order) > 0 {
			// Reshuffle on wrap, so a repeating shuffled playlist does not
			// replay the identical order forever.
			if st.Shuffle {
				st.Order = shuffleTracks(st.Order)
			}
			st.Cursor = 0
		} else {
			return errNoNextTrack
		}

		next = st.Order[st.Cursor]
		st.TrackID, st.PositionMs = next, 0
		return nil
	})
	if err != nil {
		return "", err
	}
	return next, nil
}

var errNoNextTrack = errors.New("end of context")

// SetShuffle toggles shuffle and rebuilds the play order.
//
// The order is materialized once and stored, not recomputed per track. Picking
// a random unplayed track on each advance cannot implement "previous", makes
// the up-next list unshowable, and re-randomizes whenever state is rebuilt.
func (s *PlaybackStateService) SetShuffle(ctx context.Context, userID string, on bool) error {
	_, err := s.mutate(ctx, userID, func(st *PlaybackState) error {
		tracks, err := s.catalog.TracksForContext(ctx, st.ContextURI)
		if err != nil {
			return err
		}
		st.Shuffle = on
		if on {
			st.Order = shuffleTracks(tracks)
		} else {
			st.Order = tracks
		}
		// Keep playing the current track: point the cursor at it in the new order.
		st.Cursor = indexOf(st.Order, st.TrackID)
		return nil
	})
	return err
}

// shuffleTracks returns a uniformly random permutation via Fisher-Yates.
//
// Every permutation is equally likely, and getting this loop wrong is a classic
// bug: iterating upward and swapping with rand.Intn(len(a)) instead of
// rand.Intn(i+1) produces a biased distribution that still looks shuffled.
//
// Worth knowing that Spotify does not ship this. They ran Fisher-Yates for
// years and users kept reporting the shuffle was broken, because a uniformly
// random order clusters: with five songs each by four artists, some artist will
// usually land three in a row, and true randomness feels non-random to people.
// Spotify's published fix borrows from Floyd-Steinberg dithering, spreading
// each artist's tracks evenly across the playlist and then jittering the
// offsets, so no artist clumps. Uniformity was never the product requirement,
// it was the assumption. Fisher-Yates is the right primitive and the right
// default. Just know which property you are optimizing for.
func shuffleTracks(tracks []string) []string {
	out := make([]string, len(tracks))
	copy(out, tracks) // do not shuffle the caller's slice in place
	for i := len(out) - 1; i > 0; i-- {
		j := rand.Intn(i + 1) // must be i+1, not len(out)
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func indexOf(xs []string, target string) int {
	for i, x := range xs {
		if x == target {
			return i
		}
	}
	return 0
}
```

---
