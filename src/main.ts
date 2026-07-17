import { json, libraryPayload, mediaPayload } from "./api.ts";
import { startAutoScan } from "./auto_scan.ts";
import { describeConfig, loadConfig } from "./config.ts";
import {
  indexPage,
  moviesPage,
  notFoundPage,
  playerPage,
  profilePage,
  showPage,
  tvPage,
} from "./html.tsx";
import { LibraryStore } from "./library.ts";
import { playbackDecision } from "./playback.ts";
import { profileCookie, ProfileStore, selectedProfileId } from "./profiles.ts";
import { registerServerMediaRuntime } from "./server_runtime.ts";
import { serveStatic } from "./static.ts";
import {
  streamEmbeddedSubtitle,
  streamFile,
  streamSubtitle,
} from "./stream.ts";
import { streamTranscodedFile } from "./transcode.ts";
import { thumbnailFor } from "./thumbnail.ts";
import type { MediaFile } from "./types.ts";
import { WatchHistoryStore } from "./watch_history.ts";

const config = await loadConfig();
await registerServerMediaRuntime(config);

const store = new LibraryStore(config.mediaDir, config.libraryFile);
const profiles = new ProfileStore();
const watchHistory = new WatchHistoryStore();
startAutoScan(store, config);

for (const line of describeConfig(config)) {
  console.log(line);
}

Deno.serve(
  { hostname: config.hostname, port: config.port },
  async (request) => {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" || request.method === "HEAD") {
        const staticResponse = await serveStatic(url.pathname, request.method);
        if (staticResponse) {
          return staticResponse;
        }
      }

      if (request.method === "GET" && url.pathname === "/") {
        const library = await store.load();
        const profile = await currentProfile(request);
        if (!profile) {
          return redirect("/profiles");
        }

        return indexPage(
          library,
          await watchHistory.recent(profile.id, library),
          profile,
          config,
        );
      }

      if (request.method === "GET" && url.pathname === "/profiles") {
        return profilePage(await profiles.all());
      }

      if (request.method === "POST" && url.pathname === "/profiles") {
        const form = await request.formData();
        const profile = await profiles.create(String(form.get("name") ?? ""));
        return redirect("/", {
          "set-cookie": profileCookie(profile),
        });
      }

      const profileSelectMatch = /^\/profiles\/select\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && profileSelectMatch) {
        const profile = await profiles.find(
          decodeURIComponent(profileSelectMatch[1]),
        );
        return profile
          ? redirect("/", { "set-cookie": profileCookie(profile) })
          : notFoundPage();
      }

      if (request.method === "GET" && url.pathname === "/api/library") {
        return json(libraryPayload(await store.load()));
      }

      if (request.method === "GET" && url.pathname === "/api/library-version") {
        const library = await store.load();
        return json({
          scannedAt: library.scannedAt,
          count: library.items.length,
        });
      }

      if (request.method === "GET" && url.pathname === "/api/movies") {
        const library = await store.load();
        return json(libraryPayload(library).movies);
      }

      if (request.method === "GET" && url.pathname === "/api/tv") {
        const library = await store.load();
        return json(libraryPayload(library).episodes);
      }

      if (request.method === "POST" && url.pathname === "/api/rescan") {
        return json(libraryPayload(await store.rescan()));
      }

      const watchHistoryMatch = /^\/api\/watch-history\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && watchHistoryMatch) {
        const profile = await currentProfile(request);
        if (!profile) {
          return json({ error: "No profile selected" }, 400);
        }

        const id = decodeURIComponent(watchHistoryMatch[1]);
        const item = await store.find(id);
        if (!item) {
          return json({ error: "Not found" }, 404);
        }

        return json(
          await watchHistory.markWatched(
            profile.id,
            id,
            await playbackSecondsFrom(request),
          ),
        );
      }

      const apiMediaMatch = /^\/api\/media\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && apiMediaMatch) {
        const library = await store.load();
        const item = await store.find(decodeURIComponent(apiMediaMatch[1]));
        if (!item) {
          return json({ error: "Not found" }, 404);
        }

        const profile = await currentProfile(request);
        const historyEntry = profile
          ? await watchHistory.find(profile.id, item.id)
          : undefined;
        return json(
          mediaPayload(
            item,
            config,
            nextEpisode(item, library.items),
            historyEntry?.playbackSeconds,
          ),
        );
      }

      const apiPlaybackMatch = /^\/api\/media\/([^/]+)\/playback$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && apiPlaybackMatch) {
        const item = await store.find(decodeURIComponent(apiPlaybackMatch[1]));
        return item
          ? json(playbackDecision(item, config))
          : json({ error: "Not found" }, 404);
      }

      if (request.method === "GET" && url.pathname === "/movies") {
        const profile = await currentProfile(request);
        return profile
          ? moviesPage(await store.load(), profile, config)
          : redirect("/profiles");
      }

      if (
        request.method === "GET" &&
        (url.pathname === "/shows" || url.pathname === "/tv")
      ) {
        const profile = await currentProfile(request);
        return profile
          ? tvPage(await store.load(), profile, config)
          : redirect("/profiles");
      }

      const showMatch = /^\/shows\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && showMatch) {
        const profile = await currentProfile(request);
        return profile
          ? showPage(
            await store.load(),
            profile,
            decodeURIComponent(showMatch[1]),
            config,
          )
          : redirect("/profiles");
      }

      if (request.method === "POST" && url.pathname === "/rescan") {
        await store.rescan();
        return redirect("/");
      }

      const watchMatch = /^\/watch\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && watchMatch) {
        const profile = await currentProfile(request);
        if (!profile) {
          return redirect("/profiles");
        }

        const item = await store.find(decodeURIComponent(watchMatch[1]));
        return item ? playerPage(item) : notFoundPage();
      }

      const streamMatch = /^\/stream\/([^/]+)(?:\/(direct|transcode))?$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && streamMatch) {
        const item = await store.find(decodeURIComponent(streamMatch[1]));
        if (!item) {
          return new Response("Not found", { status: 404 });
        }

        const variant = streamMatch[2] ?? "direct";
        if (variant === "transcode") {
          return await streamTranscodedFile(item, request, config);
        }

        return await streamFile(item, request);
      }

      const thumbnailMatch = /^\/thumbnails\/([^/]+)\.jpg$/.exec(url.pathname);
      if (request.method === "GET" && thumbnailMatch) {
        const item = await store.find(decodeURIComponent(thumbnailMatch[1]));
        const seconds = Number(url.searchParams.get("at"));
        return item
          ? await thumbnailFor(
            item,
            Number.isFinite(seconds) ? seconds : undefined,
          )
          : new Response("Not found", { status: 404 });
      }

      const hlsMatch = /^\/hls\/([^/]+)\/.+$/.exec(url.pathname);
      if ((request.method === "GET" || request.method === "HEAD") && hlsMatch) {
        const item = await store.find(decodeURIComponent(hlsMatch[1]));
        return item
          ? await streamTranscodedFile(item, request, config)
          : new Response("Not found", { status: 404 });
      }

      const subtitleMatch = /^\/subtitles\/([^/]+)\/(\d+)$/.exec(url.pathname);
      if (request.method === "GET" && subtitleMatch) {
        const item = await store.find(decodeURIComponent(subtitleMatch[1]));
        const index = Number(subtitleMatch[2]);
        const subtitle = item?.sidecarSubtitles?.[index];
        return subtitle
          ? await streamSubtitle(subtitle)
          : new Response("Not found", { status: 404 });
      }

      const embeddedSubtitleMatch = /^\/embedded-subtitles\/([^/]+)\/(\d+)$/
        .exec(url.pathname);
      if (request.method === "GET" && embeddedSubtitleMatch) {
        const item = await store.find(
          decodeURIComponent(embeddedSubtitleMatch[1]),
        );
        const streamIndex = Number(embeddedSubtitleMatch[2]);
        return item
          ? await streamEmbeddedSubtitle(item, streamIndex)
          : new Response("Not found", { status: 404 });
      }

      return notFoundPage();
    } catch (error) {
      console.error(error);
      return new Response(
        error instanceof Error ? error.message : String(error),
        {
          status: 500,
          headers: {
            "content-type": "text/plain; charset=utf-8",
          },
        },
      );
    }
  },
);

