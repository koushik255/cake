import { render } from "preact-render-to-string";
import type { ComponentChildren } from "preact";
import { displayTitle } from "./api.ts";
import type { AppConfig } from "./config.ts";
import type { Profile } from "./profiles.ts";
import type { Library, MediaFile } from "./types.ts";
import type { LastWatchedItem } from "./watch_history.ts";

type LayoutOptions = {
  library?: Library;
  profile?: Profile;
  updatePollSeconds?: number;
};

type ShowGroup = { id: string; title: string; episodes: MediaFile[] };

export function profilePage(profiles: Profile[]): Response {
  return page(
    "Profiles",
    <section class="profile-list">
      <p class="eyebrow">Cake</p>
      <h1>Who’s watching?</h1>
      <div class="profile-buttons">
        {profiles.map((profile) => (
          <form
            method="post"
            action={`/profiles/select/${encodeURIComponent(profile.id)}`}
          >
            <button class="profile-button" type="submit">{profile.name}</button>
          </form>
        ))}
      </div>
      <form class="add-profile" method="post" action="/profiles">
        <label for="profile-name">Add a profile</label>
        <div>
          <input
            id="profile-name"
            name="name"
            placeholder="Name"
            autocomplete="off"
          />
          <button type="submit">Add</button>
        </div>
      </form>
    </section>,
  );
}

export function indexPage(
  library: Library,
  lastWatched: LastWatchedItem[],
  profile: Profile,
  config?: Pick<AppConfig, "libraryUpdatePollSeconds">,
): Response {
  const movies = library.items.filter((item) => item.kind === "movie");
  const episodes = library.items.filter((item) => item.kind === "episode");
  const shows = groupShows(episodes);
  return page(
    "Cake",
    <>
      <PageHeader
        title="Library"
        subtitle={`${library.items.length} files · scanned ${
          formatDate(library.scannedAt)
        }`}
      />
      <LastWatched items={uniqueContinueWatching(lastWatched)} />
      <section>
        <div class="section-heading">
          <h2>Library</h2>
          <div class="library-tools">
            <span>{movies.length + shows.length} titles</span>
            <LibrarySearch />
          </div>
        </div>
        <LibraryTable movies={movies} shows={shows} />
      </section>
    </>,
    libraryOptions(library, profile, config),
  );
}

export function moviesPage(
  library: Library,
  profile: Profile,
  config?: Pick<AppConfig, "libraryUpdatePollSeconds">,
): Response {
  const items = library.items.filter((item) => item.kind === "movie");
  return mediaListPage("Movies", library, items, profile, config);
}

export function tvPage(
  library: Library,
  profile: Profile,
  config?: Pick<AppConfig, "libraryUpdatePollSeconds">,
): Response {
  const episodes = library.items.filter((item) => item.kind === "episode");
  const shows = groupShows(episodes);
  return page(
    "Shows",
    <>
      <PageHeader
        title="Shows"
        subtitle={`${shows.length} shows · ${episodes.length} episodes · scanned ${
          formatDate(library.scannedAt)
        }`}
      />
      <p class="back-link">
        <a href="/">← Home</a>
      </p>
      <ShowTable shows={shows} />
    </>,
    libraryOptions(library, profile, config),
  );
}

export function showPage(
  library: Library,
  profile: Profile,
  showId: string,
  config?: Pick<AppConfig, "libraryUpdatePollSeconds">,
): Response {
  const show = groupShows(
    library.items.filter((item) => item.kind === "episode"),
  ).find((group) => group.id === showId);
  if (!show) return notFoundPage();
  return page(
    show.title,
    <>
      <PageHeader
        title={show.title}
        subtitle={`${show.episodes.length} episode${
          show.episodes.length === 1 ? "" : "s"
        } · scanned ${formatDate(library.scannedAt)}`}
      />
      <p class="back-link">
        <a href="/shows">← Shows</a>
      </p>
      <EpisodeTable episodes={show.episodes} />
    </>,
    libraryOptions(library, profile, config),
  );
}

