import type { AppConfig } from "./config.ts";
import type { LibraryStore } from "./library.ts";

export function startAutoScan(
  store: LibraryStore,
  config: Pick<AppConfig, "autoScan" | "autoScanDelaySeconds" | "mediaDir">,
): void {
  if (!config.autoScan) {
    return;
  }

  const delayMs = config.autoScanDelaySeconds * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rescanning = false;
  let rescanAgain = false;

  const scheduleRescan = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    timer = setTimeout(async () => {
      timer = undefined;

      if (rescanning) {
        rescanAgain = true;
        return;
      }

      rescanning = true;
      try {
        console.log("Media folder changed; rescanning library...");
        await store.rescan();
        console.log("Library rescan complete.");
      } catch (error) {
        console.error("Auto scan failed:", error);
      } finally {
        rescanning = false;
      }

      if (rescanAgain) {
        rescanAgain = false;
        scheduleRescan();
      }
    }, delayMs);
  };

  const watcher = Deno.watchFs(config.mediaDir, { recursive: true });
  console.log(
    `Watching media directory for changes every ${config.autoScanDelaySeconds}s debounce.`,
  );

  (async () => {
    try {
      for await (const event of watcher) {
        if (event.kind === "access" || event.kind === "any") {
          continue;
        }

        scheduleRescan();
      }
    } catch (error) {
      console.error("Media directory watcher stopped:", error);
    }
  })();
}
