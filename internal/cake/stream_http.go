package cake

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func (a *App) streamMedia(w http.ResponseWriter, r *http.Request) error {
	tail := strings.TrimPrefix(r.URL.Path, "/stream/")
	transcode := strings.HasSuffix(tail, "/transcode")
	id := strings.TrimSuffix(strings.TrimSuffix(tail, "/direct"), "/transcode")
	id, _ = url.PathUnescape(id)
	item, err := a.library.Find(id)
	if err != nil {
		return err
	}
	if item == nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return nil
	}
	if transcode {
		return a.media.ServeHLS(w, r, *item, "master.m3u8")
	}

	file, err := os.Open(item.Path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !normalizeRange(r, item.Size) {
		writeRangeNotSatisfiable(w, item.Size)
		return nil
	}
	if item.MIMEType != "" {
		w.Header().Set("Content-Type", item.MIMEType)
	} else if contentType := mediaMIMEs[item.Extension]; contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	http.ServeContent(w, r, filepath.Base(item.Path), info.ModTime(), file)
	return nil
}

func (a *App) streamHLS(w http.ResponseWriter, r *http.Request) error {
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/hls/"), "/", 2)
	if len(parts) != 2 {
		http.NotFound(w, r)
		return nil
	}
	id, _ := url.PathUnescape(parts[0])
	item, err := a.library.Find(id)
	if err != nil {
		return err
	}
	if item == nil {
		http.NotFound(w, r)
		return nil
	}
	return a.media.ServeHLS(w, r, *item, parts[1])
}

func (a *App) streamAudio(w http.ResponseWriter, r *http.Request) error {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/audio-transcode/"), "/")
	if len(parts) != 2 || parts[1] != "audio.ogg" {
		http.NotFound(w, r)
		return nil
	}
	id, _ := url.PathUnescape(parts[0])
	item, err := a.library.Find(id)
	if err != nil {
		return err
	}
	if item == nil {
		http.NotFound(w, r)
		return nil
	}
	return a.media.ServeOpusAudio(w, r, *item)
}

func (a *App) streamEmbeddedSubtitle(w http.ResponseWriter, r *http.Request) error {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/embedded-subtitles/"), "/")
	if len(parts) != 2 {
		http.NotFound(w, r)
		return nil
	}
	id, _ := url.PathUnescape(parts[0])
	index, err := strconv.Atoi(parts[1])
	if err != nil {
		http.NotFound(w, r)
		return nil
	}
	item, err := a.library.Find(id)
	if err != nil {
		return err
	}
	if item == nil {
		http.NotFound(w, r)
		return nil
	}
	return a.media.ServeEmbeddedSubtitle(w, r, *item, index)
}

func (a *App) streamThumbnail(w http.ResponseWriter, r *http.Request) error {
	tail := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/thumbnails/"), ".jpg")
	id, _ := url.PathUnescape(tail)
	item, err := a.library.Find(id)
	if err != nil {
		return err
	}
	if item == nil {
		http.NotFound(w, r)
		return nil
	}
	var at *float64
	if raw := r.URL.Query().Get("at"); raw != "" {
		if value, parseErr := strconv.ParseFloat(raw, 64); parseErr == nil {
			at = &value
		}
	}
	return a.media.ServeThumbnail(w, r, *item, at)
}

func (a *App) streamSidecar(w http.ResponseWriter, r *http.Request) error {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/subtitles/"), "/")
	if len(parts) != 2 {
		http.NotFound(w, r)
		return nil
	}
	id, _ := url.PathUnescape(parts[0])
	index, err := strconv.Atoi(parts[1])
	if err != nil {
		http.NotFound(w, r)
		return nil
	}
	item, err := a.library.Find(id)
	if err != nil {
		return err
	}
	if item == nil || index < 0 || index >= len(item.SidecarSubtitles) {
		http.NotFound(w, r)
		return nil
	}
	subtitle := item.SidecarSubtitles[index]
	if subtitle.Format == "vtt" {
		w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeFile(w, r, subtitle.Path)
	return nil
}

func normalizeRange(r *http.Request, size int64) bool {
	raw := r.Header.Get("Range")
	if raw == "" {
		return true
	}
	if !strings.HasPrefix(raw, "bytes=") {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(raw, "bytes="), "-")
	if len(parts) != 2 || parts[0] == "" && parts[1] == "" {
		return false
	}

	if parts[0] == "" {
		suffixLength, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || suffixLength <= 0 {
			return false
		}
		start := max(size-suffixLength, 0)
		r.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, size-1))
		return true
	}

	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= size {
		return false
	}
	end := size - 1
	if parts[1] == "" {
		end = min(start+4*1024*1024-1, end)
	} else {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || end < start {
			return false
		}
		end = min(end, size-1)
	}
	r.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	return true
}

func writeRangeNotSatisfiable(w http.ResponseWriter, size int64) {
	w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
	w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
}
