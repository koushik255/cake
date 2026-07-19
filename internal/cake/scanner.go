package cake

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var videoExtensions = map[string]bool{
	".mp4": true, ".m4v": true, ".mov": true, ".mkv": true,
	".webm": true, ".avi": true, ".wmv": true, ".flv": true,
	".mpeg": true, ".mpg": true, ".ts": true, ".m2ts": true,
	".ogv": true,
}

var subtitleExtensions = map[string]bool{".srt": true, ".vtt": true}

var mediaMIMEs = map[string]string{
	".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
	".mkv": "video/x-matroska", ".webm": "video/webm",
	".avi": "video/x-msvideo", ".wmv": "video/x-ms-wmv",
	".flv": "video/x-flv", ".mpeg": "video/mpeg", ".mpg": "video/mpeg",
	".ts": "video/mp2t", ".m2ts": "video/mp2t", ".ogv": "video/ogg",
}

func scanLibrary(mediaDir string, previous *Library) (*Library, error) {
	var videos []string
	var subtitles []SidecarSubtitle
	err := filepath.WalkDir(mediaDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) && path == mediaDir {
				return filepath.SkipDir
			}
			return err
		}
		if entry.IsDir() {
			if path != mediaDir && strings.HasPrefix(entry.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() || strings.HasPrefix(entry.Name(), ".") {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if videoExtensions[ext] {
			videos = append(videos, path)
		} else if subtitleExtensions[ext] {
			subtitles = append(subtitles, buildSidecar(mediaDir, path, ext))
		}
		return nil
	})
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	previousByPath := make(map[string]MediaFile)
	if previous != nil {
		for _, item := range previous.Items {
			previousByPath[item.RelativePath] = item
		}
	}
	items := make([]MediaFile, len(videos))
	jobs := make(chan int)
	var wg sync.WaitGroup
	var firstErr error
	var errMu sync.Mutex
	workers := 3
	if len(videos) < workers {
		workers = len(videos)
	}
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				item, e := scanVideo(videos[i], mediaDir, previousByPath, subtitles)
				if e != nil {
					errMu.Lock()
					if firstErr == nil {
						firstErr = e
					}
					errMu.Unlock()
				}
				items[i] = item
			}
		}()
	}
	for i := range videos {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	sort.Slice(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		at, bt := a.Title, b.Title
		if a.ShowTitle != "" {
			at = a.ShowTitle
		}
		if b.ShowTitle != "" {
			bt = b.ShowTitle
		}
		if at != bt {
			return at < bt
		}
		as, bs := intValue(a.Season), intValue(b.Season)
		if as != bs {
			return as < bs
		}
		ae, be := intValue(a.Episode), intValue(b.Episode)
		if ae != be {
			return ae < be
		}
		return a.Title < b.Title
	})
	return &Library{MediaDir: mediaDir, ScannedAt: isoTime(time.Now()), Items: items}, nil
}

func scanVideo(path, mediaDir string, previous map[string]MediaFile, subtitles []SidecarSubtitle) (MediaFile, error) {
	info, err := os.Stat(path)
	if err != nil {
		return MediaFile{}, err
	}
	rel, err := filepath.Rel(mediaDir, path)
	if err != nil {
		return MediaFile{}, err
	}
	rel = filepath.ToSlash(rel)
	modified := isoTime(info.ModTime())
	ext := strings.ToLower(filepath.Ext(path))
	parsed := parseMediaName(rel)
	old, exists := previous[rel]
	item := MediaFile{
		ID: stableID(rel), Path: path, RelativePath: rel,
		Size: info.Size(), ModifiedAt: modified, Extension: ext,
	}
	if exists && old.Size == info.Size() && old.ModifiedAt == modified {
		item = old
		item.Path = path
		item.RelativePath = rel
		item.Size = info.Size()
		item.ModifiedAt = modified
		item.Extension = ext
	} else {
		inspectMedia(path, &item)
	}
	item.Kind = parsed.Kind
	item.Title = parsed.Title
	item.ShowTitle = parsed.ShowTitle
	item.Season = parsed.Season
	item.Episode = parsed.Episode
	item.EpisodeTitle = parsed.EpisodeTitle
	item.Year = parsed.Year
	item.SidecarSubtitles = findSidecars(item, subtitles)
	return item, nil
}

