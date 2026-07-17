# Cake

A small local Plex-like video library server built with Deno, TypeScript, plain
HTML, and Mediabunny.

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
  "maxTranscodes": 1,
  "hardwareAcceleration": "auto",
  "autoScan": false,
  "autoScanDelaySeconds": 10,
  "libraryUpdatePollSeconds": 20
}
```

Then start the server:

```sh
deno task dev
```

Or with Nix:

```sh
nix develop
deno task dev
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
- Mediabunny metadata probing for duration, MIME type, codecs, and dimensions
- playback analysis API for direct-play vs server-transcode decisions
- optional Mediabunny server runtime registration through `playbackMode: "auto"`
  or `playbackMode: "server"`
- cached server-side MP4 transcodes for files that need browser-safe playback

Browser playback depends on browser codec/container support for now. Files are
still listed even when playback fails.

## Playback Modes

`playbackMode` controls how Cake chooses the URL returned by the media API:

- `direct`: always returns the direct byte-range stream.
- `auto`: returns the direct stream when the file looks browser-compatible,
  otherwise returns the server transcode endpoint.
- `server`: always returns the server transcode endpoint.

The server transcode endpoint is `/stream/:id/transcode`. It creates a cached
fragmented MP4 output under `transcodeCacheDir` while streaming conversion
chunks to the browser. Later requests reuse the cached file with byte range
support.

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
# cake
