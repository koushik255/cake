import {
  ALL_FORMATS,
  AudioBufferSink,
  CanvasSink,
  Input,
  UrlSource,
} from "/vendor/mediabunny/index.js";

const root = document.querySelector("[data-mediabunny-player]");
const canvas = document.querySelector("#mediabunny-canvas");
const statusElement = document.querySelector("#player-status");
const errorElement = document.querySelector("#player-error");
const warningElement = document.querySelector("#player-warning");
const playButton = document.querySelector("#play-button");
const stopButton = document.querySelector("#stop-button");
const nextEpisodeButton = document.querySelector("#next-episode-button");
const fullscreenButton = document.querySelector("#fullscreen-button");
const subtitleSelect = document.querySelector("#subtitle-select");
const subtitleOverlay = document.querySelector("#subtitle-overlay");
const progress = document.querySelector("#progress");
const currentTimeElement = document.querySelector("#current-time");
const durationElement = document.querySelector("#duration");
const context = canvas instanceof HTMLCanvasElement
  ? canvas.getContext("2d")
  : null;

let input = null;
let transcodedAudioInput = null;
let videoSink = null;
let audioSink = null;
let audioContext = null;
let gainNode = null;
let videoFrames = null;
let audioBuffers = null;
let nextFrame = null;
let firstTimestamp = 0;
let endTimestamp = 0;
let playbackTimeAtStart = 0;
let audioContextStartTime = 0;
let wallClockStartTime = 0;
let playing = false;
let renderId = 0;
let subtitleTracks = [];
let activeSubtitleCues = [];
let activeSubtitleIndex = 0;
const queuedAudioNodes = new Set();
let controlsHideTimeout = 0;
let lastProgressPaint = 0;
let media = null;
let wakeLock = null;
let seekTimeout = 0;
let seekToken = 0;

init().catch(showError);
globalThis.addEventListener("pagehide", () => {
  savePlaybackPosition({ keepalive: true }).catch(console.error);
});

async function init() {
  if (!root || !canvas || !context) {
    return;
  }

  setStatus("Opening media URL...");
  media = await fetchMedia(root.dataset.mediaId);
  subtitleTracks = media.subtitles ?? [];
  configureSubtitleSelect();
  configureNextEpisodeButton();

  const candidates = playbackCandidates();
  let lastError = null;
  for (const [index, candidate] of candidates.entries()) {
    try {
      await preparePlayback(candidate);
      break;
    } catch (error) {
      lastError = error;
      await resetPlaybackAttempt();
      if (index === candidates.length - 1) {
        throw error;
      }

      console.warn(`Could not use ${candidate.label} playback:`, error);
      setStatus("Direct playback failed; starting server transcode...");
    }
  }

  if (lastError && input === null) {
    throw lastError;
  }

  playButton.disabled = false;
  stopButton.disabled = false;
  progress.disabled = false;
  subtitleSelect.disabled = subtitleTracks.length === 0;
  setStatus("Ready");
  requestAnimationFrame(render);
}

