## 62.6 User Preferences

The user preferences service stores and enforces per-user notification opt-in/opt-out settings, ensuring notifications are only delivered through channels the user has enabled and for the notification categories they have subscribed to. Preferences are cached in Redis to avoid a database read on every notification delivery, with a short TTL to ensure preference changes propagate within seconds rather than waiting for a cache expiry. The preference check is a mandatory gate in the notification service, not an optional enhancement, making compliance with user preferences architecturally guaranteed.

```go
// preference/preference_service.go
package preference

import (
    "context"
    "encoding/json"
    "time"

    "github.com/redis/go-redis/v9"
    "yourproject/types"
)

// UserPreferences represents user notification preferences
type UserPreferences struct {
    UserID            string                          `json:"user_id"`
    GlobalEnabled     bool                            `json:"global_enabled"`
    ChannelPrefs      map[types.Channel]ChannelPref   `json:"channel_prefs"`
    TypePrefs         map[string]TypePref             `json:"type_prefs"`
    QuietHours        *QuietHours                     `json:"quiet_hours,omitempty"`
    Timezone          string                          `json:"timezone"`
    UpdatedAt         time.Time                       `json:"updated_at"`
}

// ChannelPref represents preferences for a channel
type ChannelPref struct {
    Enabled     bool `json:"enabled"`
    Frequency   int  `json:"frequency"` // Max notifications per hour
}

// TypePref represents preferences for a notification type
type TypePref struct {
    Enabled  bool            `json:"enabled"`
    Channels []types.Channel `json:"channels"`
}

// QuietHours represents do-not-disturb settings
type QuietHours struct {
    Enabled   bool   `json:"enabled"`
    StartHour int    `json:"start_hour"` // 0-23
    EndHour   int    `json:"end_hour"`   // 0-23
}

// PreferenceService manages user preferences
type PreferenceService struct {
    repo  PreferenceRepository
    cache *redis.Client
    ttl   time.Duration
}

// NewPreferenceService creates a new preference service
func NewPreferenceService(repo PreferenceRepository, cache *redis.Client) *PreferenceService {
    return &PreferenceService{
        repo:  repo,
        cache: cache,
        ttl:   time.Hour,
    }
}

// GetUserPreferences retrieves user preferences
func (s *PreferenceService) GetUserPreferences(ctx context.Context, userID string) (*UserPreferences, error) {
    // Check cache
    cacheKey := "prefs:" + userID
    cached, err := s.cache.Get(ctx, cacheKey).Bytes()
    if err == nil {
        var prefs UserPreferences
        if json.Unmarshal(cached, &prefs) == nil {
            return &prefs, nil
        }
    }

    // Load from database
    prefs, err := s.repo.GetPreferences(ctx, userID)
    if err != nil {
        // Return defaults
        return s.defaultPreferences(userID), nil
    }

    // Cache
    data, _ := json.Marshal(prefs)
    s.cache.Set(ctx, cacheKey, data, s.ttl)

    return prefs, nil
}

// UpdatePreferences updates user preferences
func (s *PreferenceService) UpdatePreferences(ctx context.Context, prefs *UserPreferences) error {
    prefs.UpdatedAt = time.Now()

    if err := s.repo.SavePreferences(ctx, prefs); err != nil {
        return err
    }

    // Invalidate cache
    cacheKey := "prefs:" + prefs.UserID
    s.cache.Del(ctx, cacheKey)

    return nil
}

// GetEnabledChannels returns enabled channels for a notification type
func (p *UserPreferences) GetEnabledChannels(notificationType string) []types.Channel {
    if !p.GlobalEnabled {
        return nil
    }

    // Check type-specific preferences
    if typePref, ok := p.TypePrefs[notificationType]; ok {
        if !typePref.Enabled {
            return nil
        }
        return typePref.Channels
    }

    // Return all enabled channels
    channels := make([]types.Channel, 0)
    for channel, pref := range p.ChannelPrefs {
        if pref.Enabled {
            channels = append(channels, channel)
        }
    }

    return channels
}

// IsInQuietHours checks if current time is within quiet hours
func (p *UserPreferences) IsInQuietHours() bool {
    if p.QuietHours == nil || !p.QuietHours.Enabled {
        return false
    }

    loc, err := time.LoadLocation(p.Timezone)
    if err != nil {
        loc = time.UTC
    }

    now := time.Now().In(loc)
    hour := now.Hour()

    if p.QuietHours.StartHour < p.QuietHours.EndHour {
        return hour >= p.QuietHours.StartHour && hour < p.QuietHours.EndHour
    }

    // Quiet hours span midnight
    return hour >= p.QuietHours.StartHour || hour < p.QuietHours.EndHour
}

func (s *PreferenceService) defaultPreferences(userID string) *UserPreferences {
    return &UserPreferences{
        UserID:        userID,
        GlobalEnabled: true,
        ChannelPrefs: map[types.Channel]ChannelPref{
            types.ChannelEmail: {Enabled: true, Frequency: 10},
            types.ChannelSMS:   {Enabled: true, Frequency: 5},
            types.ChannelPush:  {Enabled: true, Frequency: 20},
            types.ChannelInApp: {Enabled: true, Frequency: 100},
        },
        TypePrefs: make(map[string]TypePref),
        Timezone:  "UTC",
    }
}
```

