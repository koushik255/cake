package cake

import (
	"encoding/json"
	"errors"
	"os"
	"sync"
	"time"
)

type profileWatchHistory struct {
	Items []WatchHistoryEntry `json:"items"`
}

type watchHistoryFile struct {
	Profiles map[string]profileWatchHistory `json:"profiles"`
	Items    []WatchHistoryEntry            `json:"items,omitempty"`
}

type LastWatchedItem struct {
	Item            MediaFile
	WatchedAt       string
	PlaybackSeconds *int
}

type WatchHistoryStore struct {
	path string
	mu   sync.Mutex
}

func NewWatchHistoryStore(path string) *WatchHistoryStore {
	return &WatchHistoryStore{path: path}
}

func (s *WatchHistoryStore) MarkWatched(profileID, id string, seconds *int) (WatchHistoryEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	history, err := s.load()
	if err != nil {
		return WatchHistoryEntry{}, err
	}
	entry := WatchHistoryEntry{
		ID: id, WatchedAt: isoTime(time.Now()), PlaybackSeconds: seconds,
	}
	items := []WatchHistoryEntry{entry}
	for _, old := range history.Profiles[profileID].Items {
		if old.ID != id && len(items) < 100 {
			items = append(items, old)
		}
	}
	history.Profiles[profileID] = profileWatchHistory{Items: items}
	data, err := json.MarshalIndent(watchHistoryFile{Profiles: history.Profiles}, "", "  ")
	if err == nil {
		data = append(data, '\n')
		err = writeFileAtomic(s.path, data, 0o644)
	}
	return entry, err
}

func (s *WatchHistoryStore) Find(profileID, id string) (*WatchHistoryEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	history, err := s.load()
	if err != nil {
		return nil, err
	}
	for _, entry := range history.Profiles[profileID].Items {
		if entry.ID == id {
			return &entry, nil
		}
	}
	return nil, nil
}

func (s *WatchHistoryStore) Recent(profileID string, library *Library, limit int) ([]LastWatchedItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	history, err := s.load()
	if err != nil {
		return nil, err
	}
	byID := make(map[string]MediaFile, len(library.Items))
	for _, item := range library.Items {
		byID[item.ID] = item
	}
	result := make([]LastWatchedItem, 0, limit)
	for _, entry := range history.Profiles[profileID].Items {
		if item, ok := byID[entry.ID]; ok {
			result = append(result, LastWatchedItem{
				Item: item, WatchedAt: entry.WatchedAt,
				PlaybackSeconds: entry.PlaybackSeconds,
			})
			if len(result) == limit {
				break
			}
		}
	}
	return result, nil
}

func (s *WatchHistoryStore) load() (watchHistoryFile, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return watchHistoryFile{Profiles: map[string]profileWatchHistory{}}, nil
	}
	if err != nil {
		return watchHistoryFile{}, err
	}
	var f watchHistoryFile
	if json.Unmarshal(data, &f) != nil {
		return watchHistoryFile{Profiles: map[string]profileWatchHistory{}}, nil
	}
	if f.Profiles == nil {
		f.Profiles = map[string]profileWatchHistory{"koushik": {Items: f.Items}}
	}
	return f, nil
}
