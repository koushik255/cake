package cake

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type directoryEntryState struct {
	size     int64
	modified int64
}

func startAutoScan(store *LibraryStore, config Config) {
	go func() {
		previous := mediaDirectoryState(config.MediaDir)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		var changedAt time.Time
		for range ticker.C {
			current := mediaDirectoryState(config.MediaDir)
			if !sameDirectoryState(previous, current) {
				previous = current
				changedAt = time.Now()
				continue
			}
			if changedAt.IsZero() || time.Since(changedAt) < time.Duration(config.AutoScanDelaySeconds)*time.Second {
				continue
			}
			changedAt = time.Time{}
			if _, err := store.Rescan(); err != nil {
				log.Printf("automatic library scan failed: %v", err)
			}
		}
	}()
}

func mediaDirectoryState(root string) map[string]directoryEntryState {
	state := map[string]directoryEntryState{}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if path != root && strings.HasPrefix(entry.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() || strings.HasPrefix(entry.Name(), ".") {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if !videoExtensions[ext] && !subtitleExtensions[ext] {
			return nil
		}
		if info, statErr := entry.Info(); statErr == nil {
			state[path] = directoryEntryState{size: info.Size(), modified: info.ModTime().UnixNano()}
		}
		return nil
	})
	return state
}

func sameDirectoryState(a, b map[string]directoryEntryState) bool {
	if len(a) != len(b) {
		return false
	}
	for path, state := range a {
		if b[path] != state {
			return false
		}
	}
	return true
}
