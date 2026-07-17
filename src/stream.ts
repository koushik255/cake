import type { MediaFile, SidecarSubtitle } from "./types.ts";

const SUBTITLE_CACHE_DIR = ".cache/subtitles";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".ts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".ogv": "video/ogg",
};

const OPEN_ENDED_RANGE_CHUNK_SIZE = 4 * 1024 * 1024;

export async function streamFile(
  item: MediaFile,
  request: Request,
): Promise<Response> {
  const size = item.size;
  return await streamPath(
    item.path,
    size,
    item.extension,
    item.mimeType,
    request,
  );
}

export async function streamPath(
  path: string,
  size: number,
  extension: string,
  mimeType: string | undefined,
  request: Request,
): Promise<Response> {
  const range = request.headers.get("range");
  const contentType = mimeType ?? MIME_BY_EXTENSION[extension] ??
    "application/octet-stream";

  if (!range) {
    const file = await Deno.open(path, { read: true });
    return new Response(file.readable, {
      headers: {
        "accept-ranges": "bytes",
        "content-length": String(size),
        "content-type": contentType,
      },
    });
  }

  const parsed = parseRange(range, size);
  if (!parsed) {
    return new Response(null, {
      status: 416,
      headers: {
        "content-range": `bytes */${size}`,
      },
    });
  }

  const { start, end } = parsed;
  const length = end - start + 1;
  const file = await Deno.open(path, { read: true });
  await file.seek(start, Deno.SeekMode.Start);

  return new Response(file.readable.pipeThrough(limitBytes(length)), {
    status: 206,
    headers: {
      "accept-ranges": "bytes",
      "content-length": String(length),
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-type": contentType,
    },
  });
}

export async function streamSubtitle(
  subtitle: SidecarSubtitle,
): Promise<Response> {
  const contentType = subtitle.format === "vtt"
    ? "text/vtt; charset=utf-8"
    : "text/plain; charset=utf-8";

  return new Response(await Deno.readTextFile(subtitle.path), {
    headers: {
      "content-type": contentType,
      "cache-control": "private, max-age=3600",
    },
  });
}

export async function streamEmbeddedSubtitle(
  item: MediaFile,
  streamIndex: number,
): Promise<Response> {
  const track = item.embeddedSubtitles?.find((subtitle) =>
    subtitle.streamIndex === streamIndex
  );
  if (!track?.renderable) {
    return new Response("Not found", { status: 404 });
  }

  const cachePath = subtitleCachePath(item, streamIndex);
  try {
    return new Response(await Deno.readFile(cachePath), {
      headers: {
        "content-type": "text/vtt; charset=utf-8",
        "cache-control": "private, max-age=86400",
      },
    });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  const command = new Deno.Command("ffmpeg", {
    args: [
      "-v",
      "error",
      "-i",
      item.path,
      "-map",
      `0:${streamIndex}`,
      "-f",
      "webvtt",
      "-",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    const error = new TextDecoder().decode(output.stderr);
    return new Response(error || "Could not extract subtitle stream", {
      status: 500,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  await Deno.mkdir(SUBTITLE_CACHE_DIR, { recursive: true });
  await Deno.writeFile(cachePath, output.stdout);

  return new Response(output.stdout, {
    headers: {
      "content-type": "text/vtt; charset=utf-8",
      "cache-control": "private, max-age=86400",
    },
  });
}

function subtitleCachePath(item: MediaFile, streamIndex: number): string {
  const version = item.modifiedAt.replaceAll(/[^0-9a-z]/gi, "");
  return `${SUBTITLE_CACHE_DIR}/${item.id}-${streamIndex}-${version}.vtt`;
}

function parseRange(
  range: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return null;
  }

  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    const start = Math.max(size - suffixLength, 0);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === ""
    ? Math.min(start + OPEN_ENDED_RANGE_CHUNK_SIZE - 1, size - 1)
    : Number(rawEnd);

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

function limitBytes(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let remaining = limit;

  return new TransformStream({
    transform(chunk, controller) {
      if (remaining <= 0) {
        return;
      }

      const next = chunk.byteLength > remaining
        ? chunk.subarray(0, remaining)
        : chunk;
      remaining -= next.byteLength;
      controller.enqueue(next);

      if (remaining <= 0) {
        controller.terminate();
      }
    },
  });
}
