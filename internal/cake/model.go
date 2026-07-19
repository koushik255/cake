package cake

type MediaKind string

const (
	Movie   MediaKind = "movie"
	Episode MediaKind = "episode"
)

type SubtitleTrack struct {
	StreamIndex *int   `json:"streamIndex,omitempty"`
	Codec       string `json:"codec,omitempty"`
	Language    string `json:"language,omitempty"`
	Name        string `json:"name,omitempty"`
	Source      string `json:"source,omitempty"`
	Renderable  bool   `json:"renderable,omitempty"`
}

type SidecarSubtitle struct {
	Path         string `json:"path"`
	RelativePath string `json:"relativePath"`
	Label        string `json:"label"`
	Format       string `json:"format"`
	Language     string `json:"language,omitempty"`
}

type MediaFile struct {
	ID                string            `json:"id"`
	Kind              MediaKind         `json:"kind"`
	Title             string            `json:"title"`
	Path              string            `json:"path"`
	RelativePath      string            `json:"relativePath"`
	Size              int64             `json:"size"`
	ModifiedAt        string            `json:"modifiedAt"`
	Extension         string            `json:"extension"`
	ShowTitle         string            `json:"showTitle,omitempty"`
	Season            *int              `json:"season,omitempty"`
	Episode           *int              `json:"episode,omitempty"`
	EpisodeTitle      string            `json:"episodeTitle,omitempty"`
	Year              *int              `json:"year,omitempty"`
	DurationSeconds   *float64          `json:"durationSeconds,omitempty"`
	MIMEType          string            `json:"mimeType,omitempty"`
	VideoCodec        string            `json:"videoCodec,omitempty"`
	AudioCodec        string            `json:"audioCodec,omitempty"`
	Width             *int              `json:"width,omitempty"`
	Height            *int              `json:"height,omitempty"`
	EmbeddedSubtitles []SubtitleTrack   `json:"embeddedSubtitles,omitempty"`
	SidecarSubtitles  []SidecarSubtitle `json:"sidecarSubtitles,omitempty"`
	MetadataError     string            `json:"metadataError,omitempty"`
}

type Library struct {
	MediaDir  string      `json:"mediaDir"`
	ScannedAt string      `json:"scannedAt"`
	Items     []MediaFile `json:"items"`
}

type Profile struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
}

type WatchHistoryEntry struct {
	ID              string `json:"id"`
	WatchedAt       string `json:"watchedAt"`
	PlaybackSeconds *int   `json:"playbackSeconds,omitempty"`
}
