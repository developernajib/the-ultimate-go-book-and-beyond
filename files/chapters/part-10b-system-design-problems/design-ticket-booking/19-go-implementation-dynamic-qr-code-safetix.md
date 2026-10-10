## Go Implementation: Dynamic QR Code (SafeTix)

Static QR codes have a major security flaw: anyone who screenshots a ticket can duplicate it. Ticketmaster's SafeTix addresses this by generating QR codes that rotate on a short interval (the production system refreshes roughly every 15 seconds, this implementation uses 30-second windows to keep the arithmetic readable). The code includes a time-window component in its HMAC signature, so a screenshot stops validating once its window passes. The venue scanner accepts both the current and previous time windows to account for clock skew between the user's phone and the scanner device, which means a given code is good for somewhere between 30 and 60 seconds depending on where in its window it was captured.

Be precise about what this does and does not buy, because it is easy to oversell. Rotation defeats the screenshot *forwarded to a friend last night*. It does nothing about the screenshot forwarded thirty seconds ago: inside the accepted window, a copied code verifies exactly like the original, because it is the original. What stops two people walking in on one ticket is the one-time scan, the conditional `UPDATE ... WHERE is_used = false` at the gate. Rotation shrinks the window of usefulness for a stolen code from days to under a minute. The database is still what enforces one seat, one admission.

```go
package delivery

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

// SafeTixGenerator creates rotating QR codes that change every 30 seconds
// This prevents screenshots from being used as valid tickets
type SafeTixGenerator struct {
	secret []byte
}

type SafeTixCode struct {
	TicketID string `json:"ticket_id"`
	EventID  string `json:"event_id"`
	UserID   string `json:"user_id"`
	// Window is the 30-second bucket index the signature was minted for, not a
	// wall-clock timestamp. Naming it Timestamp invites a reader to compare it
	// against time.Now().Unix(), which is off by a factor of 30.
	Window    int64  `json:"window"`
	Signature string `json:"signature"`
}

// GenerateCode creates a time-based QR code payload
// Valid for 30-second window
func (g *SafeTixGenerator) GenerateCode(ticketID, eventID, userID string) *SafeTixCode {
	// Round timestamp to 30-second window
	window := time.Now().Unix() / 30

	code := &SafeTixCode{
		TicketID: ticketID,
		EventID:  eventID,
		UserID:   userID,
		Window:   window,
	}

	// HMAC signature includes window -- changes every 30 seconds
	payload := fmt.Sprintf("%s:%s:%s:%d", ticketID, eventID, userID, window)
	mac := hmac.New(sha256.New, g.secret)
	mac.Write([]byte(payload))
	code.Signature = hex.EncodeToString(mac.Sum(nil))[:20]

	return code
}

// ValidateCode checks a scanned QR code
// Accepts current window and previous window (tolerance for clock skew)
func (g *SafeTixGenerator) ValidateCode(code *SafeTixCode) bool {
	currentWindow := time.Now().Unix() / 30

	// Accept current and previous window
	for _, window := range []int64{currentWindow, currentWindow - 1} {
		payload := fmt.Sprintf("%s:%s:%s:%d", code.TicketID, code.EventID, code.UserID, window)
		mac := hmac.New(sha256.New, g.secret)
		mac.Write([]byte(payload))
		expected := hex.EncodeToString(mac.Sum(nil))[:20]

		if hmac.Equal([]byte(expected), []byte(code.Signature)) {
			return true
		}
	}
	return false
}
```

---
