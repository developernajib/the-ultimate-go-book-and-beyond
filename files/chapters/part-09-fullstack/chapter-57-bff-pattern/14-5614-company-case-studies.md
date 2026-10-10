## 57.13 Company Case Studies

### SoundCloud: BFF for Mobile Apps

As documented in Phil Calçado's foundational architecture report (*"BFF @ SoundCloud"*, SoundCloud Backstage Engineering Blog, 2015), SoundCloud's mobile app must stream audio while displaying album art, waveforms, and social data, all over cellular connections that vary from 5G to spotty 3G. Their mobile BFF adapts the response payload based on the client's reported network quality, reducing image resolution, audio bitrate, and the number of prefetched tracks for slower connections. The implementation below demonstrates network-adaptive quality selection and CDN-optimized URL generation for batch track playback.

```go
// soundcloud/pkg/bff/mobile/stream.go
// SoundCloud-style optimized streaming responses
package mobile

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "strings"
    "sync"
    "time"
)

// StreamBFF optimizes track and playlist data for mobile
type StreamBFF struct {
    trackClient    *TrackClient
    userClient     *UserClient
    playlistClient *PlaylistClient
    cdnService     *CDNService
    cache          *BFFCache
}

// MobileTrack has minimal fields for mobile playback
type MobileTrack struct {
    ID           string  `json:"id"`
    Title        string  `json:"title"`           // Truncated to 50 chars
    Artist       string  `json:"artist"`
    ArtistID     string  `json:"artist_id"`
    ArtworkURL   string  `json:"artwork"`         // 200x200 thumbnail
    Duration     int     `json:"duration_ms"`
    StreamURL    string  `json:"stream_url"`      // CDN-optimized URL
    WaveformURL  string  `json:"waveform"`        // Low-res waveform
    LikeCount    int     `json:"likes"`
    PlayCount    int     `json:"plays"`
    IsLiked      bool    `json:"is_liked"`
    Quality      string  `json:"quality"`         // Based on network
}

// GetStreamFeed returns an optimized feed for mobile
func (b *StreamBFF) GetStreamFeed(
    ctx context.Context,
    userID string,
    networkQuality string,
) (*StreamFeedResponse, error) {
    var wg sync.WaitGroup
    var mu sync.Mutex
    resp := &StreamFeedResponse{}

    // Determine quality settings based on network
    quality := b.determineQuality(networkQuality)

    // Parallel fetch with graceful degradation
    wg.Add(3)

    // 1. Get personalized track recommendations
    go func() {
        defer wg.Done()
        tracks, err := b.getRecommendedTracks(ctx, userID, quality)
        mu.Lock()
        if err == nil {
            resp.Tracks = tracks
        }
        mu.Unlock()
    }()

    // 2. Get followed artists' recent tracks
    go func() {
        defer wg.Done()
        recent, err := b.getFollowingRecent(ctx, userID, quality)
        mu.Lock()
        if err == nil {
            resp.Following = recent
        }
        mu.Unlock()
    }()

    // 3. Get user's liked tracks for offline hint
    go func() {
        defer wg.Done()
        likes, err := b.getUserLikes(ctx, userID, quality)
        mu.Lock()
        if err == nil {
            resp.Liked = likes
        }
        mu.Unlock()
    }()

    wg.Wait()

    // Add quality metadata
    resp.Quality = quality
    resp.CDNHint = b.cdnService.GetNearestEdge(ctx)

    return resp, nil
}

func (b *StreamBFF) determineQuality(network string) QualitySettings {
    switch network {
    case "wifi", "5g":
        return QualitySettings{
            AudioBitrate: 320,
            ArtworkSize:  500,
            WaveformRes:  "high",
            Prefetch:     5,
        }
    case "4g", "lte":
        return QualitySettings{
            AudioBitrate: 128,
            ArtworkSize:  200,
            WaveformRes:  "medium",
            Prefetch:     3,
        }
    case "3g", "slow":
        return QualitySettings{
            AudioBitrate: 64,
            ArtworkSize:  100,
            WaveformRes:  "low",
            Prefetch:     1,
        }
    default:
        return QualitySettings{
            AudioBitrate: 128,
            ArtworkSize:  200,
            WaveformRes:  "medium",
            Prefetch:     2,
        }
    }
}

func (b *StreamBFF) transformTrack(
    track *FullTrack,
    quality QualitySettings,
    userLikes map[string]bool,
) *MobileTrack {
    // Truncate title for mobile display
    title := track.Title
    if len(title) > 50 {
        title = title[:47] + "..."
    }

    // Get appropriate artwork size
    artworkURL := b.cdnService.ResizeImage(
        track.ArtworkURL,
        quality.ArtworkSize,
    )

    // Get streaming URL with quality
    streamURL := b.cdnService.GetStreamURL(
        track.ID,
        quality.AudioBitrate,
    )

    return &MobileTrack{
        ID:          track.ID,
        Title:       title,
        Artist:      track.User.Username,
        ArtistID:    track.User.ID,
        ArtworkURL:  artworkURL,
        Duration:    track.DurationMS,
        StreamURL:   streamURL,
        WaveformURL: track.WaveformURL,
        LikeCount:   track.LikesCount,
        PlayCount:   track.PlaybackCount,
        IsLiked:     userLikes[track.ID],
        Quality:     fmt.Sprintf("%dkbps", quality.AudioBitrate),
    }
}

// BatchStreamURLs returns optimized URLs for a list of tracks
// Mobile clients request this before playback for seamless streaming
func (b *StreamBFF) BatchStreamURLs(
    ctx context.Context,
    trackIDs []string,
    quality string,
) (map[string]StreamInfo, error) {
    // Check cache first
    cacheKey := fmt.Sprintf("stream_urls:%s:%s", quality, strings.Join(trackIDs, ","))
    var cached map[string]StreamInfo
    if err := b.cache.Get(ctx, cacheKey, &cached); err == nil {
        return cached, nil
    }

    // Get CDN-signed URLs in batch
    urls := make(map[string]StreamInfo)

    for _, id := range trackIDs {
        info := StreamInfo{
            URL:       b.cdnService.GetSignedURL(id, quality, 1*time.Hour),
            ExpiresAt: time.Now().Add(1 * time.Hour),
            Quality:   quality,
        }
        urls[id] = info
    }

    // Cache for 30 minutes (URLs valid for 1 hour)
    b.cache.Set(ctx, cacheKey, urls, 30*time.Minute)

    return urls, nil
}
```

