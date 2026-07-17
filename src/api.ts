import type { AppConfig } from "./config.ts";
import { playbackDecision } from "./playback.ts";
import type { Library, MediaFile } from "./types.ts";

export function libraryPayload(library: Library) {
  const movies = library.items.filter((item) => item.kind === "movie");
  const episodes = library.items.filter((item) => item.kind === "episode");

  return {
    mediaDir: library.mediaDir,
    scannedAt: library.scannedAt,
    count: library.items.length,
    movies: movies.map(mediaSummary),
    episodes: episodes.map(mediaSummary),
  };
}

export function mediaPayload(
  item: MediaFile,
  config: Pick<AppConfig, "playbackMode">,
  nextEpisode?: MediaFile,
  playbackSeconds?: number,
) {
  const playback = playbackDecision(item, config);

  return {
    ...mediaSummary(item),
    path: item.relativePath,
    size: item.size,
    modifiedAt: item.modifiedAt,
    extension: item.extension,
    streamUrl: playback.url,
    playback,
    subtitles: subtitlePayload(item),
    embeddedSubtitles: item.embeddedSubtitles ?? [],
    sidecarSubtitles: item.sidecarSubtitles ?? [],
    metadataError: item.metadataError,
    playbackSeconds,
    nextEpisode: nextEpisode
      ? {
        id: nextEpisode.id,
        displayTitle: displayTitle(nextEpisode),
        url: `/watch/${encodeURIComponent(nextEpisode.id)}`,
      }
      : undefined,
  };
}

export function mediaSummary(item: MediaFile) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    displayTitle: displayTitle(item),
    relativePath: item.relativePath,
    showTitle: item.showTitle,
    season: item.season,
    episode: item.episode,
    episodeTitle: item.episodeTitle,
    year: item.year,
    durationSeconds: item.durationSeconds,
    mimeType: item.mimeType,
    videoCodec: item.videoCodec,
    audioCodec: item.audioCodec,
    width: item.width,
    height: item.height,
    subtitleCount: (item.sidecarSubtitles?.length ?? 0) +
      (item.embeddedSubtitles?.length ?? 0),
  };
}

export function json(data: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(data)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function displayTitle(item: MediaFile): string {
  if (item.kind === "episode") {
    const episode = item.season && item.episode
      ? `S${String(item.season).padStart(2, "0")}E${
        String(item.episode).padStart(2, "0")
      }`
      : "";
    return [item.showTitle, episode, item.episodeTitle].filter(Boolean).join(
      " - ",
    );
  }

  return item.year ? `${item.title} (${item.year})` : item.title;
}

function subtitlePayload(item: MediaFile) {
  const sidecars = (item.sidecarSubtitles ?? []).map((subtitle, index) => ({
    label: subtitle.label,
    format: subtitle.format,
    source: "sidecar",
    url: `/subtitles/${encodeURIComponent(item.id)}/${index}`,
  }));
  const embedded = (item.embeddedSubtitles ?? [])
    .filter((subtitle) =>
      subtitle.renderable && subtitle.streamIndex !== undefined
    )
    .map((subtitle) => ({
      label: subtitleLabel(subtitle),
      format: "vtt" as const,
      source: "embedded",
      url: `/embedded-subtitles/${
        encodeURIComponent(item.id)
      }/${subtitle.streamIndex}`,
    }));

  return sidecars.concat(embedded);
}

function subtitleLabel(subtitle: {
  codec?: string;
  language?: string;
  name?: string;
  streamIndex?: number;
}): string {
  return [
    subtitle.name,
    subtitle.language?.toUpperCase(),
    subtitle.codec,
    subtitle.streamIndex !== undefined ? `#${subtitle.streamIndex}` : undefined,
  ].filter(Boolean).join(" ");
}
