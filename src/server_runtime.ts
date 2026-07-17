import type { AppConfig } from "./config.ts";

export async function registerServerMediaRuntime(
  config: Pick<AppConfig, "hardwareAcceleration" | "playbackMode">,
): Promise<void> {
  if (config.playbackMode === "direct") {
    return;
  }

  const { registerMediabunnyServer } = await import("@mediabunny/server");
  registerMediabunnyServer(
    config.hardwareAcceleration === "prefer-software"
      ? { hardwareContext: null }
      : {},
  );
}
