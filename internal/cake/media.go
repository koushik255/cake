package cake

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type processState struct {
	mu   sync.RWMutex
	done chan struct{}
	err  error
}

func (s *processState) setError(err error) {
	s.mu.Lock()
	s.err = err
	s.mu.Unlock()
}

func (s *processState) Error() error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.err
}

type MediaProcessor struct {
	config Config
	mu     sync.Mutex

	hls          map[string]*processState
	audio        map[string]*processState
	thumbs       map[string]*processState
	accessWrites map[string]time.Time

	transcodeSlots chan struct{}
	thumbnailSlots chan struct{}
}

func NewMediaProcessor(config Config) (*MediaProcessor, error) {
	if err := os.MkdirAll(config.TranscodeCacheDir, 0o755); err != nil {
		return nil, err
	}
	processor := &MediaProcessor{
		config:         config,
		hls:            make(map[string]*processState),
		audio:          make(map[string]*processState),
		thumbs:         make(map[string]*processState),
		accessWrites:   make(map[string]time.Time),
		transcodeSlots: make(chan struct{}, config.MaxTranscodes),
		thumbnailSlots: make(chan struct{}, 2),
	}
	if err := processor.cleanup(); err != nil {
		return nil, err
	}
	go processor.runHourlyCleanup()
	return processor, nil
}

func (p *MediaProcessor) runHourlyCleanup() {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		_ = p.cleanup()
	}
}

var hlsContentTypes = map[string]string{
	".m3u8": "application/vnd.apple.mpegurl; charset=utf-8",
	".m4s":  "video/mp4",
	".mp4":  "video/mp4",
	".ts":   "video/mp2t",
}

func (p *MediaProcessor) ServeHLS(w http.ResponseWriter, r *http.Request, item MediaFile, hlsPath string) error {
	if _, err := os.Stat(item.Path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(
				w,
				"Media file is missing. Rescan the library to remove stale entries: "+item.RelativePath,
				http.StatusNotFound,
			)
			return nil
		}
		return err
	}
	root := p.hlsRoot(item)
	filePath, ok := safeCachePath(root, hlsPath)
	if !ok {
		http.NotFound(w, r)
		return nil
	}
	if !regularFile(filepath.Join(root, ".complete")) || p.active(p.hls, root) {
		p.ensureHLS(item, root)
	}
	timeout := 30 * time.Second
	if strings.HasSuffix(hlsPath, ".m3u8") {
		timeout = 60 * time.Second
	}
	if !waitForFile(filePath, timeout) {
		state := p.state(p.hls, root)
		if state != nil && state.Error() != nil {
			http.Error(w, state.Error().Error(), http.StatusInternalServerError)
		} else {
			http.Error(w, "Transcode output is not ready", http.StatusServiceUnavailable)
		}
		return nil
	}
	_ = p.touchCache(root)
	if strings.HasSuffix(hlsPath, ".m3u8") {
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
	} else {
		w.Header().Set("Cache-Control", "private, max-age=86400")
	}
	w.Header().Set("X-Cake-Transcode", "hls")
	if contentType := hlsContentTypes[filepath.Ext(filePath)]; contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	http.ServeFile(w, r, filePath)
	return nil
}

func (p *MediaProcessor) ensureHLS(item MediaFile, root string) {
	p.mu.Lock()
	if _, ok := p.hls[root]; ok {
		p.mu.Unlock()
		return
	}
	state := &processState{done: make(chan struct{})}
	p.hls[root] = state
	p.mu.Unlock()

	go func() {
		p.transcodeSlots <- struct{}{}
		defer func() {
			<-p.transcodeSlots
			close(state.done)
			p.mu.Lock()
			if state.Error() == nil {
				delete(p.hls, root)
			}
			p.mu.Unlock()
		}()
		_ = os.RemoveAll(root)
		if err := os.MkdirAll(root, 0o755); err != nil {
			state.setError(err)
			return
		}
		state.setError(p.transcodeHLS(item, root))
		if state.Error() == nil {
			state.setError(os.WriteFile(filepath.Join(root, ".complete"), []byte("complete\n"), 0o644))
		}
	}()
}

func (p *MediaProcessor) transcodeHLS(item MediaFile, root string) error {
	video := []string{"-c:v", "copy"}
	if p.config.TranscodeVideoMode == "avc" {
		video = []string{
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
			"-vf", "scale=-2:min(720\\,ih)",
			"-force_key_frames", "expr:gte(t,n_forced*2)",
		}
	}
	audioCodec, segmentExtension := "aac", ".ts"
	format := []string{}
	if p.config.TranscodeAudioCodec == "opus" {
		audioCodec = "libopus"
		segmentExtension = ".m4s"
		format = []string{"-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4"}
	}
	args := []string{
		"-hide_banner", "-loglevel", "warning", "-y",
	}
	if p.config.HardwareAcceleration == "auto" {
		args = append(args, "-hwaccel", "auto")
	}
	args = append(args,
		"-i", item.Path,
		"-map", "0:v:0", "-map", "0:a:0?",
	)
	args = append(args, video...)
	args = append(args,
		"-c:a", audioCodec, "-b:a", "128k", "-f", "hls",
		"-hls_time", "2", "-hls_list_size", "0",
	)
	args = append(args, format...)
	args = append(args,
		"-hls_segment_filename", filepath.Join(root, "segment-%d"+segmentExtension),
		filepath.Join(root, "master.m3u8"),
	)
	return commandError(exec.Command("ffmpeg", args...))
}

