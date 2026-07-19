package cake

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMediaCachePaths(t *testing.T) {
	item := MediaFile{ID: "abc", ModifiedAt: "2026-07-17T23:33:51.244Z"}
	if got, want := mediaVersion(item), "20260717T233351244Z"; got != want {
		t.Fatalf("mediaVersion = %q, want %q", got, want)
	}
	root := filepath.Join(t.TempDir(), "cache")
	if _, ok := safeCachePath(root, "../secret"); ok {
		t.Fatal("parent traversal was accepted")
	}
	if got, ok := safeCachePath(root, "segment-1.ts"); !ok || got != filepath.Join(root, "segment-1.ts") {
		t.Fatalf("safe path = %q, %v", got, ok)
	}
}

func TestCacheAccessWritesAreThrottled(t *testing.T) {
	root := t.TempDir()
	processor := &MediaProcessor{accessWrites: make(map[string]time.Time)}
	if err := processor.touchCache(root); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, ".accessed")
	first, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if err := processor.touchCache(root); err != nil {
		t.Fatal(err)
	}
	second, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !first.ModTime().Equal(second.ModTime()) {
		t.Fatal("cache access marker was rewritten inside the throttle window")
	}
}
