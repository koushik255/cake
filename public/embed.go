package public

import "embed"

// Files contains the complete browser application and its vendored dependencies.
//
//go:embed *.css *.js *.ico *.png *.svg *.webmanifest vendor
var Files embed.FS