### Netflix: Experience API (XP API) Architecture

As detailed in the Netflix Technology Blog (*"Optimizing the Netflix API"*, 2012; *"Engineering Trade-Offs and The Netflix API"*, 2013), Netflix calls their device-specific BFFs "Experience APIs" (XP APIs). The TV XP API faces a unique constraint: TV remotes have limited input, so the home screen must be immediately useful with no typing. The XP API assembles personalized content rows with prioritized parallel fetching, where billboard and continue-watching load first (high priority), above-the-fold rows load second, and below-the-fold rows are pre-cached asynchronously for instant display when the user scrolls. The implementation below also integrates A/B test assignments to vary row ordering and content selection per experiment.

```go
// netflix/pkg/xp/tv.go
// Netflix-style Experience API for TV devices
package xp

import (
    "context"
    "fmt"
    "sort"
    "sync"
    "time"
)

// TVXP is the Experience API for TV devices
type TVXP struct {
    catalogClient     *CatalogClient
    personalizeClient *PersonalizationClient
    playbackClient    *PlaybackClient
    imageService      *ImageService
    abService         *ABTestService
    cache             *XPCache
}

// TVHomeScreen returns the optimized home screen for TV
type TVHomeScreen struct {
    Rows       []*Row           `json:"rows"`
    Billboard  *BillboardItem   `json:"billboard"`
    Continue   []*ContinueItem  `json:"continue_watching"`
    MyList     []*TitleCard     `json:"my_list"`
    NetflixID  string           `json:"profile_id"`
}

// Row represents a single row on the home screen
type Row struct {
    ID          string       `json:"id"`
    Title       string       `json:"title"`
    Items       []*TitleCard `json:"items"`
    DisplayType string       `json:"type"`  // "standard", "top10", "billboard"
}

// TitleCard has TV-optimized data
type TitleCard struct {
    ID           string            `json:"id"`
    Title        string            `json:"title"`
    Synopsis     string            `json:"synopsis"`     // Short for TV display
    BoxArtURL    string            `json:"box_art"`      // 16:9 for TV
    LogoURL      string            `json:"logo"`         // Title treatment
    MaturityRating string          `json:"maturity"`
    Year         int               `json:"year"`
    Duration     string            `json:"duration"`     // "1h 45m" format
    Tags         []string          `json:"tags"`
    VideoPreview *VideoPreview     `json:"preview,omitempty"`
}

// GetHomeScreen assembles the TV home screen
func (xp *TVXP) GetHomeScreen(
    ctx context.Context,
    profileID string,
    deviceInfo DeviceInfo,
) (*TVHomeScreen, error) {
    start := time.Now()
    defer func() {
        metrics.RecordLatency("tv_xp_home", time.Since(start))
    }()

    // Get A/B test assignments for this profile
    experiments := xp.abService.GetAssignments(ctx, profileID)

    // Determine row configuration based on experiments
    rowConfig := xp.getRowConfig(experiments)

    var wg sync.WaitGroup
    var mu sync.Mutex
    home := &TVHomeScreen{
        NetflixID: profileID,
        Rows:      make([]*Row, 0, len(rowConfig)),
    }

    // Fetch rows in parallel with prioritization
    highPriorityDone := make(chan struct{})

    // High priority: Billboard and Continue Watching
    wg.Add(2)

    go func() {
        defer wg.Done()
        billboard := xp.getBillboard(ctx, profileID, deviceInfo)
        mu.Lock()
        home.Billboard = billboard
        mu.Unlock()
    }()

    go func() {
        defer wg.Done()
        cont := xp.getContinueWatching(ctx, profileID, deviceInfo)
        mu.Lock()
        home.Continue = cont
        mu.Unlock()
        close(highPriorityDone)
    }()

    // Medium priority: First 5 rows (above the fold)
    for i, config := range rowConfig[:min(5, len(rowConfig))] {
        wg.Add(1)
        go func(idx int, cfg RowConfig) {
            defer wg.Done()
            <-highPriorityDone // Wait for high priority

            row := xp.getRow(ctx, profileID, cfg, deviceInfo)
            mu.Lock()
            home.Rows = append(home.Rows, row)
            mu.Unlock()
        }(i, config)
    }

    // Low priority: Remaining rows (below the fold)
    go func() {
        wg.Wait()

        // Fetch remaining rows after initial response
        for _, cfg := range rowConfig[5:] {
            row := xp.getRow(ctx, profileID, cfg, deviceInfo)
            // These are cached for subsequent requests
            xp.cache.Set(ctx, fmt.Sprintf("row:%s:%s", profileID, cfg.ID), row, 5*time.Minute)
        }
    }()

    wg.Wait()

    // Sort rows by original config order
    sort.Slice(home.Rows, func(i, j int) bool {
        return getRowOrder(rowConfig, home.Rows[i].ID) < getRowOrder(rowConfig, home.Rows[j].ID)
    })

    return home, nil
}

func (xp *TVXP) transformToTitleCard(
    title *CatalogTitle,
    deviceInfo DeviceInfo,
) *TitleCard {
    // Get TV-optimized images
    boxArtURL := xp.imageService.GetOptimized(
        title.Images.BoxArt,
        deviceInfo.ScreenWidth/4, // 4 items per row
        "webp",
    )

    logoURL := xp.imageService.GetOptimized(
        title.Images.Logo,
        400,
        "webp",
    )

    // Format duration for TV display
    duration := formatDuration(title.RuntimeMinutes)

    // Truncate synopsis for TV readability
    synopsis := title.Synopsis
    if len(synopsis) > 200 {
        synopsis = synopsis[:197] + "..."
    }

    card := &TitleCard{
        ID:             title.ID,
        Title:          title.Title,
        Synopsis:       synopsis,
        BoxArtURL:      boxArtURL,
        LogoURL:        logoURL,
        MaturityRating: title.MaturityRating,
        Year:           title.ReleaseYear,
        Duration:       duration,
        Tags:           title.Tags[:min(3, len(title.Tags))],
    }

    // Add video preview if available and device supports it
    if deviceInfo.SupportsPreview && title.PreviewVideo != "" {
        card.VideoPreview = &VideoPreview{
            URL:        title.PreviewVideo,
            StartTime:  title.PreviewStart,
            Duration:   15, // 15 second previews
        }
    }

    return card
}

// GetTitleDetails returns TV-optimized title details page
func (xp *TVXP) GetTitleDetails(
    ctx context.Context,
    profileID string,
    titleID string,
    deviceInfo DeviceInfo,
) (*TVTitleDetails, error) {
    var wg sync.WaitGroup
    var mu sync.Mutex
    details := &TVTitleDetails{}

    wg.Add(5)

    // Title metadata
    go func() {
        defer wg.Done()
        title, _ := xp.catalogClient.GetTitle(ctx, titleID)
        mu.Lock()
        details.Title = xp.transformToFullTitle(title, deviceInfo)
        mu.Unlock()
    }()

    // Episodes (for series)
    go func() {
        defer wg.Done()
        episodes, _ := xp.catalogClient.GetEpisodes(ctx, titleID)
        mu.Lock()
        details.Episodes = xp.transformEpisodes(episodes, deviceInfo)
        mu.Unlock()
    }()

    // Playback position
    go func() {
        defer wg.Done()
        position, _ := xp.playbackClient.GetPosition(ctx, profileID, titleID)
        mu.Lock()
        details.ResumePosition = position
        mu.Unlock()
    }()

    // Similar titles
    go func() {
        defer wg.Done()
        similar, _ := xp.personalizeClient.GetSimilar(ctx, profileID, titleID, 12)
        mu.Lock()
        details.MoreLikeThis = xp.transformCards(similar, deviceInfo)
        mu.Unlock()
    }()

    // Trailers and extras
    go func() {
        defer wg.Done()
        extras, _ := xp.catalogClient.GetExtras(ctx, titleID)
        mu.Lock()
        details.TrailersAndMore = extras
        mu.Unlock()
    }()

    wg.Wait()

    return details, nil
}
```

