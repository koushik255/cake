import { basename, dirname, extname } from "std/path";
import { toPosixPath } from "./path.ts";
import type { MediaFile, MediaKind } from "./types.ts";

type ParsedName = Pick<
  MediaFile,
  | "kind"
  | "title"
  | "showTitle"
  | "season"
  | "episode"
  | "episodeTitle"
  | "year"
>;

const SXX_EXX_PATTERN =
  /(?:^|[\s._-])s(?<season>\d{1,2})[\s._-]*e(?<episode>\d{1,3})(?:\D|$)/i;
const X_PATTERN =
  /(?:^|[\s._-])(?<season>\d{1,2})x(?<episode>\d{1,3})(?:\D|$)/i;
const YEAR_PATTERN = /(?:^|[\s([._-])(?<year>19\d{2}|20\d{2})(?:[\s)\]._,-]|$)/;
const TV_COLLECTION_FOLDERS = new Set([
  "series",
  "show",
  "shows",
  "tv",
  "tv series",
  "tv shows",
  "television",
]);

export function parseMediaName(relativePath: string): ParsedName {
  const normalized = toPosixPath(relativePath);
  const extension = extname(normalized);
  const fileBase = basename(normalized, extension);
  const directory = dirname(normalized);
  const parts = directory === "." ? [] : directory.split("/").filter(Boolean);
  const tvMatch = SXX_EXX_PATTERN.exec(fileBase) ??
    SXX_EXX_PATTERN.exec(normalized) ??
    X_PATTERN.exec(fileBase) ??
    X_PATTERN.exec(normalized);

  if (tvMatch?.groups) {
    const season = Number(tvMatch.groups.season);
    const episode = Number(tvMatch.groups.episode);
    const showTitle = inferShowTitle(parts, fileBase, tvMatch.index);
    const episodeTitle = cleanTitle(
      fileBase.slice(tvMatch.index + tvMatch[0].length),
    );

    return {
      kind: "episode",
      title: `${showTitle} S${pad2(season)}E${pad2(episode)}`,
      showTitle,
      season,
      episode,
      episodeTitle: episodeTitle || undefined,
    };
  }

  const yearMatch = YEAR_PATTERN.exec(fileBase);
  const title = cleanTitle(
    yearMatch?.groups?.year ? fileBase.slice(0, yearMatch.index) : fileBase,
  );

  return {
    kind: "movie" satisfies MediaKind,
    title: title || fileBase,
    year: yearMatch?.groups?.year ? Number(yearMatch.groups.year) : undefined,
  };
}

function inferShowTitle(
  parts: string[],
  fileBase: string,
  matchIndex: number,
): string {
  const seasonFolderIndex = parts.findIndex((part) =>
    /^season\s*\d+$/i.test(part)
  );
  if (seasonFolderIndex > 0) {
    return cleanTitle(parts[seasonFolderIndex - 1]);
  }

  const collectionFolderIndex = parts.findIndex((part) =>
    TV_COLLECTION_FOLDERS.has(cleanTitle(part).toLowerCase())
  );
  if (collectionFolderIndex !== -1 && parts[collectionFolderIndex + 1]) {
    return cleanTitle(parts[collectionFolderIndex + 1]);
  }

  if (parts.length > 0) {
    return cleanTitle(parts[0]);
  }

  return cleanTitle(fileBase.slice(0, matchIndex)) || "Unknown Show";
}

function cleanTitle(value: string): string {
  return value
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]*$/g, " ")
    .replace(/[._-]+/g, " ")
    .replace(
      /\b(720p|1080p|2160p|4k|web[- ]?dl|bluray|x264|x265|h264|h265|hevc|aac)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
