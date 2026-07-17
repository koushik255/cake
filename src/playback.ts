import type { AppConfig } from "./config.ts";
import type { MediaFile } from "./types.ts";

export type PlaybackDecision = {
  mode: "direct" | "transcode";
  url: string;
  canDirectPlay: boolean;
  requiresTranscode: boolean;
  transcodeReason?: TranscodeReason;
  directUrl: string;
  transcodeUrl?: string;
  directFirst: boolean;
};

export type TranscodeReason =
  | "container"
  | "video-codec"
  | "audio-codec"
  | "metadata";

const DIRECT_PLAY_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const DIRECT_PLAY_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const DIRECT_PLAY_VIDEO_CODECS = new Set([
  "avc",
  "avc1",
  "h264",
  "vp8",
  "vp09",
  "vp9",
]);
const DIRECT_PLAY_AUDIO_CODECS = new Set([
  "aac",
  "mp3",
  "mp4a",
  "opus",
  "vorbis",
]);

export function playbackDecision(
  item: MediaFile,
  config: Pick<AppConfig, "playbackMode">,
): PlaybackDecision {
  const directUrl = `/stream/${encodeURIComponent(item.id)}/direct`;
  const transcodeUrl = `/hls/${encodeURIComponent(item.id)}/master.m3u8`;
  const directPlayIssue = directPlayIssueFor(item);
  const canDirectPlay = directPlayIssue === undefined;
  const serverAvailable = config.playbackMode !== "direct";
  const shouldTranscode = config.playbackMode === "server" ||
    (config.playbackMode === "auto" && !canDirectPlay);

  if (shouldTranscode) {
    return {
      mode: "transcode",
      url: transcodeUrl,
      canDirectPlay,
      requiresTranscode: true,
      transcodeReason: directPlayIssue,
      directUrl,
      transcodeUrl,
      directFirst: config.playbackMode === "auto",
    };
  }

  return {
    mode: "direct",
    url: directUrl,
    canDirectPlay,
    requiresTranscode: false,
    transcodeReason: directPlayIssue,
    directUrl,
    transcodeUrl: serverAvailable ? transcodeUrl : undefined,
    directFirst: config.playbackMode === "auto",
  };
}

function directPlayIssueFor(item: MediaFile): TranscodeReason | undefined {
  if (item.metadataError) {
    return "metadata";
  }

  if (!directPlayContainer(item)) {
    return "container";
  }

  if (
    item.videoCodec && !DIRECT_PLAY_VIDEO_CODECS.has(normalizeCodec(
      item.videoCodec,
    ))
  ) {
    return "video-codec";
  }

  if (
    item.audioCodec && !DIRECT_PLAY_AUDIO_CODECS.has(normalizeCodec(
      item.audioCodec,
    ))
  ) {
    return "audio-codec";
  }

  return undefined;
}

function directPlayContainer(item: MediaFile): boolean {
  if (item.mimeType && DIRECT_PLAY_MIME_TYPES.has(item.mimeType)) {
    return true;
  }

  return DIRECT_PLAY_EXTENSIONS.has(item.extension);
}

function normalizeCodec(codec: string): string {
  return codec.toLowerCase().split(".")[0];
}