### Spotify: Personalized BFF for Each Platform

As described in Spotify Engineering's architecture reports (*"Building Spotify's Dynamic Audio Platforms with Tailored Client Aggregation"*, Spotify R&D), Spotify's desktop app renders a dense home screen with quick-pick shortcuts, recently played items, personalized playlists, top mixes, new releases, friend activity, and podcast recommendations, all visible without scrolling on a large monitor. The desktop BFF fetches all seven sections in parallel using a table-driven approach that maps section names to fetcher functions, with `recover` protection on each goroutine to prevent a panic in one section from crashing the entire response. The quick-picks algorithm below scores candidates from multiple signal sources (recency, popularity, time-of-day context) and deduplicates them before selecting the top six.

```go
// spotify/pkg/bff/desktop/home.go
// Spotify-style desktop BFF with rich personalization
package desktop

import (
    "context"
    "fmt"
    "log/slog"
    "sort"
    "sync"
    "time"
)

// DesktopBFF serves the Spotify desktop application
type DesktopBFF struct {
    catalogClient    *CatalogClient
    userClient       *UserClient
    socialClient     *SocialClient
    searchClient     *SearchClient
    personalize      *PersonalizationClient
    audioFeatures    *AudioFeaturesClient
    cache            *BFFCache
}

// DesktopHome is the rich home view for desktop
type DesktopHome struct {
    Greeting         string              `json:"greeting"`
    QuickPicks       []*QuickPickCard    `json:"quick_picks"`
    RecentlyPlayed   []*PlayHistoryCard  `json:"recently_played"`
    MadeForYou       []*PlaylistCard     `json:"made_for_you"`
    YourTopMixes     []*MixCard          `json:"your_top_mixes"`
    NewReleases      []*AlbumCard        `json:"new_releases"`
    FriendActivity   []*FriendActivity   `json:"friend_activity,omitempty"`
    PodcastsForYou   []*PodcastCard      `json:"podcasts,omitempty"`
    Sections         []*HomeSection      `json:"sections"`
}

// QuickPickCard for the top row of shortcuts
type QuickPickCard struct {
    ID        string `json:"id"`
    Type      string `json:"type"`  // "playlist", "artist", "album", "podcast"
    Title     string `json:"title"`
    ImageURL  string `json:"image"`
    Color     string `json:"color"` // Extracted dominant color
    URI       string `json:"uri"`   // spotify:playlist:xxx
}

func (b *DesktopBFF) GetHome(ctx context.Context, userID string) (*DesktopHome, error) {
    var wg sync.WaitGroup
    var mu sync.Mutex

    home := &DesktopHome{
        Greeting: b.getGreeting(),
    }

    // All sections fetched in parallel for maximum speed
    fetchers := []struct {
        name string
        fn   func()
    }{
        {"quick_picks", func() {
            picks := b.getQuickPicks(ctx, userID)
            mu.Lock()
            home.QuickPicks = picks
            mu.Unlock()
        }},
        {"recently_played", func() {
            recent := b.getRecentlyPlayed(ctx, userID)
            mu.Lock()
            home.RecentlyPlayed = recent
            mu.Unlock()
        }},
        {"made_for_you", func() {
            mfy := b.getMadeForYou(ctx, userID)
            mu.Lock()
            home.MadeForYou = mfy
            mu.Unlock()
        }},
        {"top_mixes", func() {
            mixes := b.getTopMixes(ctx, userID)
            mu.Lock()
            home.YourTopMixes = mixes
            mu.Unlock()
        }},
        {"new_releases", func() {
            releases := b.getNewReleases(ctx, userID)
            mu.Lock()
            home.NewReleases = releases
            mu.Unlock()
        }},
        {"friend_activity", func() {
            friends := b.getFriendActivity(ctx, userID)
            mu.Lock()
            home.FriendActivity = friends
            mu.Unlock()
        }},
        {"podcasts", func() {
            pods := b.getPodcastsForYou(ctx, userID)
            mu.Lock()
            home.PodcastsForYou = pods
            mu.Unlock()
        }},
    }

    for _, f := range fetchers {
        wg.Add(1)
        go func(fetcher struct {
            name string
            fn   func()
        }) {
            defer wg.Done()
            defer func() {
                if r := recover(); r != nil {
                    slog.Error("home section panic",
                        "section", fetcher.name,
                        "error", r,
                    )
                }
            }()
            fetcher.fn()
        }(f)
    }

    wg.Wait()

    // Get additional personalized sections
    home.Sections = b.getPersonalizedSections(ctx, userID)

    return home, nil
}

func (b *DesktopBFF) getQuickPicks(ctx context.Context, userID string) []*QuickPickCard {

    // Quick picks = 6 most relevant items based on:
    // 1. Recently played
    // 2. Most played this week
    // 3. Time of day context

    cacheKey := fmt.Sprintf("quick_picks:%s", userID)
    var cached []*QuickPickCard
    if err := b.cache.Get(ctx, cacheKey, &cached); err == nil {
        return cached
    }

    // Get candidates from multiple sources
    var candidates []*QuickPickCandidate

    // Recent listening
    recent, _ := b.userClient.GetRecentlyPlayed(ctx, userID, 20)
    for _, item := range recent {
        candidates = append(candidates, &QuickPickCandidate{
            ID:       item.Context.URI,
            Type:     item.Context.Type,
            Score:    b.calculateRecencyScore(item.PlayedAt),
            ImageURL: item.Context.Images[0].URL,
            Title:    item.Context.Name,
        })
    }

    // Top items this week
    topItems, _ := b.personalize.GetTopItems(ctx, userID, "short_term", 10)
    for _, item := range topItems {
        candidates = append(candidates, &QuickPickCandidate{
            ID:       item.URI,
            Type:     item.Type,
            Score:    float64(item.Popularity) / 100,
            ImageURL: item.Images[0].URL,
            Title:    item.Name,
        })
    }

    // Deduplicate and sort by score
    seen := make(map[string]bool)
    unique := make([]*QuickPickCandidate, 0)
    for _, c := range candidates {
        if !seen[c.ID] {
            seen[c.ID] = true
            unique = append(unique, c)
        }
    }

    sort.Slice(unique, func(i, j int) bool {
        return unique[i].Score > unique[j].Score
    })

    // Take top 6 and transform
    picks := make([]*QuickPickCard, 0, 6)
    for i := 0; i < min(6, len(unique)); i++ {
        c := unique[i]
        color := b.extractDominantColor(c.ImageURL)
        picks = append(picks, &QuickPickCard{
            ID:       c.ID,
            Type:     c.Type,
            Title:    c.Title,
            ImageURL: c.ImageURL,
            Color:    color,
            URI:      c.ID,
        })
    }

    b.cache.Set(ctx, cacheKey, picks, 10*time.Minute)

    return picks
}

func (b *DesktopBFF) getGreeting() string {
    hour := time.Now().Hour()
    switch {
    case hour < 12:
        return "Good morning"
    case hour < 17:
        return "Good afternoon"
    default:
        return "Good evening"
    }
}

// GetSearch provides instant search with rich results
func (b *DesktopBFF) GetSearch(
    ctx context.Context,
    userID string,
    query string,
) (*SearchResults, error) {
    if query == "" {
        // Return recent searches and browse categories
        return b.getSearchLanding(ctx, userID)
    }

    var wg sync.WaitGroup
    results := &SearchResults{Query: query}

    // Search all types in parallel
    searchTypes := []string{"track", "artist", "album", "playlist", "podcast", "episode"}

    for _, searchType := range searchTypes {
        wg.Add(1)
        go func(t string) {
            defer wg.Done()
            items, _ := b.searchClient.Search(ctx, query, t, 10)
            results.AddResults(t, items)
        }(searchType)
    }

    wg.Wait()

    // Rank and order results based on user's listening history
    results.Items = b.rankSearchResults(ctx, userID, results.Items)

    return results, nil
}
```

