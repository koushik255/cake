import { ALL_FORMATS, Input } from "mediabunny";
import { basename, dirname, extname, join, relative } from "std/path";
import { DenoFileSource } from "./media_source.ts";
import { toPosixPath } from "./path.ts";
import { parseMediaName } from "./parser.ts";
import type {
  Library,
  MediaFile,
  SidecarSubtitle,
  SubtitleTrack,
} from "./types.ts";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".wmv",
  ".flv",
  ".mpeg",
  ".mpg",
  ".ts",
  ".m2ts",
  ".ogv",
]);

const SUBTITLE_EXTENSIONS = new Set([".srt", ".vtt"]);
const METADATA_PROBE_CONCURRENCY = 3;

export async function scanLibrary(
  mediaDir: string,
  previous?: Library,
): Promise<Library> {
  const items: MediaFile[] = [];
  const paths: string[] = [];
  const subtitles: SidecarSubtitle[] = [];
  const previousByRelativePath = new Map(
    (previous?.items ?? []).map((item) => [item.relativePath, item]),
  );

  for await (const path of walkIfExists(mediaDir)) {
    paths.push(path);
  }

  for (const path of paths) {
    const extension = extname(path).toLowerCase();
    if (SUBTITLE_EXTENSIONS.has(extension)) {
      subtitles.push(buildSidecarSubtitle(mediaDir, path, extension));
    }
  }

  const videoPaths = paths.filter((path) =>
    VIDEO_EXTENSIONS.has(extname(path).toLowerCase())
  );
  const scanned = await mapWithConcurrency(
    videoPaths,
    METADATA_PROBE_CONCURRENCY,
    async (path) =>
      await scanVideo(path, mediaDir, previousByRelativePath, subtitles),
  );
  items.push(...scanned);

  items.sort((a, b) =>
    a.kind.localeCompare(b.kind) ||
    (a.showTitle ?? a.title).localeCompare(b.showTitle ?? b.title) ||
    (a.season ?? 0) - (b.season ?? 0) ||
    (a.episode ?? 0) - (b.episode ?? 0) ||
    a.title.localeCompare(b.title)
  );

  return {
    mediaDir,
    scannedAt: new Date().toISOString(),
    items,
  };
}

async function scanVideo(
  path: string,
  mediaDir: string,
  previousByRelativePath: Map<string, MediaFile>,
  subtitles: SidecarSubtitle[],
): Promise<MediaFile> {
  const extension = extname(path).toLowerCase();
  const info = await Deno.stat(path);
  const relativePath = toPosixPath(relative(mediaDir, path));
  const parsed = parseMediaName(relativePath);
  const modifiedAt = (info.mtime ?? new Date()).toISOString();
  const previousItem = previousByRelativePath.get(relativePath);
  const unchanged = previousItem?.size === info.size &&
    previousItem.modifiedAt === modifiedAt;
  const media: MediaFile = unchanged
    ? {
      ...previousItem,
      path,
      relativePath,
      size: info.size,
      modifiedAt,
      extension,
      ...parsed,
    }
    : {
      id: previousItem?.id ?? await stableId(relativePath),
      path,
      relativePath,
      size: info.size,
      modifiedAt,
      extension,
      ...parsed,
    };

  if (!unchanged) {
    Object.assign(media, await inspectMedia(path, info.size));
  }
  media.sidecarSubtitles = findSidecarSubtitles(media, subtitles);
  return media;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await map(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, worker),
  );
  return results;
}

async function* walkIfExists(dir: string): AsyncGenerator<string> {
  try {
    yield* walk(dir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return;
    }

    throw error;
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      yield* walk(path);
    } else if (entry.isFile) {
      yield path;
    }
  }
}