type probeData struct {
	Format struct {
		Duration   string `json:"duration"`
		FormatName string `json:"format_name"`
	} `json:"format"`
	Streams []struct {
		Index     int    `json:"index"`
		CodecName string `json:"codec_name"`
		CodecType string `json:"codec_type"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		Tags      struct {
			Language string `json:"language"`
			Title    string `json:"title"`
		} `json:"tags"`
	} `json:"streams"`
}

func inspectMedia(path string, item *MediaFile) {
	args := []string{
		"-v", "error",
		"-show_entries", "format=duration,format_name:stream=index,codec_name,codec_type,width,height:stream_tags=language,title",
		"-of", "json", path,
	}
	out, err := exec.Command("ffprobe", args...).Output()
	if err != nil {
		item.MetadataError = err.Error()
		return
	}
	var p probeData
	if err = json.Unmarshal(out, &p); err != nil {
		item.MetadataError = err.Error()
		return
	}
	if d, err := strconv.ParseFloat(p.Format.Duration, 64); err == nil {
		item.DurationSeconds = &d
	}
	item.MIMEType = mediaMIMEs[item.Extension]
	for _, s := range p.Streams {
		switch s.CodecType {
		case "video":
			if item.VideoCodec == "" {
				item.VideoCodec = s.CodecName
				if s.Width > 0 {
					v := s.Width
					item.Width = &v
				}
				if s.Height > 0 {
					v := s.Height
					item.Height = &v
				}
			}
		case "audio":
			if item.AudioCodec == "" {
				item.AudioCodec = s.CodecName
			}
		case "subtitle":
			idx := s.Index
			lang := s.Tags.Language
			if lang == "und" {
				lang = ""
			}
			item.EmbeddedSubtitles = append(item.EmbeddedSubtitles, SubtitleTrack{
				StreamIndex: &idx, Codec: s.CodecName,
				Language: lang, Name: s.Tags.Title, Source: "ffprobe",
				Renderable: oneOf(s.CodecName, "subrip", "ass", "ssa", "webvtt"),
			})
		}
	}
}

func buildSidecar(root, path, ext string) SidecarSubtitle {
	rel, _ := filepath.Rel(root, path)
	base := strings.TrimSuffix(filepath.Base(path), ext)
	parts := strings.Split(base, ".")
	lang := ""
	candidate := parts[len(parts)-1]
	if validLanguage(candidate) {
		lang = candidate
	}
	label := filepath.Base(path)
	if lang != "" {
		label = strings.ToUpper(lang)
	}
	format := "srt"
	if ext == ".vtt" {
		format = "vtt"
	}
	return SidecarSubtitle{
		Path: path, RelativePath: filepath.ToSlash(rel),
		Label: label, Format: format, Language: lang,
	}
}

func validLanguage(s string) bool {
	if len(s) < 2 || len(s) > 6 {
		return false
	}
	parts := strings.Split(s, "-")
	if len(parts) > 2 || len(parts[0]) < 2 || len(parts[0]) > 3 {
		return false
	}
	for _, part := range parts {
		for _, r := range part {
			if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
				return false
			}
		}
	}
	return len(parts) == 1 || len(parts[1]) == 2
}

func findSidecars(media MediaFile, subs []SidecarSubtitle) []SidecarSubtitle {
	var result []SidecarSubtitle
	dir := filepath.Dir(media.Path)
	stem := strings.TrimSuffix(filepath.Base(media.Path), media.Extension)
	for _, s := range subs {
		if filepath.Dir(s.Path) != dir {
			continue
		}
		subStem := strings.TrimSuffix(filepath.Base(s.Path), "."+s.Format)
		if subStem == stem || strings.HasPrefix(subStem, stem+".") {
			result = append(result, s)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Label < result[j].Label })
	return result
}

func stableID(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:12])
}

func intValue(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}

func isoTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