### Junior -> FAANG: Extracting Interview Material from Case Studies

The three case studies (SoundCloud, Netflix, Spotify) each contain a pattern that interviewers test for. Recognize and internalize each one.

SoundCloud's `determineQuality` function is the network-adaptive response pattern. The interview version of this question is: "How would you design a video streaming API that adapts to network conditions?" The answer structure is the same: client reports network quality (via header or query parameter), BFF selects configuration based on a quality map, and transformation functions apply the configuration to produce an appropriately sized response. The client is the source of truth for its own network state.

Netflix's prioritized fan-out (high-priority rows start immediately, above-the-fold rows wait for `highPriorityDone`, below-the-fold rows are cached asynchronously) is the tiered response pattern. The interview version is: "How would you design a homepage that loads fast even when some sections require slow personalization calls?" Answer: identify which sections are critical (billboard, continue watching), start them first, use their completion as a signal that allows subsequent sections to proceed, and defer non-critical sections to background caching.

Spotify's `recover()` in each goroutine is the panic isolation pattern. If a section's fetcher panics (nil pointer, type assertion failure), it does not crash the entire request. The interview version is: "What happens if one of your goroutines panics in a fan-out?" Recover per goroutine, log the panic with full context, and continue building the response with available data.

### Senior @ FAANG: Platform Thinking from the Case Studies