async function preparePlayback(candidate) {
  setStatus(`Opening ${candidate.label} media URL...`);
  input = new Input({
    // Live HLS playlists reuse the same URL while their contents grow. Force
    // every refresh through to Cake instead of accepting a browser/proxy copy.
    source: new UrlSource(candidate.url, {
      requestInit: { cache: "no-store" },
      fetchFn: diagnosticMediaFetch,
    }),
    formats: ALL_FORMATS,
  });

  setStatus("Reading video track...");
  let videoTrack = await input.getPrimaryVideoTrack();
  setStatus("Reading audio track...");
  let audioTrack = await input.getPrimaryAudioTrack();
  const tracks = [videoTrack, audioTrack].filter(Boolean);

  if (tracks.length === 0) {
    throw new Error("No audio or video track found.");
  }

  setStatus("Reading timestamps...");
  firstTimestamp = Math.max(await input.getFirstTimestamp(tracks), 0);
  setStatus("Reading duration...");
  const currentlyAvailableEnd = await input.getDurationFromMetadata(tracks, {
    skipLiveWait: true,
  }) ?? await input.computeDuration(tracks, { skipLiveWait: true });
  // A live HLS playlist initially contains only the first few transcoded
  // segments. Keep the timeline at the source duration instead of stopping
  // playback at the initial playlist edge; Mediabunny waits for new segments.
  endTimestamp = typeof media.durationSeconds === "number" &&
      Number.isFinite(media.durationSeconds)
    ? Math.max(currentlyAvailableEnd, media.durationSeconds)
    : currentlyAvailableEnd;
  playbackTimeAtStart = clampPlaybackTime(
    typeof media.playbackSeconds === "number"
      ? media.playbackSeconds
      : firstTimestamp,
  );
  durationElement.textContent = formatSeconds(endTimestamp);

  let videoWarning = "";
  let audioWarning = "";
  if (videoTrack) {
    setStatus("Checking video codec...");
    if (await videoTrack.getCodec() === null) {
      videoWarning = "Unsupported video codec. ";
      videoTrack = null;
    } else if (!(await videoTrack.canDecode())) {
      videoWarning =
        "This browser cannot decode the video track through WebCodecs. ";
      videoTrack = null;
    }
  }

  if (audioTrack) {
    setStatus("Checking audio codec...");
    if (await audioTrack.getCodec() === null) {
      audioWarning = "Unsupported audio codec. ";
      audioTrack = null;
    } else if (!(await audioTrack.canDecode())) {
      audioWarning =
        "This browser cannot decode the audio track through WebCodecs. ";
      audioTrack = null;
    }
  }

  // Keep the original, seekable video and replace only an unsupported audio
  // track with a small server-generated Opus file.
  if (!audioTrack && videoTrack && candidate.opusAudioUrl) {
    setStatus("Preparing Opus audio fallback...");
    transcodedAudioInput = new Input({
      source: new UrlSource(candidate.opusAudioUrl, {
        requestInit: { cache: "no-store" },
      }),
      formats: ALL_FORMATS,
    });
    const opusTrack = await transcodedAudioInput.getPrimaryAudioTrack();
    if (opusTrack && await opusTrack.getCodec() !== null &&
      await opusTrack.canDecode()) {
      audioTrack = opusTrack;
      audioWarning = "";
    }
  }

  const warning = videoWarning + audioWarning;
  if (videoWarning && candidate.fallbackOnUnsupportedVideo) {
    throw new Error(videoWarning.trim());
  }

  if (!videoTrack && !audioTrack) {
    throw new Error(warning || "No decodable audio or video track found.");
  }

  if (warningElement) {
    warningElement.textContent = warning;
    warningElement.hidden = !warning;
  }

  const BrowserAudioContext = globalThis.AudioContext ||
    globalThis.webkitAudioContext;
  audioContext = new BrowserAudioContext({
    sampleRate: audioTrack ? await audioTrack.getSampleRate() : undefined,
  });
  gainNode = audioContext.createGain();
  gainNode.connect(audioContext.destination);

  if (videoTrack) {
    setStatus("Preparing video renderer...");
    const transparent = await videoTrack.canBeTransparent();
    videoSink = new CanvasSink(videoTrack, {
      poolSize: 2,
      fit: "contain",
      alpha: transparent,
    });
    canvas.width = await videoTrack.getDisplayWidth();
    canvas.height = await videoTrack.getDisplayHeight();
    await startVideoIterator();
  } else {
    canvas.hidden = true;
  }

  if (audioTrack) {
    setStatus("Preparing audio renderer...");
    audioSink = new AudioBufferSink(audioTrack);
  }
  updateProgress(playbackTimeAtStart, true);
  updateSubtitle(playbackTimeAtStart);
}

async function diagnosticMediaFetch(resource, options) {
  const response = await fetch(resource, { ...options, cache: "no-store" });
  const url = response.url || String(resource);

  if (new URL(url, location.href).pathname.endsWith(".m3u8")) {
    console.info("[Cake HLS] Playlist fetched", {
      url,
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      cfCacheStatus: response.headers.get("cf-cache-status"),
      age: response.headers.get("age"),
      contentLength: response.headers.get("content-length"),
      date: response.headers.get("date"),
    });
  }

  return response;
}

function playbackCandidates() {
  const playback = media.playback;
  if (playback?.directUrl && playback.transcodeUrl) {
    return [
      {
        label: "direct video",
        url: playback.directUrl,
        opusAudioUrl: media.opusAudioUrl,
        fallbackOnUnsupportedVideo: true,
      },
      { label: "full server transcode", url: playback.transcodeUrl },
    ];
  }

  return [{ label: "selected", url: media.streamUrl }];
}

async function resetPlaybackAttempt() {
  await videoFrames?.return();
  await audioBuffers?.return();
  await audioContext?.close().catch(() => {});
  input?.dispose();
  transcodedAudioInput?.dispose();

  input = null;
  transcodedAudioInput = null;
  videoSink = null;
  audioSink = null;
  audioContext = null;
  gainNode = null;
  videoFrames = null;
  audioBuffers = null;
  nextFrame = null;
  firstTimestamp = 0;
  endTimestamp = 0;
  playbackTimeAtStart = 0;
  renderId++;
}

