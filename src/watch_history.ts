import { dirname, resolve } from "std/path";
import type { Library, MediaFile } from "./types.ts";

type WatchHistoryFile = {
  profiles: Record<string, ProfileWatchHistory>;
  items?: WatchHistoryEntry[];
};

type ProfileWatchHistory = {
  items: WatchHistoryEntry[];
};

export type WatchHistoryEntry = {
  id: string;
  watchedAt: string;
  playbackSeconds?: number;
};

export type LastWatchedItem = {
  item: MediaFile;
  watchedAt: string;
  playbackSeconds?: number;
};

export class WatchHistoryStore {
  #path: string;

  constructor(path = ".cache/watch-history.json") {
    this.#path = resolve(path);
  }

  async markWatched(
    profileId: string,
    id: string,
    playbackSeconds?: number,
  ): Promise<WatchHistoryEntry> {
    const history = await this.load();
    const profileHistory = history.profiles[profileId] ?? { items: [] };
    const entry = {
      id,
      watchedAt: new Date().toISOString(),
      ...(playbackSeconds === undefined ? {} : { playbackSeconds }),
    };
    const items = [
      entry,
      ...profileHistory.items.filter((item) => item.id !== id),
    ].slice(0, 100);
    history.profiles[profileId] = { items };

    await Deno.mkdir(dirname(this.#path), { recursive: true });
    await Deno.writeTextFile(
      this.#path,
      `${JSON.stringify({ profiles: history.profiles }, null, 2)}\n`,
    );

    return entry;
  }

  async find(
    profileId: string,
    id: string,
  ): Promise<WatchHistoryEntry | undefined> {
    const history = await this.load();
    const profileHistory = history.profiles[profileId] ?? { items: [] };
    return profileHistory.items.find((item) => item.id === id);
  }

  async recent(
    profileId: string,
    library: Library,
    limit = 8,
  ): Promise<LastWatchedItem[]> {
    const history = await this.load();
    const profileHistory = history.profiles[profileId] ?? { items: [] };
    const itemsById = new Map(library.items.map((item) => [item.id, item]));

    return profileHistory.items
      .flatMap((entry) => {
        const item = itemsById.get(entry.id);
        return item
          ? [{
            item,
            watchedAt: entry.watchedAt,
            playbackSeconds: typeof entry.playbackSeconds === "number"
              ? entry.playbackSeconds
              : undefined,
          }]
          : [];
      })
      .slice(0, limit);
  }

  private async load(): Promise<WatchHistoryFile> {
    try {
      const raw = await Deno.readTextFile(this.#path);
      const history = JSON.parse(raw) as WatchHistoryFile;
      if (history.profiles && typeof history.profiles === "object") {
        return {
          profiles: history.profiles,
        };
      }

      return {
        profiles: {
          koushik: {
            items: Array.isArray(history.items) ? history.items : [],
          },
        },
      };
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof SyntaxError
      ) {
        return { profiles: {} };
      }

      throw error;
    }
  }
}