func (p *MediaProcessor) hlsRoot(item MediaFile) string {
	cacheVersion := strings.Join([]string{
		"hls", p.config.TranscodeVideoMode,
		p.config.TranscodeAudioCodec, mediaVersion(item),
	}, "-")
	return filepath.Join(p.config.TranscodeCacheDir, item.ID, cacheVersion)
}

func (p *MediaProcessor) ServeOpusAudio(w http.ResponseWriter, r *http.Request, item MediaFile) error {
	root := filepath.Join(p.config.TranscodeCacheDir, item.ID, "audio-opus-"+mediaVersion(item))
	path := filepath.Join(root, "audio.ogg")
	if !regularFile(path) {
		state := p.ensureAudio(item, root, path)
		<-state.done
		if state.Error() != nil {
			http.Error(w, state.Error().Error(), http.StatusInternalServerError)
			return nil
		}
	}
	_ = p.touchCache(root)
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !normalizeRange(r, info.Size()) {
		writeRangeNotSatisfiable(w, info.Size())
		return nil
	}
	w.Header().Set("Content-Type", "audio/ogg")
	http.ServeContent(w, r, "audio.ogg", info.ModTime(), file)
	return nil
}

func (p *MediaProcessor) ensureAudio(item MediaFile, root, path string) *processState {
	p.mu.Lock()
	if state := p.audio[root]; state != nil {
		p.mu.Unlock()
		return state
	}
	state := &processState{done: make(chan struct{})}
	p.audio[root] = state
	p.mu.Unlock()

	go func() {
		defer func() {
			close(state.done)
			p.mu.Lock()
			delete(p.audio, root)
			p.mu.Unlock()
		}()
		if err := os.MkdirAll(root, 0o755); err != nil {
			state.setError(err)
			return
		}
		partial := filepath.Join(root, "audio.partial.ogg")
		_ = os.Remove(partial)
		args := []string{
			"-hide_banner", "-loglevel", "error", "-y", "-i", item.Path,
			"-map", "0:a:0", "-vn", "-c:a", "libopus", "-b:a", "128k",
			partial,
		}
		state.setError(commandError(exec.Command("ffmpeg", args...)))
		if state.Error() == nil {
			state.setError(os.Rename(partial, path))
		} else {
			_ = os.Remove(partial)
		}
	}()
	return state
}

func (p *MediaProcessor) ServeEmbeddedSubtitle(w http.ResponseWriter, r *http.Request, item MediaFile, index int) error {
	renderable := false
	for _, track := range item.EmbeddedSubtitles {
		if track.StreamIndex != nil && *track.StreamIndex == index && track.Renderable {
			renderable = true
			break
		}
	}
	if !renderable {
		http.NotFound(w, r)
		return nil
	}
	filename := fmt.Sprintf("%s-%d-%s.vtt", item.ID, index, mediaVersion(item))
	path := filepath.Join(".cache/subtitles", filename)
	if !regularFile(path) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		command := exec.Command(
			"ffmpeg", "-v", "error", "-i", item.Path,
			"-map", fmt.Sprintf("0:%d", index), "-f", "webvtt", "-",
		)
		output, err := command.CombinedOutput()
		if err != nil {
			http.Error(w, strings.TrimSpace(string(output)), http.StatusInternalServerError)
			return nil
		}
		if err = os.WriteFile(path, output, 0o644); err != nil {
			return err
		}
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeFile(w, r, path)
	return nil
}

