package cake

import (
	"io"
	"net/http"
	"strings"

	"cake/public"
)

var publicAssets = map[string]bool{
	"/app.css": true, "/player.js": true, "/favicon.svg": true,
	"/favicon.ico": true, "/favicon.png": true, "/favicon-96x96.png": true,
	"/apple-touch-icon.png": true, "/web-app-manifest-192x192.png": true,
	"/web-app-manifest-512x512.png": true, "/site.webmanifest": true,
}

func (a *App) serveStatic(w http.ResponseWriter, r *http.Request) bool {
	if publicAssets[r.URL.Path] {
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
		a.static.ServeHTTP(w, r)
		return true
	}
	if strings.HasPrefix(r.URL.Path, "/vendor/mediabunny/") {
		tail := strings.TrimPrefix(r.URL.Path, "/vendor/mediabunny/")
		if tail == "node.js" {
			serveBrowserNodeShim(w, r)
			return true
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		a.static.ServeHTTP(w, r)
		return true
	}
	if strings.HasPrefix(r.URL.Path, "/vendor/shared/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		a.static.ServeHTTP(w, r)
		return true
	}
	return false
}

func newStaticHandler() http.Handler {
	return http.FileServer(http.FS(public.Files))
}

func serveBrowserNodeShim(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if r.Method != http.MethodHead {
		_, _ = io.WriteString(w, "export const fs = undefined;\n")
	}
}
