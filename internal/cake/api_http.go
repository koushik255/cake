package cake

import (
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

func (a *App) serveLibraryAPI(w http.ResponseWriter, kind string) error {
	library, err := a.library.Load()
	if err != nil {
		return err
	}
	data, err := a.cachedLibraryJSON(library, kind)
	if err != nil {
		return err
	}
	writeJSONBytes(w, data, http.StatusOK)
	return nil
}

func (a *App) serveLibraryVersion(w http.ResponseWriter) error {
	library, err := a.library.Load()
	if err != nil {
		return err
	}
	writeJSON(w, map[string]any{
		"scannedAt": library.ScannedAt,
		"count":     len(library.Items),
	}, http.StatusOK)
	return nil
}

func (a *App) rescanAPI(w http.ResponseWriter) error {
	library, err := a.library.Rescan()
	if err != nil {
		return err
	}
	writeJSON(w, libraryPayload(library), http.StatusOK)
	return nil
}

func (a *App) serveMediaAPI(w http.ResponseWriter, r *http.Request) error {
	tail := strings.TrimPrefix(r.URL.Path, "/api/media/")
	playbackOnly := strings.HasSuffix(tail, "/playback")
	if playbackOnly {
		tail = strings.TrimSuffix(tail, "/playback")
	}
	id, _ := url.PathUnescape(tail)
	item, err := a.library.Find(id)
	if err != nil {
		return err
	}
	if item == nil {
		writeJSON(w, map[string]string{"error": "Not found"}, http.StatusNotFound)
		return nil
	}
	if playbackOnly {
		writeJSON(w, playbackDecision(*item, a.config.PlaybackMode), http.StatusOK)
		return nil
	}

	library, err := a.library.Load()
	if err != nil {
		return err
	}
	profile, err := a.currentProfile(r)
	if err != nil {
		return err
	}
	var playbackSeconds *int
	if profile != nil {
		entry, err := a.history.Find(profile.ID, item.ID)
		if err != nil {
			return err
		}
		if entry != nil {
			playbackSeconds = entry.PlaybackSeconds
		}
	}
	payload := mediaPayload(*item, a.config, nextEpisode(*item, library.Items), playbackSeconds)
	writeJSON(w, payload, http.StatusOK)
	return nil
}

func (a *App) markWatched(w http.ResponseWriter, r *http.Request) error {
	profile, err := a.currentProfile(r)
	if err != nil {
		return err
	}
	if profile == nil {
		writeJSON(w, map[string]string{"error": "No profile selected"}, http.StatusBadRequest)
		return nil
	}
	id, _ := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/api/watch-history/"))
	item, err := a.library.Find(id)
	if err != nil {
		return err
	}
	if item == nil {
		writeJSON(w, map[string]string{"error": "Not found"}, http.StatusNotFound)
		return nil
	}

	var body struct {
		PlaybackSeconds *float64 `json:"playbackSeconds"`
	}
	var seconds *int
	isJSON := strings.Contains(r.Header.Get("Content-Type"), "application/json")
	if isJSON && json.NewDecoder(r.Body).Decode(&body) == nil && body.PlaybackSeconds != nil {
		rounded := int(*body.PlaybackSeconds + 0.5)
		if rounded < 0 {
			rounded = 0
		}
		seconds = &rounded
	}
	entry, err := a.history.MarkWatched(profile.ID, id, seconds)
	if err != nil {
		return err
	}
	writeJSON(w, entry, http.StatusOK)
	return nil
}

func writeJSON(w http.ResponseWriter, value any, status int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
}

func writeJSONBytes(w http.ResponseWriter, data []byte, status int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func (a *App) cachedLibraryJSON(library *Library, kind string) ([]byte, error) {
	a.apiCache.Lock()
	defer a.apiCache.Unlock()
	if a.apiCache.scannedAt != library.ScannedAt {
		payload := libraryPayload(library)
		var err error
		if a.apiCache.library, err = json.Marshal(payload); err != nil {
			return nil, err
		}
		if a.apiCache.movies, err = json.Marshal(payload.Movies); err != nil {
			return nil, err
		}
		if a.apiCache.episodes, err = json.Marshal(payload.Episodes); err != nil {
			return nil, err
		}
		a.apiCache.library = append(a.apiCache.library, '\n')
		a.apiCache.movies = append(a.apiCache.movies, '\n')
		a.apiCache.episodes = append(a.apiCache.episodes, '\n')
		a.apiCache.scannedAt = library.ScannedAt
	}
	switch kind {
	case "movies":
		return a.apiCache.movies, nil
	case "episodes":
		return a.apiCache.episodes, nil
	default:
		return a.apiCache.library, nil
	}
}

func nextEpisode(item MediaFile, items []MediaFile) *MediaFile {
	if item.Kind != Episode || item.ShowTitle == "" {
		return nil
	}
	var candidates []MediaFile
	for _, candidate := range items {
		if candidate.Kind == Episode && candidate.ShowTitle == item.ShowTitle && candidate.ID != item.ID {
			candidates = append(candidates, candidate)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if intValue(a.Season) != intValue(b.Season) {
			return intValue(a.Season) < intValue(b.Season)
		}
		return intValue(a.Episode) < intValue(b.Episode)
	})
	for i := range candidates {
		candidate := &candidates[i]
		laterSeason := intValue(candidate.Season) > intValue(item.Season)
		laterEpisode := intValue(candidate.Season) == intValue(item.Season) &&
			intValue(candidate.Episode) > intValue(item.Episode)
		if laterSeason || laterEpisode {
			return candidate
		}
	}
	return nil
}
