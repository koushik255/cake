import {
  ALL_FORMATS,
  Conversion,
  FilePathTarget,
  HlsOutputFormat,
  Input,
  MpegTsOutputFormat,
  Output,
  PathedTarget,
  QUALITY_MEDIUM,
} from "mediabunny";
import { extname, join, normalize, relative } from "std/path";
import type { AppConfig } from "./config.ts";
import { DenoFileSource } from "./media_source.ts";
import type { MediaFile } from "./types.ts";

type HlsSession = {
  done: Promise<void>;
  error?: unknown;
  conversion?: Conversion;
};

const activeSessions = new Map<string, HlsSession>();

const MIME_BY_EXTENSION: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl; charset=utf-8",
  ".ts": "video/mp2t",
};

export async function streamTranscodedFile(
  item: MediaFile,
  request: Request,
  config: Pick<
    AppConfig,
    "hardwareAcceleration" | "maxTranscodes" | "transcodeCacheDir"
  >,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const match = /^\/hls\/[^/]+\/(.+)$/.exec(path);
  const hlsPath = match?.[1] ?? "master.m3u8";

  if (!(await fileExists(item.path))) {
    return new Response(
      `Media file is missing. Rescan the library to remove stale entries: ${item.relativePath}`,
      {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      },
    );
  }

  const root = hlsCacheRoot(item, config.transcodeCacheDir);
  const filePath = safeJoin(root, hlsPath);
  if (!filePath) {
    return new Response("Not found", { status: 404 });
  }

  if (
    !(await fileExists(join(root, "master.m3u8"))) || activeSessions.has(root)
  ) {
    const session = ensureHlsSession(item, config);
    if (session.error) {
      return transcodeErrorResponse(session.error);
    }
  }

  const found = await waitForFile(
    filePath,
    hlsPath.endsWith(".m3u8") ? 60000 : 30000,
  );
  if (!found) {
    const session = activeSessions.get(root);
    if (session?.error) {
      return transcodeErrorResponse(session.error);
    }

    return new Response("Transcode output is not ready", { status: 503 });
  }

  const headers: HeadersInit = {
    "content-type": MIME_BY_EXTENSION[extname(filePath)] ??
      "application/octet-stream",
    "cache-control": hlsPath.endsWith(".m3u8")
      ? "no-cache"
      : "private, max-age=86400",
    "x-cake-transcode": "hls",
  };

  if (request.method === "HEAD") {
    const stat = await Deno.stat(filePath);
    return new Response(null, {
      headers: {
        ...headers,
        "content-length": String(stat.size),
      },
    });
  }

  return new Response(await Deno.readFile(filePath), { headers });
}

function ensureHlsSession(
  item: MediaFile,
  config: Pick<
    AppConfig,
    "hardwareAcceleration" | "maxTranscodes" | "transcodeCacheDir"
  >,
): HlsSession {
  const root = hlsCacheRoot(item, config.transcodeCacheDir);
  const existing = activeSessions.get(root);
  if (existing) {
    return existing;
  }

  const session: HlsSession = {
    done: Promise.resolve(),
  };
  session.done = transcodeToHls(item, root, config)
    .catch((error) => {
      session.error = error;
      console.error("HLS transcode failed:", error);
    })
    .finally(() => {
      if (!session.error) {
        activeSessions.delete(root);
      }
    });
  activeSessions.set(root, session);

  return session;
}