export function playerPage(item: MediaFile): Response {
  const metadata = [
    item.year,
    item.durationSeconds && formatDuration(item.durationSeconds),
    item.width && item.height && `${item.width}×${item.height}`,
    item.videoCodec,
    item.audioCodec,
    item.mimeType,
  ].filter(Boolean).join(" · ");
  const sidecars = item.sidecarSubtitles?.length ?? 0;
  const embedded = item.embeddedSubtitles?.length ?? 0;
  const playable =
    item.embeddedSubtitles?.filter((subtitle) => subtitle.renderable).length ??
      0;
  const subtitleSummary = [
    sidecars
      ? `${sidecars} sidecar subtitle${sidecars === 1 ? "" : "s"}`
      : undefined,
    embedded
      ? `${embedded} embedded subtitle track${embedded === 1 ? "" : "s"}${
        playable ? `, ${playable} playable` : ""
      }`
      : undefined,
  ].filter(Boolean).join(" · ");
  return page(
    item.title,
    <>
      <p class="back-link">
        <a href="/">← Home</a>
      </p>
      <h1>{displayTitle(item)}</h1>
      <p class="muted">{metadata || item.relativePath}</p>
      {subtitleSummary && <p class="muted">{subtitleSummary}</p>}
      {item.metadataError && <p class="error">{item.metadataError}</p>}
      <div data-mediabunny-player data-media-id={item.id}>
        <p id="player-status" class="muted">Loading player…</p>
        <p id="player-warning" class="warning" hidden></p>
        <p id="player-error" class="error" hidden></p>
        <div class="player-frame">
          <canvas id="mediabunny-canvas"></canvas>
          <div id="subtitle-overlay" class="subtitle-overlay"></div>
        </div>
        <p class="player-controls">
          <button id="play-button" type="button" disabled>Play</button>
          <button id="stop-button" type="button" disabled>Stop</button>
          <button id="next-episode-button" type="button" hidden>
            Next episode
          </button>
          <button id="fullscreen-button" type="button">Fullscreen</button>
          <select id="subtitle-select" disabled>
            <option value="">Subtitles off</option>
          </select>
          <span id="current-time">0:00</span>
          <input
            id="progress"
            type="range"
            min="0"
            max="1"
            step="0.001"
            value="0"
            disabled
          />
          <span id="duration">0:00</span>
        </p>
      </div>
      <script type="module" src="/player.js"></script>
      <p class="muted path">{item.relativePath}</p>
    </>,
  );
}

export function notFoundPage(): Response {
  return page(
    "Not found",
    <main class="empty">
      <p class="eyebrow">404</p>
      <h1>Not found</h1>
      <p>
        <a href="/">Return home</a>
      </p>
    </main>,
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header class="page-header">
      <div>
        <p class="eyebrow">Cake library</p>
        <h1>{title}</h1>
        <p class="muted">{subtitle}</p>
      </div>
      <form method="post" action="/rescan">
        <button class="secondary" type="submit">Rescan</button>
      </form>
    </header>
  );
}

function LastWatched({ items }: { items: LastWatchedItem[] }) {
  if (!items.length) return null;
  return (
    <section>
      <div class="section-heading">
        <h2>Continue watching</h2>
        <span>{items.length} recent</span>
      </div>
      <div class="last-watched">
        {items.map(({ item, playbackSeconds }) => {
          const at = playbackSeconds ?? 0;
          const progress = playbackProgress(item, playbackSeconds);
          const showTitle = item.kind === "episode"
            ? item.showTitle ?? item.title
            : displayTitle(item);
          const episode = item.kind === "episode" ? episodeNumber(item) : "";
          return (
            <a
              class="last-watched-card"
              href={`/watch/${encodeURIComponent(item.id)}`}
            >
              <img
                src={`/thumbnails/${encodeURIComponent(item.id)}.jpg?at=${at}`}
                loading="lazy"
                alt={`Frame from ${displayTitle(item)}`}
              />
              <strong>{showTitle}</strong>
              <span>
                {episode && `${episode} · `}Resume{" "}
                {playbackSeconds === undefined
                  ? "from start"
                  : `at ${formatDuration(playbackSeconds)}`}
              </span>
              {progress !== undefined && (
                <span
                  class="resume-progress"
                  aria-label={`${progress}% watched`}
                >
                  <span style={{ width: `${progress}%` }} />
                </span>
              )}
            </a>
          );
        })}
      </div>
    </section>
  );
}

function playbackProgress(
  item: MediaFile,
  playbackSeconds: number | undefined,
): number | undefined {
  if (!item.durationSeconds || playbackSeconds === undefined) return undefined;
  return Math.min(
    100,
    Math.max(0, Math.round(playbackSeconds / item.durationSeconds * 100)),
  );
}

function LibrarySearch() {
  return (
    <input
      id="library-search"
      class="library-search"
      type="search"
      placeholder="Search library"
      aria-label="Search library"
    />
  );
}