async function playbackSecondsFrom(
  request: Request,
): Promise<number | undefined> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return undefined;
  }

  const body = await request.json().catch(() => undefined) as
    | { playbackSeconds?: unknown }
    | undefined;
  return typeof body?.playbackSeconds === "number" &&
      Number.isFinite(body.playbackSeconds)
    ? Math.max(0, Math.round(body.playbackSeconds))
    : undefined;
}

async function currentProfile(request: Request) {
  return await profiles.find(
    decodeURIComponent(selectedProfileId(request) ?? ""),
  );
}

function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, {
    status: 303,
    headers: {
      ...headers,
      location,
    },
  });
}

function nextEpisode(
  item: MediaFile,
  items: MediaFile[],
): MediaFile | undefined {
  if (item.kind !== "episode" || !item.showTitle) {
    return undefined;
  }

  const episodes = items
    .filter((candidate) =>
      candidate.kind === "episode" &&
      candidate.showTitle === item.showTitle &&
      candidate.id !== item.id
    )
    .toSorted((a, b) =>
      (a.season ?? 0) - (b.season ?? 0) ||
      (a.episode ?? 0) - (b.episode ?? 0)
    );

  return episodes.find((candidate) =>
    (candidate.season ?? 0) > (item.season ?? 0) ||
    ((candidate.season ?? 0) === (item.season ?? 0) &&
      (candidate.episode ?? 0) > (item.episode ?? 0))
  );
}
