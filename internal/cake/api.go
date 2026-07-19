package cake

import (
	"fmt"
	"net/url"
	"strings"
)

type PlaybackDecision struct {
	Mode              string `json:"mode"`
	URL               string `json:"url"`
	CanDirectPlay     bool   `json:"canDirectPlay"`
	RequiresTranscode bool   `json:"requiresTranscode"`
	TranscodeReason   string `json:"transcodeReason,omitempty"`
	DirectURL         string `json:"directUrl"`
	TranscodeURL      string `json:"transcodeUrl,omitempty"`
	DirectFirst       bool   `json:"directFirst"`
}

type MediaSummary struct {
	ID              string    `json:"id"`
	Kind            MediaKind `json:"kind"`
	Title           string    `json:"title"`
	DisplayTitle    string    `json:"displayTitle"`
	RelativePath    string    `json:"relativePath"`
	ShowTitle       string    `json:"showTitle,omitempty"`
	Season          *int      `json:"season,omitempty"`
	Episode         *int      `json:"episode,omitempty"`
	EpisodeTitle    string    `json:"episodeTitle,omitempty"`
	Year            *int      `json:"year,omitempty"`
	DurationSeconds *float64  `json:"durationSeconds,omitempty"`
	MIMEType        string    `json:"mimeType,omitempty"`
	VideoCodec      string    `json:"videoCodec,omitempty"`
	AudioCodec      string    `json:"audioCodec,omitempty"`
	Width           *int      `json:"width,omitempty"`
	Height          *int      `json:"height,omitempty"`
	SubtitleCount   int       `json:"subtitleCount"`
}

type LibraryPayload struct {
	MediaDir  string         `json:"mediaDir"`
	ScannedAt string         `json:"scannedAt"`
	Count     int            `json:"count"`
	Movies    []MediaSummary `json:"movies"`
	Episodes  []MediaSummary `json:"episodes"`
}

type SubtitlePayload struct {
	Label  string `json:"label"`
	Format string `json:"format"`
	Source string `json:"source"`
	URL    string `json:"url"`
}
type NextEpisodePayload struct {
	ID           string `json:"id"`
	DisplayTitle string `json:"displayTitle"`
	URL          string `json:"url"`
}
type MediaPayload struct {
	MediaSummary
	Path              string              `json:"path"`
	Size              int64               `json:"size"`
	ModifiedAt        string              `json:"modifiedAt"`
	Extension         string              `json:"extension"`
	StreamURL         string              `json:"streamUrl"`
	Playback          PlaybackDecision    `json:"playback"`
	OpusAudioURL      string              `json:"opusAudioUrl"`
	Subtitles         []SubtitlePayload   `json:"subtitles"`
	EmbeddedSubtitles []SubtitleTrack     `json:"embeddedSubtitles"`
	SidecarSubtitles  []SidecarSubtitle   `json:"sidecarSubtitles"`
	MetadataError     string              `json:"metadataError,omitempty"`
	PlaybackSeconds   *int                `json:"playbackSeconds,omitempty"`
	NextEpisode       *NextEpisodePayload `json:"nextEpisode,omitempty"`
}

func libraryPayload(l *Library) LibraryPayload {
	p := LibraryPayload{
		MediaDir:  l.MediaDir,
		ScannedAt: l.ScannedAt,
		Count:     len(l.Items),
		Movies:    []MediaSummary{},
		Episodes:  []MediaSummary{},
	}
	for _, item := range l.Items {
		if item.Kind == Movie {
			p.Movies = append(p.Movies, mediaSummary(item))
		} else {
			p.Episodes = append(p.Episodes, mediaSummary(item))
		}
	}
	return p
}

func mediaSummary(i MediaFile) MediaSummary {
	return MediaSummary{
		ID: i.ID, Kind: i.Kind, Title: i.Title,
		DisplayTitle: displayTitle(i), RelativePath: i.RelativePath,
		ShowTitle: i.ShowTitle, Season: i.Season, Episode: i.Episode,
		EpisodeTitle: i.EpisodeTitle, Year: i.Year,
		DurationSeconds: i.DurationSeconds, MIMEType: i.MIMEType,
		VideoCodec: i.VideoCodec, AudioCodec: i.AudioCodec,
		Width: i.Width, Height: i.Height,
		SubtitleCount: len(i.SidecarSubtitles) + len(i.EmbeddedSubtitles),
	}
}

