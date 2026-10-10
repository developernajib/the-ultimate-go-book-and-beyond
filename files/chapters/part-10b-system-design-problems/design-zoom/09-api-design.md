## API Design

The REST API provides endpoints for meeting lifecycle management (create, start, end), while the real-time signaling channel uses WebSockets. This split is intentional: HTTP REST is perfect for one-off requests like creating a meeting, but a persistent WebSocket connection is essential for the continuous back-and-forth of WebRTC negotiation and in-meeting controls. Every endpoint sits behind an authenticated session, and rate limiting on meeting creation and on the join endpoint is not optional: an unthrottled join endpoint lets an attacker walk the ten-digit meeting ID space looking for live meetings.

Notice what the create request does not contain: a host ID. The caller's identity comes from the session token, never from a field the caller fills in. A `host_id` in the request body is an invitation to create meetings in someone else's name, and the same reasoning is why the join path in the Signaling Service reads its user ID from a verified token rather than a header.

```go
package api

import "time"

// POST /api/v1/meetings - Create meeting.
// The host is the authenticated caller, taken from the session token, so
// there is deliberately no HostID field here.
type CreateMeetingRequest struct {
	Title       string          `json:"title" validate:"required,max=300"`
	ScheduledAt *time.Time      `json:"scheduled_at,omitempty"`
	Duration    int             `json:"duration_minutes" validate:"min=1,max=1440"`
	Settings    MeetingSettings `json:"settings"`
}

// CreateMeetingResponse returns the credentials the host shares with
// invitees. The passcode is returned once, at creation, to the host only.
type CreateMeetingResponse struct {
	ID          string     `json:"id"` // 123-456-7890
	PassCode    string     `json:"pass_code"`
	JoinURL     string     `json:"join_url"`
	ScheduledAt *time.Time `json:"scheduled_at,omitempty"`
}

// MeetingSettings mirrors the host-controlled policies stored with the
// meeting. In a real tree this type lives in a shared contract package that
// the API, meeting, and signaling services all import.
type MeetingSettings struct {
	WaitingRoomEnabled bool     `json:"waiting_room_enabled"`
	MaxParticipants    int      `json:"max_participants" validate:"min=1,max=1000"`
	MuteOnEntry        bool     `json:"mute_on_entry"`
	RecordingEnabled   bool     `json:"recording_enabled"`
	E2EEncryption      bool     `json:"e2e_encryption"`
	CoHostIDs          []string `json:"co_host_ids,omitempty"`
}

// POST /api/v1/meetings/{id}/start - Start meeting (host only)
// POST /api/v1/meetings/{id}/end - End meeting (host only)
// POST /api/v1/meetings/{id}/breakout-rooms - Create breakout rooms (host only)
// POST /api/v1/meetings/{id}/recording/start - Start recording (host only)
// GET /api/v1/recordings/{id}/download - Download recording (host or invitee)
// WebSocket /ws/signaling/{meeting_id} - Signaling (token + passcode checked)
```

---
