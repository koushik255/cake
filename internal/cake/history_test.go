package cake

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWatchHistoryPersistenceAndIsolation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	store := NewWatchHistoryStore(path)
	first, second, other := 12, 98, 99
	if _, err := store.MarkWatched("profile-1", "movie-1", &first); err != nil {
		t.Fatal(err)
	}
	replacement, err := store.MarkWatched("profile-1", "movie-1", &second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkWatched("profile-2", "movie-1", &other); err != nil {
		t.Fatal(err)
	}

	found, err := NewWatchHistoryStore(path).Find("profile-1", "movie-1")
	if err != nil {
		t.Fatal(err)
	}
	if found == nil || found.WatchedAt != replacement.WatchedAt || found.PlaybackSeconds == nil || *found.PlaybackSeconds != 98 {
		t.Fatalf("found = %#v", found)
	}
	missing, err := store.Find("profile-404", "movie-1")
	if err != nil || missing != nil {
		t.Fatalf("missing = %#v, %v", missing, err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if _, legacyWritten := raw["items"]; legacyWritten {
		t.Fatal("legacy top-level items were written")
	}
}

func TestWatchHistoryReadsLegacyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	if err := os.WriteFile(path, []byte(`{"items":[{"id":"movie-1","watchedAt":"2026-02-03T04:05:06.000Z"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	found, err := NewWatchHistoryStore(path).Find("koushik", "movie-1")
	if err != nil || found == nil || found.PlaybackSeconds != nil {
		t.Fatalf("found = %#v, %v", found, err)
	}
}