Each case study reveals a platform decision made at scale that junior engineers never see because it is invisible when it works correctly.

Netflix's XP API is not just a BFF. It is a product platform that abstracts the home screen assembly contract. The streaming team, the originals team, and the live events team all contribute row types to the XP API without knowing how the home screen is assembled. The XP API owns the assembly contract, enforces row size limits, and manages A/B test assignments. This is the "platform as product" model: the XP API is a product that other internal teams use to participate in the home screen, not just a technical aggregation layer.

At senior level, you recognize that this platform model requires a formal contribution process: a schema for defining new row types, a review process for approving new row types in production, and a deprecation process for removing row types that no content team is using. Without this process, the row type catalog grows unboundedly, every content team maintains their own fork of the assembly logic, and the XP API becomes inconsistent across device types.

Spotify's table-driven fetcher pattern (the `fetchers` slice with `name` and `fn` fields) has a platform benefit beyond readability. It makes it possible to add new home screen sections by adding one entry to the table, with no changes to the fan-out coordination code. This is the open-closed principle applied to the BFF aggregation layer: open for extension (new sections), closed for modification (fan-out coordination). At staff level, recognizing this pattern and prescribing it for your team's BFF templates reduces the friction of adding new features while keeping the coordination code stable.

SoundCloud's batch stream URL generation is an example of a platform capability that the mobile client could not build for itself. The client cannot generate CDN-signed URLs. The BFF has the CDN credentials and generates URLs with appropriate expiry times. This is the security boundary benefit of BFF in a subtle form: the BFF holds credentials that the client should never hold, uses them to produce time-limited, scoped access tokens (signed URLs), and gives the client only those tokens. The client never has access to the underlying CDN credential. This is the same principle as the service-to-service token pattern in the admin BFF, applied to CDN access.

---
