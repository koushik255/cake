import { resolve } from "std/path";

export type AppConfig = {
  mediaDir: string;
  libraryFile: string;
  hostname: string;
  port: number;
  playbackMode: PlaybackMode;
  transcodeCacheDir: string;
  maxTranscodes: number;
  hardwareAcceleration: HardwareAccelerationMode;
  autoScan: boolean;
  autoScanDelaySeconds: number;
  libraryUpdatePollSeconds: number;
};

export type PlaybackMode = "direct" | "auto" | "server";
export type HardwareAccelerationMode = "auto" | "prefer-software";

type RawConfig = Partial<{
  mediaDir: string;
  libraryFile: string;
  hostname: string;
  port: number | string;
  playbackMode: PlaybackMode;
  transcodeCacheDir: string;
  maxTranscodes: number | string;
  hardwareAcceleration: HardwareAccelerationMode;
  autoScan: boolean | string;
  autoScanDelaySeconds: number | string;
  libraryUpdatePollSeconds: number | string;
}>;

export async function loadConfig(path = "./config.json"): Promise<AppConfig> {
  const fileConfig = await readConfigFile(path);

  return {
    mediaDir: Deno.env.get("MEDIA_DIR") ?? fileConfig.mediaDir ?? "./media",
    libraryFile: Deno.env.get("LIBRARY_FILE") ?? fileConfig.libraryFile ??
      "./library.json",
    hostname: Deno.env.get("HOST") ?? fileConfig.hostname ?? "127.0.0.1",
    port: parsePort(Deno.env.get("PORT") ?? fileConfig.port ?? 8080),
    playbackMode: parsePlaybackMode(
      Deno.env.get("PLAYBACK_MODE") ?? fileConfig.playbackMode ?? "auto",
    ),
    transcodeCacheDir: Deno.env.get("TRANSCODE_CACHE_DIR") ??
      fileConfig.transcodeCacheDir ?? ".cache/transcodes",
    maxTranscodes: parsePositiveInteger(
      Deno.env.get("MAX_TRANSCODES") ?? fileConfig.maxTranscodes ?? 1,
      "maxTranscodes",
    ),
    hardwareAcceleration: parseHardwareAccelerationMode(
      Deno.env.get("HARDWARE_ACCELERATION") ??
        fileConfig.hardwareAcceleration ?? "auto",
    ),
    autoScan: parseBoolean(
      Deno.env.get("AUTO_SCAN") ?? fileConfig.autoScan ?? false,
      "autoScan",
    ),
    autoScanDelaySeconds: parsePositiveInteger(
      Deno.env.get("AUTO_SCAN_DELAY_SECONDS") ??
        fileConfig.autoScanDelaySeconds ?? 10,
      "autoScanDelaySeconds",
    ),
    libraryUpdatePollSeconds: parsePositiveInteger(
      Deno.env.get("LIBRARY_UPDATE_POLL_SECONDS") ??
        fileConfig.libraryUpdatePollSeconds ?? 20,
      "libraryUpdatePollSeconds",
    ),
  };
}

export function describeConfig(config: AppConfig): string[] {
  return [
    `Media directory: ${resolve(config.mediaDir)}`,
    `Library cache: ${resolve(config.libraryFile)}`,
    `Playback mode: ${config.playbackMode}`,
    `Transcode cache: ${resolve(config.transcodeCacheDir)}`,
    `Max transcodes: ${config.maxTranscodes}`,
    `Hardware acceleration: ${config.hardwareAcceleration}`,
    `Auto scan: ${config.autoScan ? "enabled" : "disabled"}`,
    `Listening on http://${config.hostname}:${config.port}`,
  ];
}

async function readConfigFile(path: string): Promise<RawConfig> {
  try {
    const raw = await Deno.readTextFile(path);
    return JSON.parse(raw) as RawConfig;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {};
    }

    throw error;
  }
}

function parsePort(value: number | string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

function parsePositiveInteger(value: number | string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseBoolean(value: boolean | string, name: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  throw new Error(`Invalid ${name}: ${value}`);
}

function parsePlaybackMode(value: string): PlaybackMode {
  if (value === "direct" || value === "auto" || value === "server") {
    return value;
  }

  throw new Error(`Invalid playbackMode: ${value}`);
}

function parseHardwareAccelerationMode(
  value: string,
): HardwareAccelerationMode {
  if (value === "auto" || value === "prefer-software") {
    return value;
  }

  throw new Error(`Invalid hardwareAcceleration: ${value}`);
}
