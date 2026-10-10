## Production Go Implementation: Contact Sync Service

Contact sync is the feature that lets WhatsApp discover which of your phone contacts are already registered on the platform. The client sends its address book to the server, the server matches against registered users and returns the profiles of those who match, filtering out anyone who has blocked the requester.

**Do not claim that hashing the phone numbers makes this private.** It is a tempting story, and it is wrong, and an interviewer who knows the area will pounce on it. Hashing protects a secret only when the input space is too large to search. A phone number is at most ten digits, so the entire space is around 10^10 candidates. Unsalted SHA-256 runs at a few million hashes per second on one CPU core and billions per second on a GPU, which puts an exhaustive reversal of every possible number at hours on a laptop and seconds on rented hardware. The attacker does not even need the full space: area codes and prefixes are public, so the practical search is thousands of candidates per target. A SHA-256 of a phone number is an *encoding* of that phone number, not a protection of it, and salting cannot save you either, since the server must match hashes across users and therefore needs a salt every client shares, which is no salt at all.

So be accurate about what this design does: the server learns your entire address book, including the numbers of people who have never installed the app. That is a real and frequently criticized privacy cost, and it is the reason genuine solutions are hard. Private set intersection protocols let two parties compute an intersection without either learning the rest, and Signal's private contact discovery pushes the matching into a hardware enclave so the operator cannot observe it. Both are expensive and involved. The honest interview answer is to name the cost and describe the real mitigation, rather than to hash the input and call it solved.

The implementation below focuses on the two things a plain lookup must get right regardless: the requester's identity comes from the session and never from the payload, and the block filter fails closed.

```go
package contacts

import (
	"context"
	"fmt"
)

const maxContactsPerSync = 5000

// ContactSyncService matches phone contacts with registered users.
type ContactSyncService struct {
	userDB UserStore
}

// ContactSyncRequest carries only the address book. It deliberately has no
// UserID field: the requester is taken from the authenticated session. A
// caller-supplied identity here would let anyone sync "as" someone else and
// walk straight through that person's block list.
type ContactSyncRequest struct {
	Phones []string `json:"phones" validate:"required,max=5000,dive,e164"`
}

type ContactSyncResponse struct {
	Matches []ContactMatch `json:"matches"`
}

type ContactMatch struct {
	Phone     string `json:"phone"`
	UserID    string `json:"user_id"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
	About     string `json:"about"`
}

// SyncContacts finds which of the caller's phone contacts are registered.
//
// requesterID comes from the session, not the request body.
func (s *ContactSyncService) SyncContacts(ctx context.Context, requesterID string, req ContactSyncRequest) (*ContactSyncResponse, error) {
	// Bound the batch. This endpoint turns a list of phone numbers into a list
	// of real accounts, which makes it an enumeration oracle: without a cap and
	// a per-user rate limit above it, one caller walks the whole number space
	// and harvests every profile on the platform.
	if len(req.Phones) == 0 {
		return &ContactSyncResponse{}, nil
	}
	if len(req.Phones) > maxContactsPerSync {
		return nil, fmt.Errorf("too many contacts: %d, max %d", len(req.Phones), maxContactsPerSync)
	}

	matches, err := s.userDB.FindByPhones(ctx, req.Phones)
	if err != nil {
		return nil, fmt.Errorf("find contacts: %w", err)
	}
	if len(matches) == 0 {
		return &ContactSyncResponse{}, nil
	}

	// One batched query for the block relationships, not one per match. At an
	// address book of 5,000 that N+1 is 5,000 round trips per sync.
	ids := make([]string, 0, len(matches))
	for _, m := range matches {
		ids = append(ids, m.UserID)
	}
	blocked, err := s.userDB.BlockedBy(ctx, ids, requesterID)
	if err != nil {
		// Fail closed. The original returned a bare bool from IsBlocked, so a
		// database error became "not blocked" and the service leaked the
		// profiles of exactly the people who asked not to be seen. When an
		// authorization check errors, deny.
		return nil, fmt.Errorf("check blocks: %w", err)
	}

	result := make([]ContactMatch, 0, len(matches))
	for _, m := range matches {
		if blocked[m.UserID] {
			continue
		}
		if m.UserID == requesterID {
			continue // your own number is not a discovery
		}
		result = append(result, ContactMatch{
			Phone:     m.Phone,
			UserID:    m.UserID,
			Name:      m.Name,
			AvatarURL: m.AvatarURL,
			About:     m.About,
		})
	}

	return &ContactSyncResponse{Matches: result}, nil
}
```

---