async function startVideoIterator() {
  renderId++;
  await videoFrames?.return();
  if (!videoSink) {
    return;
  }

  videoFrames = videoSink.canvases(getPlaybackTime());

  const first = (await videoFrames.next()).value ?? null;
  nextFrame = (await videoFrames.next()).value ?? null;

  if (first) {
    drawFrame(first);
  }
}

function render() {
  const time = getPlaybackTime();

  if (playing && time >= endTimestamp) {
    pause();
    playbackTimeAtStart = endTimestamp;
  }

  if (nextFrame && nextFrame.timestamp <= time) {
    drawFrame(nextFrame);
    nextFrame = null;
    updateNextFrame(renderId);
  }

  updateProgress(time);
  updateSubtitle(time);
  requestAnimationFrame(render);
}

async function updateNextFrame(id) {
  if (!videoFrames) {
    return;
  }

  while (id === renderId) {
    const frame = (await videoFrames.next()).value ?? null;
    if (!frame) {
      return;
    }

    if (frame.timestamp <= getPlaybackTime()) {
      drawFrame(frame);
    } else {
      nextFrame = frame;
      return;
    }
  }
}

function drawFrame(frame) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(frame.canvas, 0, 0);
}

async function play() {
  if (playing) {
    return;
  }

  if (getPlaybackTime() >= endTimestamp) {
    playbackTimeAtStart = firstTimestamp;
    await startVideoIterator();
  }
  savePlaybackPosition().catch(console.error);

  if (audioContext.state === "suspended") {
    audioContext.resume().catch(showError);
  }

  audioContextStartTime = audioContext.currentTime;
  wallClockStartTime = performance.now() / 1000;
  playing = true;
  requestWakeLock();
  playButton.textContent = "Pause";
  setStatus("Playing");
  scheduleFullscreenControlsHide();

  if (audioSink) {
    await audioBuffers?.return();
    audioBuffers = audioSink.buffers(getPlaybackTime());
    runAudioIterator();
  }
}

function pause() {
  if (!playing) {
    return;
  }

  playbackTimeAtStart = getPlaybackTime();
  playing = false;
  releaseWakeLock();
  playButton.textContent = "Play";
  setStatus("Paused");
  scheduleFullscreenControlsHide();
  audioBuffers?.return();
  audioBuffers = null;

  for (const node of queuedAudioNodes) {
    node.stop();
  }
  queuedAudioNodes.clear();
  savePlaybackPosition().catch(console.error);
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || wakeLock) {
    return;
  }

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (error) {
    console.warn("Could not request screen wake lock:", error);
  }
}

function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  lock?.release().catch(console.error);
}

async function runAudioIterator() {
  if (!audioBuffers) {
    return;
  }

  for await (const { buffer, timestamp } of audioBuffers) {
    const node = audioContext.createBufferSource();
    node.buffer = buffer;
    node.connect(gainNode);

    let startTimestamp = audioContextStartTime + timestamp -
      playbackTimeAtStart;
    startTimestamp = Math.round(audioContext.sampleRate * startTimestamp) /
      audioContext.sampleRate;

    if (startTimestamp >= audioContext.currentTime) {
      node.start(startTimestamp);
    } else {
      node.start(
        audioContext.currentTime,
        audioContext.currentTime - startTimestamp,
      );
    }

    queuedAudioNodes.add(node);
    node.onended = () => queuedAudioNodes.delete(node);

    if (timestamp - getPlaybackTime() >= 1) {
      await sleep(100);
    }
  }
}

async function seekTo(seconds) {
  clearTimeout(seekTimeout);
  const token = ++seekToken;
  const wasPlaying = playing;
  if (wasPlaying) {
    pause();
  }

  playbackTimeAtStart = clampPlaybackTime(seconds);
  updateProgress(playbackTimeAtStart, true);
  await startVideoIterator();

  if (token !== seekToken) {
    return;
  }

  if (wasPlaying) {
    await play();
  }
}

function scheduleSeekTo(seconds) {
  const target = clampPlaybackTime(seconds);
  playbackTimeAtStart = target;
  updateProgress(target, true);
  updateSubtitle(target);

  clearTimeout(seekTimeout);
  seekTimeout = setTimeout(() => {
    seekTo(target).catch(showError);
  }, 80);
}

function clampPlaybackTime(seconds) {
  return Math.max(
    firstTimestamp,
    Math.min(seconds, endTimestamp),
  );
}

