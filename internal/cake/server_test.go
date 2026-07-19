package cake

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testApp(t *testing.T) (*App, MediaFile) {
	t.Helper()
	dir := t.TempDir()
	mediaPath := filepath.Join(dir, "sample.mp4")
	if err := os.WriteFile(mediaPath, []byte("0123456789abcdef"), 0o644); err != nil {
		t.Fatal(err)
	}
	item := MediaFile{
		ID: "media-id", Kind: Movie, Title: "Sample", Path: mediaPath,
		RelativePath: "sample.mp4", Size: 16,
		ModifiedAt: "2026-01-01T00:00:00.000Z",
		Extension:  ".mp4", MIMEType: "video/mp4",
		SidecarSubtitles: []SidecarSubtitle{},
	}
	library := &Library{MediaDir: dir, ScannedAt: "2026-01-01T00:00:00.000Z", Items: []MediaFile{item}}
	store := NewLibraryStore(dir, filepath.Join(dir, "library.json"))
	store.set(library)
	return &App{
		config: Config{PlaybackMode: "auto"}, library: store,
		profiles: NewProfileStore(filepath.Join(dir, "profiles.json")),
		history:  NewWatchHistoryStore(filepath.Join(dir, "history.json")),
		static:   newStaticHandler(),
	}, item
}

func TestLibraryAPIAndRangeStreaming(t *testing.T) {
	app, item := testApp(t)
	recorder := httptest.NewRecorder()
	app.ServeHTTP(recorder, httptest.NewRequest("GET", "/api/library", nil))
	if recorder.Code != 200 || recorder.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("library response: %d %v", recorder.Code, recorder.Header())
	}
	var payload LibraryPayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Count != 1 || len(payload.Movies) != 1 || payload.Movies[0].ID != item.ID {
		t.Fatalf("payload = %#v", payload)
	}

	recorder = httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/stream/media-id/direct", nil)
	request.Header.Set("Range", "bytes=3-7")
	app.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusPartialContent || recorder.Body.String() != "34567" ||
		recorder.Header().Get("Content-Range") != "bytes 3-7/16" {
		t.Fatalf("range: code=%d body=%q headers=%v", recorder.Code, recorder.Body.String(), recorder.Header())
	}
}

func TestProfileHistoryAndMediaAPI(t *testing.T) {
	app, item := testApp(t)
	recorder := httptest.NewRecorder()
	profileRequest := httptest.NewRequest("POST", "/profiles", strings.NewReader("name=Alice"))
	profileRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	app.ServeHTTP(recorder, profileRequest)
	request := httptest.NewRequest("POST", "/api/watch-history/"+item.ID, strings.NewReader(`{"playbackSeconds":42.4}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cookie", recorder.Header().Get("Set-Cookie"))
	historyResponse := httptest.NewRecorder()
	app.ServeHTTP(historyResponse, request)
	if historyResponse.Code != 200 {
		body, _ := io.ReadAll(historyResponse.Body)
		t.Fatalf("history: %d %s", historyResponse.Code, body)
	}
	request = httptest.NewRequest("GET", "/api/media/"+item.ID, nil)
	request.Header.Set("Cookie", recorder.Header().Get("Set-Cookie"))
	mediaResponse := httptest.NewRecorder()
	app.ServeHTTP(mediaResponse, request)
	var payload MediaPayload
	if err := json.Unmarshal(mediaResponse.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.PlaybackSeconds == nil || *payload.PlaybackSeconds != 42 || payload.StreamURL != "/stream/media-id/direct" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestProfileAndPlayerPagesPreserveBrowserContract(t *testing.T) {
	app, item := testApp(t)
	profiles := httptest.NewRecorder()
	app.ServeHTTP(profiles, httptest.NewRequest("GET", "/profiles", nil))
	if profiles.Code != 200 || !strings.Contains(profiles.Body.String(), `action="/profiles"`) {
		t.Fatalf("profiles page: %d %q", profiles.Code, profiles.Body.String())
	}
	profile, err := app.profiles.Create("Alice")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "/watch/"+item.ID, nil)
	request.AddCookie(&http.Cookie{Name: "cake_profile", Value: profile.ID})
	player := httptest.NewRecorder()
	app.ServeHTTP(player, request)
	body := player.Body.String()
	requiredSelectors := []string{
		`data-mediabunny-player`, `data-media-id="media-id"`,
		`id="mediabunny-canvas"`, `id="play-button"`,
		`id="progress"`, `src="/player.js`,
	}
	for _, required := range requiredSelectors {
		if !strings.Contains(body, required) {
			t.Errorf("player page lacks %s", required)
		}
	}
}

func TestEmbeddedFrontendAssets(t *testing.T) {
	app, _ := testApp(t)
	tests := []struct {
		path     string
		contains string
		cache    string
	}{
		{"/app.css", ".player-frame", "no-store"},
		{"/player.js", "/vendor/mediabunny/index.js", "no-store"},
		{"/vendor/mediabunny/index.js", "ALL_FORMATS", "immutable"},
		{"/vendor/shared/aac-misc.js", "Bitstream", "immutable"},
		{"/vendor/mediabunny/node.js", "fs = undefined", "immutable"},
	}
	for _, test := range tests {
		response := httptest.NewRecorder()
		app.ServeHTTP(response, httptest.NewRequest("GET", test.path, nil))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), test.contains) {
			t.Errorf("GET %s: status=%d body=%q", test.path, response.Code, response.Body.String())
		}
		if cache := response.Header().Get("Cache-Control"); !strings.Contains(cache, test.cache) {
			t.Errorf("GET %s: Cache-Control=%q", test.path, cache)
		}
	}
}

func TestOpenEndedRangesAreCappedAtFourMiB(t *testing.T) {
	request := httptest.NewRequest("GET", "/stream/id/direct", nil)
	request.Header.Set("Range", "bytes=10-")
	if !normalizeRange(request, 20*1024*1024) {
		t.Fatal("valid range was rejected")
	}
	if got, want := request.Header.Get("Range"), "bytes=10-4194313"; got != want {
		t.Fatalf("Range = %q, want %q", got, want)
	}
}

func TestInvalidAndMultipleRangesMatchDenoBehavior(t *testing.T) {
	for _, value := range []string{"items=0-1", "bytes=", "bytes=1-2,4-5", "bytes=5-2", "bytes=20-"} {
		request := httptest.NewRequest("GET", "/stream/id/direct", nil)
		request.Header.Set("Range", value)
		if normalizeRange(request, 16) {
			t.Errorf("range %q was accepted", value)
		}
	}
}

func TestInvalidRangeResponseMatchesDeno(t *testing.T) {
	app, _ := testApp(t)
	request := httptest.NewRequest("GET", "/stream/media-id/direct", nil)
	request.Header.Set("Range", "bytes=1-2,4-5")
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)
	if response.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("Content-Range"); got != "bytes */16" {
		t.Fatalf("Content-Range = %q", got)
	}
}

func TestUnknownRouteUsesHTMLNotFoundPage(t *testing.T) {
	app, _ := testApp(t)
	response := httptest.NewRecorder()
	app.ServeHTTP(response, httptest.NewRequest("GET", "/missing", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if !strings.Contains(response.Header().Get("Content-Type"), "text/html") ||
		!strings.Contains(response.Body.String(), "Not found") {
		t.Fatalf("unexpected response: %v %q", response.Header(), response.Body.String())
	}
}
