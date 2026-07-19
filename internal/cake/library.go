package cake

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

type LibraryStore struct {
	mediaDir, libraryFile string
	mu                    sync.RWMutex
	library               *Library
	items                 map[string]*MediaFile
	scanMu                sync.Mutex
}

func NewLibraryStore(mediaDir, libraryFile string) *LibraryStore {
	return &LibraryStore{mediaDir: mediaDir, libraryFile: libraryFile, items: make(map[string]*MediaFile)}
}

func (s *LibraryStore) Load() (*Library, error) {
	s.mu.RLock()
	current := s.library
	s.mu.RUnlock()
	if current != nil {
		return current, nil
	}
	data, err := os.ReadFile(s.libraryFile)
	if err == nil {
		var library Library
		if json.Unmarshal(data, &library) == nil && library.MediaDir == s.mediaDir {
			return s.set(&library), nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return s.Rescan()
}

func (s *LibraryStore) Find(id string) (*MediaFile, error) {
	if _, err := s.Load(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.items[id], nil
}

func (s *LibraryStore) Rescan() (*Library, error) {
	s.scanMu.Lock()
	defer s.scanMu.Unlock()
	var previous *Library
	s.mu.RLock()
	previous = s.library
	s.mu.RUnlock()
	if previous == nil {
		if data, err := os.ReadFile(s.libraryFile); err == nil {
			var cached Library
			if json.Unmarshal(data, &cached) == nil && cached.MediaDir == s.mediaDir {
				previous = &cached
			}
		}
	}
	library, err := scanLibrary(s.mediaDir, previous)
	if err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(library, "", "  ")
	if err != nil {
		return nil, err
	}
	data = append(data, '\n')
	if err := writeFileAtomic(s.libraryFile, data, 0o644); err != nil {
		return nil, err
	}
	return s.set(library), nil
}

func (s *LibraryStore) set(library *Library) *Library {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.library = library
	s.items = make(map[string]*MediaFile, len(library.Items))
	for i := range library.Items {
		s.items[library.Items[i].ID] = &library.Items[i]
	}
	return library
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".cake-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err = tmp.Chmod(mode); err == nil {
		_, err = tmp.Write(data)
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}