function getPlaybackTime() {
  if (!playing) {
    return playbackTimeAtStart;
  }

  return performance.now() / 1000 - wallClockStartTime + playbackTimeAtStart;
}

function updateProgress(seconds, force = false) {
  const now = performance.now();
  if (!force && now - lastProgressPaint < 125) {
    return;
  }

  lastProgressPaint = now;
  currentTimeElement.textContent = formatSeconds(seconds);
  const span = endTimestamp - firstTimestamp;
  progress.value = span > 0 ? String((seconds - firstTimestamp) / span) : "0";
}

function updateSubtitle(seconds) {
  if (!subtitleOverlay || activeSubtitleCues.length === 0) {
    if (subtitleOverlay) {
      subtitleOverlay.textContent = "";
    }
    return;
  }

  while (
    activeSubtitleIndex > 0 &&
    seconds < activeSubtitleCues[activeSubtitleIndex]?.start
  ) {
    activeSubtitleIndex--;
  }

  while (
    activeSubtitleIndex < activeSubtitleCues.length - 1 &&
    seconds >= activeSubtitleCues[activeSubtitleIndex]?.end
  ) {
    activeSubtitleIndex++;
  }

  const cue = activeSubtitleCues[activeSubtitleIndex];
  subtitleOverlay.textContent = cue && seconds >= cue.start && seconds < cue.end
    ? cue.text
    : "";
}

function setStatus(message) {
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function showError(error) {
  console.error(error);
  setStatus("Error");
  if (errorElement) {
    errorElement.textContent = error instanceof Error
      ? error.message
      : String(error);
    errorElement.hidden = false;
  }
}

function formatSeconds(seconds) {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const rest = rounded % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${
      String(rest).padStart(2, "0")
    }`;
  }

  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function configureSubtitleSelect() {
  if (!subtitleSelect) {
    return;
  }

  for (const [index, subtitle] of subtitleTracks.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${subtitle.label} (${subtitle.format.toUpperCase()})`;
    subtitleSelect.append(option);
  }
}

function configureNextEpisodeButton() {
  if (!nextEpisodeButton) {
    return;
  }

  if (!media?.nextEpisode?.url) {
    nextEpisodeButton.hidden = true;
    return;
  }

  nextEpisodeButton.hidden = false;
  nextEpisodeButton.title = media.nextEpisode.displayTitle ?? "Next episode";
}

async function loadSubtitleTrack(index) {
  activeSubtitleCues = [];
  activeSubtitleIndex = 0;
  if (subtitleOverlay) {
    subtitleOverlay.textContent = "";
  }

  if (index === "") {
    return;
  }

  const subtitle = subtitleTracks[Number(index)];
  if (!subtitle) {
    return;
  }

  const response = await fetch(subtitle.url);
  if (!response.ok) {
    throw new Error(`Could not load subtitles: ${response.status}`);
  }

  const text = await response.text();
  activeSubtitleCues = subtitle.format === "vtt"
    ? parseVtt(text)
    : parseSrt(text);
  updateSubtitle(getPlaybackTime());
}

async function fetchMedia(id) {
  const response = await fetch(`/api/media/${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error(`Could not load media metadata: ${response.status}`);
  }

  return await response.json();
}

async function savePlaybackPosition(options = {}) {
  if (!media?.id || !input) {
    return;
  }

  const response = await fetch(
    `/api/watch-history/${encodeURIComponent(media.id)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playbackSeconds: Math.round(getPlaybackTime()),
      }),
      keepalive: options.keepalive === true,
    },
  );
  if (!response.ok) {
    throw new Error(`Could not update watch history: ${response.status}`);
  }
}

function parseSrt(text) {
  return text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .flatMap((block) => {
      const lines = block.split("\n").filter((line) => line.trim() !== "");
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex === -1) {
        return [];
      }

      const [startRaw, endRaw] = lines[timingIndex].split("-->");
      const start = parseSubtitleTimestamp(startRaw);
      const end = parseSubtitleTimestamp(endRaw);
      const cueText = lines.slice(timingIndex + 1).join("\n").trim();

      return Number.isFinite(start) && Number.isFinite(end) && cueText
        ? [{ start, end, text: cleanSubtitleText(cueText) }]
        : [];
    });
}

