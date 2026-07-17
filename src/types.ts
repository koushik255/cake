export type MediaKind = "movie" | "episode";

export type MediaFile = {
  id: string;
  kind: MediaKind;
  title: string;
  path: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  extension: string;
  showTitle?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  year?: number;
  durationSeconds?: number;
  mimeType?: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  embeddedSubtitles?: SubtitleTrack[];
  sidecarSubtitles?: SidecarSubtitle[];
  metadataError?: string;
};

export type SubtitleTrack = {
  streamIndex?: number;
  codec?: string;
  language?: string;
  name?: string;
  source?: "mediabunny" | "ffprobe";
  renderable?: boolean;
};

export type SidecarSubtitle = {
  path: string;
  relativePath: string;
  label: string;
  format: "srt" | "vtt";
  language?: string;
};

export type Library = {
  mediaDir: string;
  scannedAt: string;
  items: MediaFile[];
};
