package cake

import (
	"embed"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed templates/*.html
var pageTemplatesFS embed.FS

type showGroup struct {
	ID       string
	Title    string
	Episodes []MediaFile
}

type pageData struct {
	Title    string
	Heading  string
	Subtitle string
	BackURL  string
	Poll     bool

	Config   Config
	Profile  *Profile
	Profiles []Profile
	Library  *Library
	Movies   []MediaFile
	Shows    []showGroup
	Show     *showGroup
	Item     *MediaFile
	Recent   []LastWatchedItem
}

var pageTemplates = template.Must(template.New("pages").Funcs(template.FuncMap{
	"displayTitle":     displayTitle,
	"episodeNumber":    episodeNumber,
	"episodeTitle":     episodeTitle,
	"mediaDetail":      mediaDetail,
	"mediaMetadata":    mediaMetadata,
	"pathEscape":       url.PathEscape,
	"playbackPosition": playbackPosition,
	"pollMillis":       func(seconds int) int { return seconds * 1000 },
	"resumeTime":       resumeTime,
	"searchText":       searchText,
}).ParseFS(pageTemplatesFS, "templates/*.html"))

func (a *App) servePage(w http.ResponseWriter, r *http.Request) error {
	if r.URL.Path == "/profiles" {
		profiles, err := a.profiles.All()
		if err != nil {
			return err
		}
		return executePage(w, "profiles", http.StatusOK, pageData{
			Title:    "Profiles",
			Profiles: profiles,
		})
	}

	profile, err := a.currentProfile(r)
	if err != nil {
		return err
	}
	if profile == nil {
		http.Redirect(w, r, "/profiles", http.StatusSeeOther)
		return nil
	}

	library, err := a.library.Load()
	if err != nil {
		return err
	}
	data := pageData{
		Config:  a.config,
		Profile: profile,
		Library: library,
	}

	switch {
	case r.URL.Path == "/":
		return a.serveHomePage(w, data)
	case r.URL.Path == "/movies":
		return serveMoviesPage(w, data)
	case r.URL.Path == "/shows" || r.URL.Path == "/tv":
		return serveShowsPage(w, data)
	case strings.HasPrefix(r.URL.Path, "/shows/"):
		id, _ := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/shows/"))
		return serveShowPage(w, data, id)
	case strings.HasPrefix(r.URL.Path, "/watch/"):
		id, _ := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/watch/"))
		return a.servePlayerPage(w, data, id)
	default:
		return executePage(w, "notFound", http.StatusOK, pageData{
			Title:   "Not found",
			Profile: profile,
		})
	}
}

func (a *App) serveHomePage(w http.ResponseWriter, data pageData) error {
	recent, err := a.history.Recent(data.Profile.ID, data.Library, 8)
	if err != nil {
		return err
	}
	movies, episodes := splitLibrary(data.Library)
	data.Title = "Cake"
	data.Heading = "Library"
	data.Subtitle = fmt.Sprintf("%d files - scanned %s", len(data.Library.Items), formatDate(data.Library.ScannedAt))
	data.Movies = firstMedia(movies, 12)
	data.Shows = firstShows(groupShows(episodes), 12)
	data.Recent = uniqueRecent(recent)
	data.Poll = true
	return executePage(w, "home", http.StatusOK, data)
}

func serveMoviesPage(w http.ResponseWriter, data pageData) error {
	movies, _ := splitLibrary(data.Library)
	data.Title = "Movies"
	data.Heading = "Movies"
	data.Subtitle = fmt.Sprintf("%d titles - scanned %s", len(movies), formatDate(data.Library.ScannedAt))
	data.BackURL = "/"
	data.Movies = movies
	data.Poll = true
	return executePage(w, "movies", http.StatusOK, data)
}

func serveShowsPage(w http.ResponseWriter, data pageData) error {
	_, episodes := splitLibrary(data.Library)
	data.Title = "Shows"
	data.Heading = "Shows"
	data.Subtitle = fmt.Sprintf(
		"%d shows - %d episodes - scanned %s",
		len(groupShows(episodes)), len(episodes), formatDate(data.Library.ScannedAt),
	)
	data.BackURL = "/"
	data.Shows = groupShows(episodes)
	data.Poll = true
	return executePage(w, "shows", http.StatusOK, data)
}

func serveShowPage(w http.ResponseWriter, data pageData, id string) error {
	_, episodes := splitLibrary(data.Library)
	show := findShow(groupShows(episodes), id)
	if show == nil {
		data.Title = "Not found"
		return executePage(w, "notFound", http.StatusOK, data)
	}
	data.Title = show.Title
	data.Heading = show.Title
	data.Subtitle = fmt.Sprintf("%d episodes - scanned %s", len(show.Episodes), formatDate(data.Library.ScannedAt))
	data.BackURL = "/shows"
	data.Show = show
	data.Poll = true
	return executePage(w, "show", http.StatusOK, data)
}

func (a *App) servePlayerPage(w http.ResponseWriter, data pageData, id string) error {
	item, err := a.library.Find(id)
	if err != nil {
		return err
	}
	if item == nil {
		data.Title = "Not found"
		return executePage(w, "notFound", http.StatusOK, data)
	}
	data.Title = item.Title
	data.Item = item
	return executePage(w, "player", http.StatusOK, data)
}

func executePage(w http.ResponseWriter, name string, status int, data pageData) error {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	return pageTemplates.ExecuteTemplate(w, name, data)
}

func serveNotFoundPage(w http.ResponseWriter, profile *Profile) error {
	return executePage(w, "notFound", http.StatusOK, pageData{
		Title:   "Not found",
		Profile: profile,
	})
}

func splitLibrary(library *Library) (movies, episodes []MediaFile) {
	for _, item := range library.Items {
		if item.Kind == Movie {
			movies = append(movies, item)
		} else {
			episodes = append(episodes, item)
		}
	}
	return movies, episodes
}

func groupShows(episodes []MediaFile) []showGroup {
	byTitle := make(map[string][]MediaFile)
	for _, item := range episodes {
		byTitle[item.ShowTitle] = append(byTitle[item.ShowTitle], item)
	}
	groups := make([]showGroup, 0, len(byTitle))
	for title, items := range byTitle {
		groups = append(groups, showGroup{ID: slugify(title), Title: title, Episodes: items})
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].Title < groups[j].Title })
	return groups
}

func findShow(shows []showGroup, id string) *showGroup {
	for i := range shows {
		if shows[i].ID == id {
			return &shows[i]
		}
	}
	return nil
}

func uniqueRecent(items []LastWatchedItem) []LastWatchedItem {
	seen := make(map[string]bool)
	result := make([]LastWatchedItem, 0, len(items))
	for _, item := range items {
		key := "movie:" + item.Item.ID
		if item.Item.Kind == Episode {
			key = "show:" + item.Item.ShowTitle
		}
		if !seen[key] {
			seen[key] = true
			result = append(result, item)
		}
	}
	return result
}

func firstMedia(items []MediaFile, limit int) []MediaFile {
	if len(items) > limit {
		return items[:limit]
	}
	return items
}

func firstShows(shows []showGroup, limit int) []showGroup {
	if len(shows) > limit {
		return shows[:limit]
	}
	return shows
}

func episodeNumber(item MediaFile) string {
	if item.Season != nil && item.Episode != nil {
		return "S" + pad2(*item.Season) + "E" + pad2(*item.Episode)
	}
	return "Episode"
}

func episodeTitle(item MediaFile) string {
	if item.EpisodeTitle != "" {
		return item.EpisodeTitle
	}
	if item.Episode != nil {
		return fmt.Sprintf("Episode %d", *item.Episode)
	}
	return "Episode"
}

func mediaDetail(item MediaFile) string {
	if item.DurationSeconds != nil {
		return formatDuration(*item.DurationSeconds)
	}
	return "Movie"
}

func mediaMetadata(item MediaFile) string {
	parts := make([]string, 0, 6)
	if item.Year != nil {
		parts = append(parts, strconv.Itoa(*item.Year))
	}
	if item.DurationSeconds != nil {
		parts = append(parts, formatDuration(*item.DurationSeconds))
	}
	if item.Width != nil && item.Height != nil {
		parts = append(parts, fmt.Sprintf("%dx%d", *item.Width, *item.Height))
	}
	for _, value := range []string{item.VideoCodec, item.AudioCodec, item.MIMEType} {
		if value != "" {
			parts = append(parts, value)
		}
	}
	if len(parts) == 0 {
		return item.RelativePath
	}
	return strings.Join(parts, " - ")
}

func playbackPosition(item LastWatchedItem) int {
	if item.PlaybackSeconds == nil {
		return 0
	}
	return *item.PlaybackSeconds
}

func resumeTime(item LastWatchedItem) string {
	return formatDuration(float64(playbackPosition(item)))
}

func searchText(values ...string) string {
	return strings.ToLower(strings.Join(values, " "))
}

func formatDuration(seconds float64) string {
	total := int(seconds)
	hours := total / 3600
	minutes := (total % 3600) / 60
	secs := total % 60
	if hours > 0 {
		return fmt.Sprintf("%d:%02d:%02d", hours, minutes, secs)
	}
	return fmt.Sprintf("%d:%02d", minutes, secs)
}

func formatDate(value string) string {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return value
	}
	return parsed.Local().Format("Jan 2, 2006, 3:04 PM")
}