### Junior -> FAANG: Preferences as a First-Class Gate

Many junior implementations treat user preferences as an afterthought: the notification is sent, then a post-delivery check marks it as "should not have sent." This is backwards. Preferences must be a blocking gate before any notification enters the delivery pipeline, not a post-hoc audit.

The `GlobalEnabled` flag is the master kill switch. If a user sets `GlobalEnabled = false`, no notification of any type should be sent (with the exception of legal/transactional notifications like password resets, which must bypass this flag). Know how to handle this exception cleanly: tag notifications with a `BypassPreferences bool` field, and only set it to `true` for notifications that carry a legal obligation.

The Redis cache with a one-hour TTL is a reasonable default, but understand the staleness implications. A user who opts out of SMS at 9:01 AM may still receive an SMS sent at 9:00 AM that was already in the preference cache (cached at 8:01 AM with a one-hour TTL). This one-hour window is acceptable for most cases but not for "stop sending immediately" opt-outs. For those, the cache should be invalidated on the write path (`s.cache.Del(ctx, cacheKey)`) immediately after the preference update, which the implementation above correctly does.

The `defaultPreferences` function is a defensive pattern. If the preference store is unavailable or the user has no stored preferences, defaulting to all-channels-enabled is appropriate for most notification types but must be documented. Users who set explicit preferences expect them to be honored. If the preference store is down, they may receive notifications they opted out of. The correct production behavior depends on your compliance requirements.

### Senior @ FAANG: Preference Architecture for Millions of Users

**Hierarchical preferences reduce storage and complexity**

The current flat preference model (`ChannelPrefs` and `TypePrefs` as independent maps) does not support inheritance. A user who enables email globally but disables email for marketing type has to express this as two separate preference records. A hierarchical model (global -> category -> channel -> type, with each level inheriting from its parent unless overridden) requires only one record per user level per override, reducing storage by an order of magnitude for users who accept most defaults.

The hierarchical model also simplifies the "enable/disable a category" product feature. Disabling "social notifications" in a flat model requires updating every type within the social category individually. In a hierarchical model, it is a single write to the category level.

**Preference propagation and the compliance window**

GDPR Article 17 (right to erasure) and CAN-SPAM unsubscribe requirements impose a time limit on how long preference changes take to propagate. The current Redis TTL of one hour means a user who unsubscribes from email marketing could receive up to one hour's worth of emails after opting out. This may be acceptable under CAN-SPAM (which gives 10 business days for commercial senders) but is aggressive for GDPR compliance. The production pattern is: on preference update, publish an invalidation event to all notification service instances via Redis Pub/Sub, and each instance deletes the specific user's preference cache key immediately. This reduces the propagation window to under one second.

**Quiet hours as a scheduling problem**

The `IsInQuietHours` method blocks a notification at delivery time if the user is in their quiet hours window. But what happens to the notification? The current implementation returns `nil` channels, effectively dropping it. For non-critical notifications, the correct behavior is to reschedule the notification for the end of the quiet hours window, not drop it. This requires a delay queue: a Redis sorted set of `(notificationID, deliverAt)` pairs that a scheduler goroutine checks periodically. At the end of a quiet hours period, the scheduler dequeues and re-enqueues all held notifications for delivery.

**Preference data model for scale**

At 10M users with an average of 15 preference overrides each, the preference table is 150M rows. Query patterns are: read by user ID (hot path), write on user preference change (infrequent), and bulk read for analytics (infrequent). The correct schema is: a single-row-per-user JSON blob for fast single-user reads (with a JSON index for analytics), plus a normalized relational audit table for the preference change history (who changed what, when, and from which UI). The JSON blob trades query flexibility for read performance, which is the right trade-off given that 99.9% of queries are single-user reads in the hot path.

---