function parseVtt(text) {
  return text
    .replace(/\r/g, "")
    .replace(/^WEBVTT[^\n]*\n+/, "")
    .split(/\n{2,}/)
    .flatMap((block) => {
      const lines = block.split("\n").filter((line) => line.trim() !== "");
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex === -1) {
        return [];
      }

      const [startRaw, endRaw] = lines[timingIndex].split("-->");
      const start = parseSubtitleTimestamp(startRaw);
      const end = parseSubtitleTimestamp(endRaw);
      const cueText = lines.slice(timingIndex + 1).join("\n").trim();

      return Number.isFinite(start) && Number.isFinite(end) && cueText
        ? [{ start, end, text: cleanSubtitleText(cueText) }]
        : [];
    });
}

function parseSubtitleTimestamp(value) {
  const match = value.trim().match(
    /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/,
  );

  if (!match) {
    return NaN;
  }

  const [, rawHours, rawMinutes, rawSeconds, rawMilliseconds = "0"] = match;
  const hours = Number(rawHours ?? 0);
  const minutes = Number(rawMinutes);
  const seconds = Number(rawSeconds);
  const milliseconds = Number(rawMilliseconds.padEnd(3, "0"));

  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function cleanSubtitleText(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\{\\[^}]+\}/g, "")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function toggleFullscreen() {
  if (!fullscreenActive()) {
    if (root.requestFullscreen) {
      await root.requestFullscreen();
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    } else {
      throw new Error("Fullscreen is not supported by this browser.");
    }
  } else {
    if (document.exitFullscreen) {
      await document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

function updateFullscreenButton() {
  fullscreenButton.textContent = fullscreenActive()
    ? "Exit fullscreen"
    : "Fullscreen";
}

function fullscreenActive() {
  return document.fullscreenElement === root ||
    document.webkitFullscreenElement === root;
}

function showFullscreenControls() {
  root.classList.remove("controls-hidden");
  clearTimeout(controlsHideTimeout);
}

function scheduleFullscreenControlsHide() {
  showFullscreenControls();

  if (!fullscreenActive() || !playing) {
    return;
  }

  controlsHideTimeout = setTimeout(() => {
    if (
      fullscreenActive() &&
      !document.querySelector(".player-controls")?.matches(":hover")
    ) {
      root.classList.add("controls-hidden");
    }
  }, 1800);
}

playButton.addEventListener("click", () => {
  if (playing) {
    pause();
  } else {
    play().catch(showError);
  }
});

stopButton.addEventListener("click", () => {
  pause();
  seekTo(firstTimestamp).catch(showError);
});

nextEpisodeButton.addEventListener("click", () => {
  if (media?.nextEpisode?.url) {
    location.href = media.nextEpisode.url;
  }
});

fullscreenButton.addEventListener("click", () => {
  toggleFullscreen().catch(showError);
});

canvas.addEventListener("dblclick", () => {
  toggleFullscreen().catch(showError);
});

root.addEventListener("pointermove", scheduleFullscreenControlsHide);
root.addEventListener("pointerdown", scheduleFullscreenControlsHide);
root.addEventListener("focusin", showFullscreenControls);
root.addEventListener("focusout", scheduleFullscreenControlsHide);

progress.addEventListener("input", () => {
  showFullscreenControls();
  const span = endTimestamp - firstTimestamp;
  scheduleSeekTo(firstTimestamp + Number(progress.value) * span);
});

progress.addEventListener("change", () => {
  const span = endTimestamp - firstTimestamp;
  seekTo(firstTimestamp + Number(progress.value) * span).catch(showError);
  scheduleFullscreenControlsHide();
});

subtitleSelect.addEventListener("change", () => {
  showFullscreenControls();
  loadSubtitleTrack(subtitleSelect.value).catch(showError);
  scheduleFullscreenControlsHide();
});

document.addEventListener("fullscreenchange", () => {
  updateFullscreenButton();
  scheduleFullscreenControlsHide();
});

document.addEventListener("webkitfullscreenchange", () => {
  updateFullscreenButton();
  scheduleFullscreenControlsHide();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && playing) {
    requestWakeLock();
  }
});

document.addEventListener("keydown", (event) => {
  if (!fullscreenActive()) return;

  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLButtonElement
  ) {
    return;
  }

  if (event.key === " " || event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (playing) pause();
    else play().catch(showError);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    seekTo(clampPlaybackTime(getPlaybackTime() - 10)).catch(showError);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    seekTo(clampPlaybackTime(getPlaybackTime() + 10)).catch(showError);
  } else if (event.key.toLowerCase() === "f") {
    event.preventDefault();
    toggleFullscreen().catch(showError);
  }
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return;
  }

  if (event.key.toLowerCase() === "f") {
    event.preventDefault();
    toggleFullscreen().catch(showError);
  } else {
    scheduleFullscreenControlsHide();
  }
});