func displayTitle(i MediaFile) string {
	if i.Kind == Episode {
		code := ""
		if i.Season != nil && i.Episode != nil {
			code = "S" + pad2(*i.Season) + "E" + pad2(*i.Episode)
		}
		parts := []string{}
		for _, p := range []string{i.ShowTitle, code, i.EpisodeTitle} {
			if p != "" {
				parts = append(parts, p)
			}
		}
		return strings.Join(parts, " - ")
	}
	if i.Year != nil {
		return fmt.Sprintf("%s (%d)", i.Title, *i.Year)
	}
	return i.Title
}
func playbackDecision(i MediaFile, mode string) PlaybackDecision {
	direct := "/stream/" + url.PathEscape(i.ID) + "/direct"
	transcode := "/hls/" + url.PathEscape(i.ID) + "/master.m3u8"
	reason := directPlayIssue(i)
	can := reason == ""
	server := mode != "direct"
	should := mode == "server" || (mode == "auto" && !can)
	if should {
		return PlaybackDecision{
			Mode: "transcode", URL: transcode, CanDirectPlay: can,
			RequiresTranscode: true, TranscodeReason: reason,
			DirectURL: direct, TranscodeURL: transcode,
		}
	}
	d := PlaybackDecision{
		Mode: "direct", URL: direct, CanDirectPlay: can,
		TranscodeReason: reason, DirectURL: direct,
		DirectFirst: mode == "auto",
	}
	if server {
		d.TranscodeURL = transcode
	}
	return d
}

var (
	directPlayMIMEs       = map[string]bool{"video/mp4": true, "video/quicktime": true, "video/webm": true}
	directPlayExtensions  = map[string]bool{".mp4": true, ".m4v": true, ".mov": true, ".webm": true}
	directPlayVideoCodecs = map[string]bool{"avc": true, "avc1": true, "h264": true, "vp8": true, "vp09": true, "vp9": true}
	directPlayAudioCodecs = map[string]bool{"aac": true, "mp3": true, "mp4a": true, "opus": true, "vorbis": true}
)

func directPlayIssue(i MediaFile) string {
	if i.MetadataError != "" {
		return "metadata"
	}
	if !directPlayMIMEs[i.MIMEType] && !directPlayExtensions[i.Extension] {
		return "container"
	}
	if i.VideoCodec != "" && !directPlayVideoCodecs[normalizeCodec(i.VideoCodec)] {
		return "video-codec"
	}
	if i.AudioCodec != "" && !directPlayAudioCodecs[normalizeCodec(i.AudioCodec)] {
		return "audio-codec"
	}
	return ""
}

func normalizeCodec(codec string) string {
	return strings.Split(strings.ToLower(codec), ".")[0]
}

func mediaPayload(i MediaFile, config Config, next *MediaFile, seconds *int) MediaPayload {
	play := playbackDecision(i, config.PlaybackMode)
	p := MediaPayload{
		MediaSummary: mediaSummary(i),
		Path:         i.RelativePath, Size: i.Size, ModifiedAt: i.ModifiedAt,
		Extension: i.Extension, StreamURL: play.URL, Playback: play,
		OpusAudioURL: "/audio-transcode/" + url.PathEscape(i.ID) + "/audio.ogg",
		Subtitles:    subtitlePayload(i), EmbeddedSubtitles: i.EmbeddedSubtitles,
		SidecarSubtitles: i.SidecarSubtitles, MetadataError: i.MetadataError,
		PlaybackSeconds: seconds,
	}
	if p.EmbeddedSubtitles == nil {
		p.EmbeddedSubtitles = []SubtitleTrack{}
	}
	if p.SidecarSubtitles == nil {
		p.SidecarSubtitles = []SidecarSubtitle{}
	}
	if next != nil {
		p.NextEpisode = &NextEpisodePayload{
			ID: next.ID, DisplayTitle: displayTitle(*next),
			URL: "/watch/" + url.PathEscape(next.ID),
		}
	}
	return p
}

func subtitlePayload(i MediaFile) []SubtitlePayload {
	subs := make([]SubtitlePayload, 0, len(i.SidecarSubtitles)+len(i.EmbeddedSubtitles))
	for n, s := range i.SidecarSubtitles {
		subs = append(subs, SubtitlePayload{
			Label: s.Label, Format: s.Format, Source: "sidecar",
			URL: fmt.Sprintf("/subtitles/%s/%d", url.PathEscape(i.ID), n),
		})
	}
	for _, s := range i.EmbeddedSubtitles {
		if !s.Renderable || s.StreamIndex == nil {
			continue
		}
		labelParts := nonempty(s.Name, strings.ToUpper(s.Language), s.Codec, fmt.Sprintf("#%d", *s.StreamIndex))
		subs = append(subs, SubtitlePayload{
			Label: strings.Join(labelParts, " "), Format: "vtt", Source: "embedded",
			URL: fmt.Sprintf("/embedded-subtitles/%s/%d", url.PathEscape(i.ID), *s.StreamIndex),
		})
	}
	return subs
}
func nonempty(v ...string) []string {
	r := []string{}
	for _, s := range v {
		if s != "" {
			r = append(r, s)
		}
	}
	return r
}
