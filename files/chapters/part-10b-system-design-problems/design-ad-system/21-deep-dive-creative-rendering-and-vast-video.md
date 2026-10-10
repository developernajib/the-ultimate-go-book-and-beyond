## Deep Dive: Creative Rendering and VAST Video

The creative renderer generates the actual HTML or XML markup that displays an ad to the user. For display banner ads, it produces an HTML snippet with the image, click tracking link, impression pixel, and a viewability observer script. For video ads, it generates VAST (Video Ad Serving Template) XML, which is the industry-standard format that video players understand. VAST includes media file URLs, tracking events for video progress (start, quartiles, complete), and click-through URLs. The CDN base URL is used for all creative assets so that images and videos are served from edge locations close to the user, minimizing load time.

```go
package creative

import (
	"encoding/xml"
	"fmt"
)

// CreativeRenderer generates ad markup for different formats
type CreativeRenderer struct {
	cdnBase string
}

// RenderBanner generates HTML for display banner ads
func (r *CreativeRenderer) RenderBanner(creative CreativeData, trackingURLs TrackingURLs) string {
	return fmt.Sprintf(`
<div id="ad-%s" style="width:%dpx;height:%dpx;position:relative">
  <a href="%s" target="_blank" rel="noopener">
    <img src="%s/%s" width="%d" height="%d" alt="" loading="lazy" />
  </a>
  <img src="%s" width="1" height="1" style="display:none" />
  <script>
    (function() {
      var ad = document.getElementById('ad-%s');
      var timer = null;
      var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (timer) return;
            var start = Date.now();
            timer = setInterval(function() {
              if (Date.now() - start >= 1000) {
                new Image().src = '%s&viewable=1';
                clearInterval(timer);
                observer.disconnect();
              }
            }, 100);
          } else if (timer) {
            // Left the viewport before 1 continuous second: reset
            clearInterval(timer);
            timer = null;
          }
        });
      }, {threshold: 0.5});
      observer.observe(ad);
    })();
  </script>
</div>`,
		creative.ID, creative.Width, creative.Height,
		trackingURLs.ClickURL,
		r.cdnBase, creative.AssetKey, creative.Width, creative.Height,
		trackingURLs.ImpressionPixel,
		creative.ID,
		trackingURLs.ViewabilityURL,
	)
}

// RenderVAST generates VAST XML for video ads
func (r *CreativeRenderer) RenderVAST(creative CreativeData, trackingURLs TrackingURLs) ([]byte, error) {
	vast := VAST{
		Version: "4.0",
		Ad: Ad{
			ID: creative.ID,
			InLine: InLine{
				AdTitle: creative.Title,
				Impression: trackingURLs.ImpressionPixel,
				Creatives: []VASTCreative{
					{
						Linear: Linear{
							Duration: formatDuration(creative.DurationSec),
							MediaFiles: []MediaFile{
								{
									Delivery: "progressive",
									Type:     "video/mp4",
									Width:    creative.Width,
									Height:   creative.Height,
									Bitrate:  2000,
									URL:      fmt.Sprintf("%s/%s", r.cdnBase, creative.AssetKey),
								},
							},
							TrackingEvents: []TrackingEvent{
								{Event: "start", URL: trackingURLs.VideoStart},
								{Event: "firstQuartile", URL: trackingURLs.VideoQ1},
								{Event: "midpoint", URL: trackingURLs.VideoMid},
								{Event: "thirdQuartile", URL: trackingURLs.VideoQ3},
								{Event: "complete", URL: trackingURLs.VideoComplete},
							},
							VideoClicks: VideoClicks{
								ClickThrough: trackingURLs.ClickURL,
								ClickTracking: trackingURLs.ClickTracker,
							},
						},
					},
				},
			},
		},
	}

	return xml.MarshalIndent(vast, "", "  ")
}

// VAST XML structures
type VAST struct {
	XMLName xml.Name `xml:"VAST"`
	Version string   `xml:"version,attr"`
	Ad      Ad       `xml:"Ad"`
}

type Ad struct {
	ID     string `xml:"id,attr"`
	InLine InLine `xml:"InLine"`
}

type InLine struct {
	AdTitle    string          `xml:"AdTitle"`
	Impression string          `xml:"Impression"`
	Creatives  []VASTCreative  `xml:"Creatives>Creative"`
}

type VASTCreative struct {
	Linear Linear `xml:"Linear"`
}

type Linear struct {
	Duration       string          `xml:"Duration"`
	MediaFiles     []MediaFile     `xml:"MediaFiles>MediaFile"`
	TrackingEvents []TrackingEvent `xml:"TrackingEvents>Tracking"`
	VideoClicks    VideoClicks     `xml:"VideoClicks"`
}

type MediaFile struct {
	Delivery string `xml:"delivery,attr"`
	Type     string `xml:"type,attr"`
	Width    int    `xml:"width,attr"`
	Height   int    `xml:"height,attr"`
	Bitrate  int    `xml:"bitrate,attr"`
	URL      string `xml:",chardata"`
}

type TrackingEvent struct {
	Event string `xml:"event,attr"`
	URL   string `xml:",chardata"`
}

type VideoClicks struct {
	ClickThrough  string `xml:"ClickThrough"`
	ClickTracking string `xml:"ClickTracking"`
}

type CreativeData struct {
	ID, Title, AssetKey string
	Width, Height       int
	DurationSec         int
}

type TrackingURLs struct {
	ImpressionPixel string
	ClickURL        string
	ClickTracker    string
	ViewabilityURL  string
	VideoStart      string
	VideoQ1         string
	VideoMid        string
	VideoQ3         string
	VideoComplete   string
}

func formatDuration(seconds int) string {
	h := seconds / 3600
	m := (seconds % 3600) / 60
	s := seconds % 60
	return fmt.Sprintf("%02d:%02d:%02d", h, m, s)
}
```

---
