package cake

import (
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

type App struct {
	config   Config
	library  *LibraryStore
	profiles *ProfileStore
	history  *WatchHistoryStore
	static   http.Handler
	media    *MediaProcessor

	apiCache struct {
		sync.Mutex
		scannedAt string
		library   []byte
		movies    []byte
		episodes  []byte
	}
}

func NewApp(config Config) (*App, error) {
	processor, err := NewMediaProcessor(config)
	if err != nil {
		return nil, err
	}
	app := &App{
		config:   config,
		library:  NewLibraryStore(config.MediaDir, config.LibraryFile),
		profiles: NewProfileStore(".cache/profiles.json"),
		history:  NewWatchHistoryStore(".cache/watch-history.json"),
		static:   newStaticHandler(),
		media:    processor,
	}
	if config.AutoScan {
		startAutoScan(app.library, config)
	}
	return app, nil
}

func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if value := recover(); value != nil {
			log.Printf("panic: %v", value)
			http.Error(w, fmt.Sprint(value), http.StatusInternalServerError)
		}
	}()
	if err := a.serve(w, r); err != nil {
		log.Printf("%s %s: %v", r.Method, r.URL.Path, err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (a *App) serve(w http.ResponseWriter, r *http.Request) error {
	path := r.URL.Path
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) && a.serveStatic(w, r) {
		return nil
	}

	switch {
	case r.Method == http.MethodGet && path == "/api/library":
		return a.serveLibraryAPI(w, "library")
	case r.Method == http.MethodGet && path == "/api/movies":
		return a.serveLibraryAPI(w, "movies")
	case r.Method == http.MethodGet && path == "/api/tv":
		return a.serveLibraryAPI(w, "episodes")
	case r.Method == http.MethodGet && path == "/api/library-version":
		return a.serveLibraryVersion(w)
	case r.Method == http.MethodPost && path == "/api/rescan":
		return a.rescanAPI(w)
	case r.Method == http.MethodGet && isMediaAPIPath(path):
		return a.serveMediaAPI(w, r)
	case r.Method == http.MethodPost && isSingleValuePath(path, "/api/watch-history/"):
		return a.markWatched(w, r)
	case r.Method == http.MethodGet && isStreamPath(path):
		return a.streamMedia(w, r)
	case (r.Method == http.MethodGet || r.Method == http.MethodHead) && isHLSPath(path):
		return a.streamHLS(w, r)
	case (r.Method == http.MethodGet || r.Method == http.MethodHead) && isAudioPath(path):
		return a.streamAudio(w, r)
	case r.Method == http.MethodGet && hasPathParts(path, "/embedded-subtitles/", 2):
		return a.streamEmbeddedSubtitle(w, r)
	case r.Method == http.MethodGet && isThumbnailPath(path):
		return a.streamThumbnail(w, r)
	case r.Method == http.MethodGet && hasPathParts(path, "/subtitles/", 2):
		return a.streamSidecar(w, r)
	case path == "/profiles" && r.Method == http.MethodGet:
		return a.servePage(w, r)
	case path == "/profiles" && r.Method == http.MethodPost:
		return a.createProfile(w, r)
	case r.Method == http.MethodPost && isSingleValuePath(path, "/profiles/select/"):
		return a.selectProfile(w, r)
	case r.Method == http.MethodPost && path == "/rescan":
		return a.rescanPage(w, r)
	case r.Method == http.MethodGet && isPageRoute(path):
		return a.servePage(w, r)
	default:
		return serveNotFoundPage(w, nil)
	}
}

func (a *App) createProfile(w http.ResponseWriter, r *http.Request) error {
	if err := r.ParseForm(); err != nil {
		return err
	}
	profile, err := a.profiles.Create(r.FormValue("name"))
	if err != nil {
		return err
	}
	setProfileCookie(w, profile)
	http.Redirect(w, r, "/", http.StatusSeeOther)
	return nil
}

func (a *App) selectProfile(w http.ResponseWriter, r *http.Request) error {
	id, _ := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/profiles/select/"))
	profile, err := a.profiles.Find(id)
	if err != nil {
		return err
	}
	if profile == nil {
		return serveNotFoundPage(w, nil)
	}
	setProfileCookie(w, *profile)
	http.Redirect(w, r, "/", http.StatusSeeOther)
	return nil
}

func (a *App) rescanPage(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.library.Rescan(); err != nil {
		return err
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
	return nil
}

func (a *App) currentProfile(r *http.Request) (*Profile, error) {
	return a.profiles.Find(selectedProfileID(r))
}

func isPageRoute(path string) bool {
	return path == "/" || path == "/movies" || path == "/shows" || path == "/tv" ||
		isSingleValuePath(path, "/shows/") || isSingleValuePath(path, "/watch/")
}

func isMediaAPIPath(path string) bool {
	parts, ok := pathParts(path, "/api/media/")
	return ok && (len(parts) == 1 || len(parts) == 2 && parts[1] == "playback")
}

func isStreamPath(path string) bool {
	parts, ok := pathParts(path, "/stream/")
	return ok && (len(parts) == 1 || len(parts) == 2 && (parts[1] == "direct" || parts[1] == "transcode"))
}

func isHLSPath(path string) bool {
	tail := strings.TrimPrefix(path, "/hls/")
	parts := strings.SplitN(tail, "/", 2)
	return strings.HasPrefix(path, "/hls/") && len(parts) == 2 && parts[0] != "" && parts[1] != ""
}

func isAudioPath(path string) bool {
	parts, ok := pathParts(path, "/audio-transcode/")
	return ok && len(parts) == 2 && parts[1] == "audio.ogg"
}

func isThumbnailPath(path string) bool {
	parts, ok := pathParts(path, "/thumbnails/")
	return ok && len(parts) == 1 && strings.HasSuffix(parts[0], ".jpg") && parts[0] != ".jpg"
}

func isSingleValuePath(path, prefix string) bool {
	parts, ok := pathParts(path, prefix)
	return ok && len(parts) == 1
}

func hasPathParts(path, prefix string, count int) bool {
	parts, ok := pathParts(path, prefix)
	return ok && len(parts) == count
}

func pathParts(path, prefix string) ([]string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return nil, false
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	for _, part := range parts {
		if part == "" {
			return nil, false
		}
	}
	return parts, true
}