function uniqueContinueWatching(
  items: LastWatchedItem[],
): LastWatchedItem[] {
  const seen = new Set<string>();
  return items.filter(({ item }) => {
    // Keep only the most recently watched episode of each series.
    const key = item.kind === "episode"
      ? `show:${item.showTitle ?? item.title}`
      : `movie:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function MediaTable({ items }: { items: MediaFile[] }) {
  if (!items.length) return <EmptyLibrary />;
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Details</th>
            <th>Path</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr>
              <td>
                <a href={`/watch/${encodeURIComponent(item.id)}`}>
                  {displayTitle(item)}
                </a>
              </td>
              <td>{itemDetails(item)}</td>
              <td class="muted">{item.relativePath}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LibraryTable(
  { movies, shows }: { movies: MediaFile[]; shows: ShowGroup[] },
) {
  if (!movies.length && !shows.length) return <EmptyLibrary />;
  const rows = [
    ...shows.map((show) => ({
      title: show.title,
      url: `/shows/${encodeURIComponent(show.id)}`,
      details: `${show.episodes.length} episode${
        show.episodes.length === 1 ? "" : "s"
      }`,
      path: commonShowPath(show.episodes),
    })),
    ...movies.map((movie) => ({
      title: displayTitle(movie),
      url: `/watch/${encodeURIComponent(movie.id)}`,
      details: itemDetails(movie),
      path: movie.relativePath,
    })),
  ].sort((a, b) => a.title.localeCompare(b.title));
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Details</th>
            <th>Path</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              data-library-row
              data-search={`${row.title} ${row.details} ${row.path}`
                .toLowerCase()}
            >
              <td>
                <a href={row.url}>{row.title}</a>
              </td>
              <td>{row.details}</td>
              <td class="muted">{row.path}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShowTable({ shows }: { shows: ShowGroup[] }) {
  if (!shows.length) return <EmptyLibrary />;
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Show</th>
            <th>Episodes</th>
            <th>Path</th>
          </tr>
        </thead>
        <tbody>
          {shows.map((show) => (
            <tr>
              <td>
                <a href={`/shows/${encodeURIComponent(show.id)}`}>
                  {show.title}
                </a>
              </td>
              <td>{show.episodes.length}</td>
              <td class="muted">{commonShowPath(show.episodes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EpisodeTable({ episodes }: { episodes: MediaFile[] }) {
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Episode</th>
            <th>Title</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {episodes.map((item) => (
            <tr>
              <td>{episodeNumber(item)}</td>
              <td>
                <a href={`/watch/${encodeURIComponent(item.id)}`}>
                  {item.episodeTitle || displayTitle(item)}
                </a>
              </td>
              <td>{itemDetails(item)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyLibrary() {
  return <p class="empty">No videos found yet.</p>;
}

function mediaListPage(
  title: string,
  library: Library,
  items: MediaFile[],
  profile: Profile,
  config?: Pick<AppConfig, "libraryUpdatePollSeconds">,
): Response {
  return page(
    title,
    <>
      <PageHeader
        title={title}
        subtitle={`${items.length} files · scanned ${
          formatDate(library.scannedAt)
        }`}
      />
      <p class="back-link">
        <a href="/">← Home</a>
      </p>
      <MediaTable items={items} />
    </>,
    libraryOptions(library, profile, config),
  );
}

function page(
  title: string,
  children: ComponentChildren,
  options: LayoutOptions = {},
  status = 200,
): Response {
  return new Response(
    `<!doctype html>${
      render(<Layout title={title} options={options}>{children}</Layout>)
    }`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function Layout(
  { title, options, children }: {
    title: string;
    options: LayoutOptions;
    children: ComponentChildren;
  },
) {
  const script = libraryUpdateScript(options);
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3" />
        <link rel="manifest" href="/site.webmanifest?v=3" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </head>
      <body>
        <div class="shell">
          <ProfileBar profile={options.profile} />
          <main>{children}</main>
        </div>
        {script && <script dangerouslySetInnerHTML={{ __html: script }} />}
      </body>
    </html>
  );
}

function ProfileBar({ profile }: { profile?: Profile }) {
  return profile
    ? (
      <div class="profile-bar">
        <a class="brand" href="/">Cake</a>
        <nav class="top-nav">
          <a href="/movies">Movies</a>
          <a href="/shows">Shows</a>
        </nav>
        <span>
          Watching as <strong>{profile.name}</strong>
        </span>
        <a href="/profiles">Switch</a>
      </div>
    )
    : null;
}

function groupShows(episodes: MediaFile[]): ShowGroup[] {
  const groups = new Map<string, MediaFile[]>();
  for (const item of episodes) {
    const title = item.showTitle ?? "Unknown Show";
    groups.set(title, [...(groups.get(title) ?? []), item]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map((
    [title, showEpisodes],
  ) => ({
    id: slugify(title),
    title,
    episodes: showEpisodes.toSorted((a, b) =>
      (a.season ?? 0) - (b.season ?? 0) ||
      (a.episode ?? 0) - (b.episode ?? 0) || a.title.localeCompare(b.title)
    ),
  }));
}
function itemDetails(item: MediaFile): string {
  const subtitles = (item.sidecarSubtitles?.length ?? 0) +
    (item.embeddedSubtitles?.length ?? 0);
  return [
    item.durationSeconds ? formatDuration(item.durationSeconds) : undefined,
    item.width && item.height ? `${item.width}×${item.height}` : undefined,
    item.videoCodec,
    subtitles ? `${subtitles} subs` : undefined,
    item.extension.replace(".", "").toUpperCase(),
  ].filter(Boolean).join(" · ");
}
function episodeNumber(item: MediaFile): string {
  return item.season && item.episode
    ? `S${String(item.season).padStart(2, "0")}E${
      String(item.episode).padStart(2, "0")
    }`
    : "";
}
function commonShowPath(episodes: MediaFile[]): string {
  const path = episodes[0]?.relativePath ?? "";
  return path.includes("/") ? path.split("/").slice(0, -1).join("/") : path;
}
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
}
function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
function libraryOptions(
  library: Library,
  profile: Profile,
  config?: Pick<AppConfig, "libraryUpdatePollSeconds">,
): LayoutOptions {
  return {
    library,
    profile,
    updatePollSeconds: config?.libraryUpdatePollSeconds,
  };
}
function libraryUpdateScript(options: LayoutOptions): string | undefined {
  if (!options.library || !options.updatePollSeconds) return;
  const scannedAt = JSON.stringify(options.library.scannedAt);
  const count = options.library.items.length;
  return `(() => { const search = document.querySelector('#library-search'); search?.addEventListener('input', () => { const value = search.value.toLowerCase().trim(); document.querySelectorAll('[data-library-row]').forEach((row) => { row.hidden = !row.dataset.search.includes(value); }); }); const scannedAt = ${scannedAt}; const count = ${count}; let shown = false; setInterval(async () => { if (shown || document.hidden) return; try { const response = await fetch('/api/library-version', { cache: 'no-store' }); const version = await response.json(); if (response.ok && (version.scannedAt !== scannedAt || version.count !== count)) { shown = true; const banner = document.createElement('div'); banner.className = 'library-update-banner'; banner.textContent = 'Library updated.'; const button = document.createElement('button'); button.textContent = 'Refresh'; button.onclick = () => location.reload(); banner.append(button); document.body.append(banner); } } catch {} }, ${
    options.updatePollSeconds * 1000
  }); })();`;
}

const styles =
  `:root{color:#202124;background:#fff;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45}*{box-sizing:border-box}body{margin:0}.shell{max-width:960px;margin:0 auto;padding:1.25rem 1.5rem 4rem}a{color:#1f5fbf;text-decoration:underline;text-underline-offset:2px}a:hover{color:#174a96}button,input,select{font:inherit}button{cursor:pointer;border:1px solid #b8bec7;border-radius:4px;background:#f8f9fa;color:#202124;padding:.45rem .7rem}button:hover{background:#eef3fa;border-color:#7b8796}.secondary{background:#fff}.profile-bar{display:flex;align-items:center;gap:.7rem;margin-bottom:2.5rem;color:#5f6368;font-size:.9rem}.profile-bar .brand{color:#202124;font-size:1.15rem;font-weight:650;text-decoration:none;margin-right:1rem}.top-nav{display:flex;gap:.8rem;margin-right:auto}.top-nav a{text-decoration:none}.profile-bar strong{color:#202124}.eyebrow{color:#5f6368;font-size:.8rem;margin:0 0 .25rem}h1,h2{line-height:1.25;font-weight:650;color:#202124}h1{font-size:1.6rem;margin:0 0 .3rem}h2{font-size:1.25rem;margin:0}.muted,.section-heading span,.last-watched-card span{color:#5f6368}.page-header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:1rem}.page-header .muted{margin:0}.section-heading{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin:2.25rem 0 .75rem}.library-tools{display:flex;align-items:center;gap:.75rem}.section-heading span{font-size:.85rem;white-space:nowrap}.library-search{width:180px;padding:.38rem .5rem;border:1px solid #b8bec7;border-radius:4px}.last-watched{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,460px));gap:1rem}.last-watched-card{color:#202124;text-decoration:none}.last-watched-card:hover{color:#202124}.last-watched-card img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#eceff1;border:1px solid #d7dce1;border-radius:4px}.last-watched-card strong,.last-watched-card span{display:block;margin-top:.4rem}.last-watched-card strong{font-size:1rem;font-weight:600}.last-watched-card span{font-size:.85rem}.resume-progress{height:4px;background:#e1e4e8;border-radius:2px;overflow:hidden}.resume-progress span{height:100%;margin:0;background:#1f5fbf;border-radius:2px}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:560px}th,td{padding:.65rem .5rem;border-bottom:1px solid #e1e4e8;text-align:left;vertical-align:top}th{font-size:.78rem;color:#5f6368;font-weight:600}td:first-child{font-weight:500}.back-link{margin:0 0 1.25rem}.empty{padding:1rem 0;color:#5f6368}.profile-list{max-width:520px;margin:12vh auto}.profile-buttons{margin:1.5rem 0}.profile-buttons form{margin:0}.profile-button{display:block;width:100%;padding:.8rem 0;text-align:left;background:#fff;color:#202124;border:0;border-bottom:1px solid #e1e4e8;border-radius:0;font-size:1.2rem}.profile-button:hover{background:#f8f9fa}.add-profile label{display:block;margin-bottom:.35rem;font-size:.9rem;color:#5f6368}.add-profile input{width:min(280px,70%);padding:.45rem;border:1px solid #b8bec7;border-radius:4px;margin-right:.5rem}.error{color:#b3261e}.warning{color:#8a5a00}.path{font-size:.85rem;overflow-wrap:anywhere;margin-top:1.5rem}.player-frame{position:relative;width:100%;max-height:70vh;overflow:hidden;background:#000;border-radius:4px}.player-frame canvas{display:block;width:100%;background:#000}.subtitle-overlay{position:absolute;left:4%;right:4%;bottom:5%;color:#fff;text-align:center;font-size:1.35rem;font-weight:700;text-shadow:0 2px 4px #000;white-space:pre-line}.subtitle-overlay:empty{display:none}.player-controls{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}.player-controls input[type=range]{flex:1;min-width:12rem}[data-mediabunny-player]:fullscreen,[data-mediabunny-player]:-webkit-full-screen{display:flex;flex-direction:column;width:100vw;height:100vh;padding:0;background:#000;color:#fff}[data-mediabunny-player]:fullscreen #player-status,[data-mediabunny-player]:-webkit-full-screen #player-status{margin:.5rem 1rem;color:#ddd}[data-mediabunny-player]:fullscreen .player-frame,[data-mediabunny-player]:-webkit-full-screen .player-frame{display:flex;flex:1 1 auto;align-items:center;justify-content:center;min-height:0;max-height:none;border-radius:0}[data-mediabunny-player]:fullscreen .player-frame canvas,[data-mediabunny-player]:-webkit-full-screen .player-frame canvas{width:auto;height:auto;max-width:100%;max-height:100%;object-fit:contain}[data-mediabunny-player]:fullscreen .subtitle-overlay,[data-mediabunny-player]:-webkit-full-screen .subtitle-overlay{bottom:7%;font-size:clamp(1.4rem,3vw,3rem)}[data-mediabunny-player]:fullscreen .player-controls,[data-mediabunny-player]:-webkit-full-screen .player-controls{box-sizing:border-box;width:100%;margin:0;padding:.75rem 1rem;background:#000}[data-mediabunny-player]:fullscreen.controls-hidden{cursor:none}[data-mediabunny-player]:fullscreen.controls-hidden .player-controls{opacity:0;pointer-events:none}[data-mediabunny-player]:fullscreen.controls-hidden #player-status{opacity:0}.library-update-banner{position:fixed;left:50%;bottom:1rem;z-index:20;display:flex;gap:.75rem;align-items:center;transform:translateX(-50%);padding:.65rem .85rem;background:#202124;color:#fff;border-radius:4px;box-shadow:0 2px 8px #0003}.library-update-banner button{background:#fff;color:#202124;border:0}@media(max-width:620px){.shell{padding:1.25rem 1rem 3rem}.profile-bar{flex-wrap:wrap;margin-bottom:2rem}.top-nav{order:3;width:100%}.page-header{display:block}.page-header form{margin-top:1rem}.section-heading{align-items:flex-start}.library-tools{align-items:flex-end;flex-direction:column}.library-search{width:150px}.last-watched{grid-template-columns:1fr}.last-watched-card strong{font-size:.9rem}.last-watched-card span{font-size:.78rem}}`;
