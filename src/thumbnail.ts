import { dirname, join } from "std/path";
import type { MediaFile } from "./types.ts";

class AsyncSlots {
  #active = 0;
  #waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.#active >= this.limit) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active++;
  }

  release(): void {
    this.#active--;
    this.#waiters.shift()?.();
  }
}

const THUMBNAIL_CACHE_DIR = ".cache/thumbnails";
const activeThumbnails = new Map<string, Promise<Uint8Array>>();
const thumbnailSlots = new AsyncSlots(2);

/** Returns a small JPEG preview, caching it by media version and timestamp. */
export async function thumbnailFor(
  item: MediaFile,
  requestedSeconds: number | undefined,
): Promise<Response> {
  const seconds = thumbnailSeconds(item, requestedSeconds);
  const path = thumbnailPath(item, seconds);

  try {
    return jpegResponse(await Deno.readFile(path));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  const existing = activeThumbnails.get(path);
  const generation = existing ?? generateThumbnail(item, seconds, path);
  if (!existing) {
    activeThumbnails.set(path, generation);
  }

  try {
    return jpegResponse(await generation);
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Could not generate thumbnail",
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  } finally {
    activeThumbnails.delete(path);
  }
}

function thumbnailSeconds(item: MediaFile, requestedSeconds?: number): number {
  const requested = Number.isFinite(requestedSeconds) && requestedSeconds! >= 0
    ? requestedSeconds!
    : 0;
  // Seeking exactly to the end often produces no frame.
  return Math.max(
    0,
    Math.min(
      Math.floor(requested),
      Math.max(0, (item.durationSeconds ?? Infinity) - 1),
    ),
  );
}

function thumbnailPath(item: MediaFile, seconds: number): string {
  const version = item.modifiedAt.replaceAll(/[^0-9a-z]/gi, "");
  return join(THUMBNAIL_CACHE_DIR, item.id, `${version}-${seconds}.jpg`);
}

async function generateThumbnail(
  item: MediaFile,
  seconds: number,
  path: string,
): Promise<Uint8Array> {
  await thumbnailSlots.acquire();
  try {
    const output = await new Deno.Command("ffmpeg", {
      args: [
        "-v",
        "error",
        "-ss",
        String(seconds),
        "-i",
        item.path,
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-2",
        "-q:v",
        "4",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (!output.success || output.stdout.byteLength === 0) {
      const detail = new TextDecoder().decode(output.stderr).trim();
      throw new Error(detail || "ffmpeg could not extract a video frame");
    }

    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeFile(path, output.stdout);
    return output.stdout;
  } finally {
    thumbnailSlots.release();
  }
}

function jpegResponse(bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=86400",
    },
  });
}
