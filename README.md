# Cake

A small, fast local Plex-like video library server. The backend is written in
Go, uses only the standard library at runtime, and delegates media operations to
FFmpeg. The browser player and its vendored Mediabunny modules are embedded in
the executable, so Node, Deno, and a separate frontend server are not required.

## Run

Edit `config.json` and set `mediaDir` to your video folder:

```json
{
  "mediaDir": "/path/to/videos",
  "libraryFile": "./library.json",
  "hostname": "127.0.0.1",
  "port": 8080,
  "playbackMode": "auto",
  "transcodeCacheDir": ".cache/transcodes",
  "transcodeCacheMaxAgeHours": 24,
  "maxTranscodes": 1,
  "hardwareAcceleration": "auto",
  "transcodeVideoMode": "avc",
  "transcodeAudioCodec": "aac",
  "autoScan": false,
  "autoScanDelaySeconds": 10,
  "libraryUpdatePollSeconds": 20
}
```

Then start the Go server:

```sh
go run ./cmd/cake
```

Or with Nix:

```sh
nix develop
go run ./cmd/cake
```

You can also run the app wrapper directly:

```sh
nix run .#cake
```

Then open:

```text
http://127.0.0.1:8080
```

If `config.json` is missing, the server scans `./media`. Environment variables
like `MEDIA_DIR` and `PORT` can still override the config file.

## What Works Now

- fixed media folder
- local-only server on `127.0.0.1:8080`
- rescan button
- JSON library cache in `library.json`
- movie and TV episode views
- last watched list with playback positions and resume state stored in
  `.cache/watch-history.json`
- simple profiles stored in `.cache/profiles.json`
- optional auto scan with a refresh banner when the library changes
- direct file streaming with HTTP range requests
- FFprobe metadata probing for duration, MIME type, codecs, and dimensions
- playback analysis API for direct-play vs server-transcode decisions
- cached FFmpeg HLS transcodes for files that need browser-safe playback

Browser playback depends on browser codec/container support for now. Files are
still listed even when playback fails.

## Playback Modes

`playbackMode` controls how Cake chooses the URL returned by the media API:

- `direct`: always returns the direct byte-range stream.
- `auto`: returns the direct stream when the file looks browser-compatible,
  otherwise returns the server transcode endpoint.
- `server`: always returns the server transcode endpoint.

The server transcode endpoint is `/stream/:id/transcode`. HLS output is cached
under `transcodeCacheDir`. Set `transcodeVideoMode` to `"copy"` to remux the
original video without re-encoding it, or `"avc"` for a browser-safe 720p H.264
encode. Video copy is much faster but requires browser support for the source
video codec. Set `transcodeAudioCodec` to `"aac"` for MPEG-TS/AAC or `"opus"`
for CMAF/Opus. Opus is useful when a Chromium build lacks AAC or AC-3 WebCodecs
support. Later requests reuse the cached segments. Cache access
is tracked, and entries unused for `transcodeCacheMaxAgeHours` are removed at
startup and by an hourly cleanup task.

## Auto Scan

Set `autoScan` to `true` to watch `mediaDir` for file changes while the server
is running. Cake waits `autoScanDelaySeconds` after the last filesystem event,
rescans the library, and updates `library.json`.

Library pages poll `/api/library-version` every `libraryUpdatePollSeconds`. When
the server has a newer scan, the page shows a small refresh banner instead of
changing the page underneath you.

## Profiles

Cake shows a plain profile picker at `/profiles`. Selecting a profile stores it
in a cookie and scopes watch history to that profile. Profiles can be added from
the picker and are stored in `.cache/profiles.json`.

## Verify

```sh
go test ./...
go vet ./...
```

Existing library caches, profiles, watch history, and transcode caches continue
to use the same on-disk formats and do not need to be migrated.

The vendored Mediabunny 1.50.3 browser modules are licensed under MPL-2.0. Its
license is included at `public/vendor/mediabunny/LICENSE`.