async function inspectMedia(
  path: string,
  size: number,
): Promise<Partial<MediaFile>> {
  const input = new Input({
    source: new DenoFileSource(path, size),
    formats: ALL_FORMATS,
  });

  try {
    const [durationSeconds, mimeType, videoTrack, audioTrack] = await Promise
      .all([
        input.getDurationFromMetadata(undefined, { skipLiveWait: true }).catch(
          () => null,
        ),
        input.getMimeType().catch(() => undefined),
        input.getPrimaryVideoTrack().catch(() => null),
        input.getPrimaryAudioTrack().catch(() => null),
      ]);
    let embeddedSubtitles: SubtitleTrack[] = await input.getTracks({
      filter: (track) => track.type === "subtitle",
    }).then((tracks) =>
      Promise.all(tracks.map(async (track) => ({
        codec: await track.getCodec().then((codec) => codec ?? undefined).catch(
          () => undefined,
        ),
        language: await track.getLanguageCode().then((language) =>
          language === "und" ? undefined : language
        ).catch(() => undefined),
        name: await track.getName().then((name) => name ?? undefined).catch(
          () => undefined,
        ),
        source: "mediabunny" as const,
        renderable: false,
      })))
    ).catch(() => []);
    embeddedSubtitles = mergeSubtitleTracks(
      embeddedSubtitles,
      await inspectEmbeddedSubtitlesWithFfprobe(path),
    );

    const [videoCodec, audioCodec, width, height] = await Promise.all([
      videoTrack?.getCodec().catch(() => null),
      audioTrack?.getCodec().catch(() => null),
      videoTrack?.getDisplayWidth().catch(() => undefined),
      videoTrack?.getDisplayHeight().catch(() => undefined),
    ]);

    return {
      durationSeconds: durationSeconds ?? undefined,
      mimeType,
      videoCodec: videoCodec ?? undefined,
      audioCodec: audioCodec ?? undefined,
      width,
      height,
      embeddedSubtitles,
    };
  } catch (error) {
    return {
      metadataError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    input.dispose();
  }
}

async function inspectEmbeddedSubtitlesWithFfprobe(
  path: string,
): Promise<SubtitleTrack[]> {
  try {
    const command = new Deno.Command("ffprobe", {
      args: [
        "-v",
        "error",
        "-select_streams",
        "s",
        "-show_entries",
        "stream=index,codec_name,codec_type:stream_tags=language,title",
        "-of",
        "json",
        path,
      ],
      stdout: "piped",
      stderr: "null",
    });
    const output = await command.output();
    if (!output.success) {
      return [];
    }

    const raw = new TextDecoder().decode(output.stdout);
    const data = JSON.parse(raw) as {
      streams?: Array<{
        index?: number;
        codec_name?: string;
        tags?: {
          language?: string;
          title?: string;
        };
      }>;
    };

    return (data.streams ?? [])
      .filter((stream) => typeof stream.index === "number")
      .map((stream) => ({
        streamIndex: stream.index,
        codec: stream.codec_name,
        language: normalizeLanguage(stream.tags?.language),
        name: stream.tags?.title,
        source: "ffprobe",
        renderable: isRenderableEmbeddedSubtitle(stream.codec_name),
      }));
  } catch {
    return [];
  }
}

function mergeSubtitleTracks(
  primary: SubtitleTrack[],
  fallback: SubtitleTrack[],
): SubtitleTrack[] {
  const seen = new Set<string>();
  const merged: SubtitleTrack[] = [];

  for (const track of [...primary, ...fallback]) {
    const key = track.streamIndex !== undefined
      ? `stream:${track.streamIndex}`
      : `${track.codec ?? ""}:${track.language ?? ""}:${track.name ?? ""}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(track);
  }

  return merged;
}

function isRenderableEmbeddedSubtitle(codec?: string): boolean {
  return ["subrip", "ass", "ssa", "webvtt"].includes(codec ?? "");
}

function normalizeLanguage(language?: string): string | undefined {
  return language && language !== "und" ? language : undefined;
}

function buildSidecarSubtitle(
  mediaDir: string,
  path: string,
  extension: string,
): SidecarSubtitle {
  const relativePath = toPosixPath(relative(mediaDir, path));
  const filename = basename(path, extension);
  const language = inferSubtitleLanguage(filename);

  return {
    path,
    relativePath,
    label: language ? language.toUpperCase() : basename(path),
    format: extension === ".vtt" ? "vtt" : "srt",
    language,
  };
}

function findSidecarSubtitles(
  media: MediaFile,
  subtitles: SidecarSubtitle[],
): SidecarSubtitle[] {
  const videoDir = dirname(media.path);
  const videoStem = basename(media.path, media.extension);

  return subtitles
    .filter((subtitle) => {
      if (dirname(subtitle.path) !== videoDir) {
        return false;
      }

      const subtitleStem = basename(subtitle.path, `.${subtitle.format}`);
      return subtitleStem === videoStem ||
        subtitleStem.startsWith(`${videoStem}.`);
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function inferSubtitleLanguage(filename: string): string | undefined {
  const parts = filename.split(".");
  const maybeLanguage = parts.at(-1);

  if (maybeLanguage && /^[a-z]{2,3}(-[a-z]{2})?$/i.test(maybeLanguage)) {
    return maybeLanguage;
  }

  return undefined;
}

async function stableId(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(hash))
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