function transcodeErrorResponse(error: unknown): Response {
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

async function transcodeToHls(
  item: MediaFile,
  root: string,
  config: Pick<AppConfig, "hardwareAcceleration" | "maxTranscodes">,
): Promise<void> {
  await transcodeSlots.acquire(config.maxTranscodes);

  try {
    await Deno.remove(root, { recursive: true }).catch(() => {});
    await Deno.mkdir(root, { recursive: true });
    await transcodeToHlsWithMediabunny(item, root, config);
  } catch (error) {
    if (!shouldFallbackToFfmpeg(item, error)) {
      throw error;
    }

    console.warn(
      `Falling back to ffmpeg HLS transcode for ${item.relativePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await Deno.remove(root, { recursive: true }).catch(() => {});
    await Deno.mkdir(root, { recursive: true });
    await transcodeToHlsWithFfmpeg(item, root);
  } finally {
    transcodeSlots.release();
  }
}

async function transcodeToHlsWithMediabunny(
  item: MediaFile,
  root: string,
  config: Pick<AppConfig, "hardwareAcceleration">,
): Promise<void> {
  const input = new Input({
    source: new DenoFileSource(item.path, item.size),
    formats: ALL_FORMATS,
  });

  try {
    const output = new Output({
      format: new HlsOutputFormat({
        segmentFormat: new MpegTsOutputFormat(),
        targetDuration: 2,
        live: true,
        getPlaylistPath: () => "playlist.m3u8",
        getSegmentPath: (info) => `segment-${info.n}.ts`,
      }),
      target: new PathedTarget("master.m3u8", (request) => {
        const filePath = safeJoin(root, request.path);
        if (!filePath) {
          throw new Error(`Invalid HLS output path: ${request.path}`);
        }

        return new FilePathTarget(filePath, { chunked: false });
      }),
    });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: async (track) => ({
        codec: "avc",
        height: Math.min(720, await track.getDisplayHeight()),
        bitrate: QUALITY_MEDIUM,
        keyFrameInterval: 2,
        hardwareAcceleration: config.hardwareAcceleration === "prefer-software"
          ? "prefer-software"
          : "no-preference",
      }),
      audio: {
        codec: "aac",
        bitrate: QUALITY_MEDIUM,
      },
      showWarnings: false,
    });

    await conversion.execute();
  } finally {
    input.dispose();
  }
}

async function transcodeToHlsWithFfmpeg(
  item: MediaFile,
  root: string,
): Promise<void> {
  const command = new Deno.Command("ffmpeg", {
    args: [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-y",
      "-i",
      item.path,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-vf",
      "scale=-2:min(720\\,ih)",
      "-force_key_frames",
      "expr:gte(t,n_forced*2)",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-f",
      "hls",
      "-hls_time",
      "2",
      "-hls_list_size",
      "0",
      "-hls_segment_filename",
      join(root, "segment-%d.ts"),
      join(root, "master.m3u8"),
    ],
    stdout: "null",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    const error = new TextDecoder().decode(output.stderr).trim();
    throw new Error(error || "ffmpeg HLS transcode failed");
  }
}

function shouldFallbackToFfmpeg(item: MediaFile, error: unknown): boolean {
  if (item.extension === ".avi") {
    return true;
  }

  return error instanceof Error &&
    error.name === "UnsupportedInputFormatError";
}

function hlsCacheRoot(item: MediaFile, cacheDir: string): string {
  const version = item.modifiedAt.replaceAll(/[^0-9a-z]/gi, "");
  return join(cacheDir, item.id, `hls-${version}`);
}

function safeJoin(root: string, path: string): string | null {
  const normalized = normalize(path);
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    return null;
  }

  const filePath = join(root, normalized);
  const rel = relative(root, filePath);
  return rel === "" || rel.startsWith("..") ? null : filePath;
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const stat = await Deno.stat(path);
      if (stat.isFile && stat.size > 0) {
        return true;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }

    throw error;
  }
}

class TranscodeSlots {
  #active = 0;
  #waiters: Array<() => void> = [];

  async acquire(limit: number): Promise<void> {
    if (this.#active < limit) {
      this.#active++;
      return;
    }

    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#active++;
  }

  release(): void {
    this.#active = Math.max(0, this.#active - 1);
    this.#waiters.shift()?.();
  }
}

const transcodeSlots = new TranscodeSlots();