func (p *MediaProcessor) ServeThumbnail(w http.ResponseWriter, r *http.Request, item MediaFile, requested *float64) error {
	seconds := thumbnailSeconds(item, requested)
	path := filepath.Join(
		".cache/thumbnails", item.ID,
		fmt.Sprintf("%s-%d.jpg", mediaVersion(item), seconds),
	)
	if !regularFile(path) {
		state := p.ensureThumbnail(item, seconds, path)
		<-state.done
		if state.Error() != nil {
			http.Error(w, state.Error().Error(), http.StatusInternalServerError)
			return nil
		}
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeFile(w, r, path)
	return nil
}

func thumbnailSeconds(item MediaFile, requested *float64) int {
	seconds := 0
	if requested != nil && *requested >= 0 {
		seconds = int(*requested)
	}
	if item.DurationSeconds != nil && seconds > int(*item.DurationSeconds)-1 {
		seconds = max(0, int(*item.DurationSeconds)-1)
	}
	return seconds
}

func (p *MediaProcessor) ensureThumbnail(item MediaFile, seconds int, path string) *processState {
	p.mu.Lock()
	if state := p.thumbs[path]; state != nil {
		p.mu.Unlock()
		return state
	}
	state := &processState{done: make(chan struct{})}
	p.thumbs[path] = state
	p.mu.Unlock()

	go func() {
		p.thumbnailSlots <- struct{}{}
		defer func() {
			<-p.thumbnailSlots
			close(state.done)
			p.mu.Lock()
			delete(p.thumbs, path)
			p.mu.Unlock()
		}()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			state.setError(err)
			return
		}
		partial := path + ".partial.jpg"
		_ = os.Remove(partial)
		args := []string{
			"-hide_banner", "-loglevel", "error", "-ss", strconv.Itoa(seconds),
			"-i", item.Path, "-frames:v", "1", "-vf", "scale=480:-2",
			"-q:v", "4", "-y", partial,
		}
		state.setError(commandError(exec.Command("ffmpeg", args...)))
		if state.Error() == nil {
			state.setError(os.Rename(partial, path))
		} else {
			_ = os.Remove(partial)
		}
	}()
	return state
}

func (p *MediaProcessor) active(states map[string]*processState, key string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return states[key] != nil
}

func (p *MediaProcessor) state(states map[string]*processState, key string) *processState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return states[key]
}

func (p *MediaProcessor) cleanup() error {
	cutoff := time.Now().Add(-time.Duration(p.config.TranscodeCacheMaxAgeHours) * time.Hour)
	entries, err := os.ReadDir(p.config.TranscodeCacheDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, media := range entries {
		if !media.IsDir() {
			continue
		}
		mediaRoot := filepath.Join(p.config.TranscodeCacheDir, media.Name())
		if err := p.cleanupMediaRoot(mediaRoot, cutoff); err != nil {
			return err
		}
	}
	return nil
}

func (p *MediaProcessor) cleanupMediaRoot(mediaRoot string, cutoff time.Time) error {
	caches, err := os.ReadDir(mediaRoot)
	if err != nil {
		return err
	}
	for _, cache := range caches {
		isMediaCache := strings.HasPrefix(cache.Name(), "hls-") ||
			strings.HasPrefix(cache.Name(), "audio-")
		if !cache.IsDir() || !isMediaCache {
			continue
		}
		root := filepath.Join(mediaRoot, cache.Name())
		if p.active(p.hls, root) || p.active(p.audio, root) {
			continue
		}
		if accessed, ok := cacheAccessTime(root); ok && accessed.Before(cutoff) {
			_ = os.RemoveAll(root)
			p.mu.Lock()
			delete(p.accessWrites, root)
			p.mu.Unlock()
		}
	}
	remaining, err := os.ReadDir(mediaRoot)
	if err == nil && len(remaining) == 0 {
		_ = os.Remove(mediaRoot)
	}
	return nil
}

func cacheAccessTime(root string) (time.Time, bool) {
	paths := []string{filepath.Join(root, ".accessed"), filepath.Join(root, ".complete"), root}
	for _, path := range paths {
		if info, err := os.Stat(path); err == nil {
			return info.ModTime(), true
		}
	}
	return time.Time{}, false
}

func safeCachePath(root, child string) (string, bool) {
	if filepath.IsAbs(child) {
		return "", false
	}
	clean := filepath.Clean(filepath.FromSlash(child))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.Join(root, clean), true
}

func mediaVersion(item MediaFile) string {
	var version strings.Builder
	for _, character := range item.ModifiedAt {
		isASCIIAlphaNumeric := character >= '0' && character <= '9' ||
			character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z'
		if isASCIIAlphaNumeric {
			version.WriteRune(character)
		}
	}
	return version.String()
}

func regularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

func waitForFile(path string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if regularFile(path) {
			return true
		}
		time.Sleep(250 * time.Millisecond)
	}
	return false
}

func (p *MediaProcessor) touchCache(root string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	lastWrite := p.accessWrites[root]
	if time.Since(lastWrite) < 5*time.Minute {
		return nil
	}

	contents := strconv.FormatInt(time.Now().UnixMilli(), 10) + "\n"
	if err := os.WriteFile(filepath.Join(root, ".accessed"), []byte(contents), 0o644); err != nil {
		return err
	}
	p.accessWrites[root] = time.Now()
	return nil
}

func commandError(command *exec.Cmd) error {
	output, err := command.CombinedOutput()
	if err == nil {
		return nil
	}
	message := strings.TrimSpace(string(output))
	if message == "" {
		message = err.Error()
	}
	return errors.New(message)
}
