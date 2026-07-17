import { assertEquals, assertStrictEquals } from "std/assert";
import { join } from "std/path";
import { mediaPayload } from "./api.ts";
import { WatchHistoryStore } from "./watch_history.ts";
import type { Library, MediaFile } from "./types.ts";

function mediaItem(id: string): MediaFile {
  return {
    id,
    kind: "movie",
    title: `Title ${id}`,
    path: `/media/${id}.mp4`,
    relativePath: `${id}.mp4`,
    size: 1024,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    extension: ".mp4",
  };
}

function libraryWith(items: MediaFile[]): Library {
  return {
    mediaDir: "/media",
    scannedAt: "2026-01-01T00:00:00.000Z",
    items,
  };
}

async function withHistoryPath(
  run: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "watch-history-test-" });
  try {
    await run(join(dir, "history.json"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("markWatched persists playbackSeconds for matching recent library item", async () => {
  await withHistoryPath(async (path) => {
    const item = mediaItem("movie-1");
    const entry = await new WatchHistoryStore(path).markWatched(
      "profile-1",
      item.id,
      123,
    );

    const recent = await new WatchHistoryStore(path).recent(
      "profile-1",
      libraryWith([item]),
    );

    assertEquals(recent, [{
      item,
      watchedAt: entry.watchedAt,
      playbackSeconds: 123,
    }]);
  });
});

Deno.test("markWatched replaces playbackSeconds for an existing id", async () => {
  await withHistoryPath(async (path) => {
    const item = mediaItem("movie-1");
    const store = new WatchHistoryStore(path);

    await store.markWatched("profile-1", item.id, 12);
    const replacement = await store.markWatched("profile-1", item.id, 98);

    const recent = await new WatchHistoryStore(path).recent(
      "profile-1",
      libraryWith([item]),
    );

    assertEquals(recent, [{
      item,
      watchedAt: replacement.watchedAt,
      playbackSeconds: 98,
    }]);
  });
});

Deno.test("find returns saved entry for the requested profile and id", async () => {
  await withHistoryPath(async (path) => {
    const store = new WatchHistoryStore(path);
    const saved = await store.markWatched("profile-1", "movie-1", 321);
    await store.markWatched("profile-1", "movie-2", 12);
    await store.markWatched("profile-2", "movie-1", 99);

    const found = await new WatchHistoryStore(path).find(
      "profile-1",
      "movie-1",
    );

    assertEquals(found, {
      id: "movie-1",
      watchedAt: saved.watchedAt,
      playbackSeconds: 321,
    });
  });
});

Deno.test("find returns undefined for another profile or unknown id", async () => {
  await withHistoryPath(async (path) => {
    const store = new WatchHistoryStore(path);
    await store.markWatched("profile-1", "movie-1", 321);

    assertStrictEquals(await store.find("profile-2", "movie-1"), undefined);
    assertStrictEquals(await store.find("profile-1", "movie-404"), undefined);
  });
});

Deno.test("recent accepts legacy entries without playbackSeconds", async () => {
  await withHistoryPath(async (path) => {
    const item = mediaItem("movie-1");
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        profiles: {
          "profile-1": {
            items: [{
              id: item.id,
              watchedAt: "2026-02-03T04:05:06.000Z",
            }],
          },
        },
      }),
    );

    const recent = await new WatchHistoryStore(path).recent(
      "profile-1",
      libraryWith([item]),
    );

    assertEquals(recent.length, 1);
    assertStrictEquals(recent[0].playbackSeconds, undefined);
    assertEquals(recent[0], {
      item,
      watchedAt: "2026-02-03T04:05:06.000Z",
      playbackSeconds: undefined,
    });
  });
});

Deno.test("mediaPayload exposes supplied playbackSeconds and omits missing progress", () => {
  const item = mediaItem("movie-1");

  assertStrictEquals(
    mediaPayload(item, { playbackMode: "direct" }, undefined, 456)
      .playbackSeconds,
    456,
  );
  assertStrictEquals(
    mediaPayload(item, { playbackMode: "direct" }).playbackSeconds,
    undefined,
  );
});
