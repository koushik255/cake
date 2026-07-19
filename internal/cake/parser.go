package cake

import (
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var (
	sxxExx       = regexp.MustCompile(`(?i)(?:^|[\s._-])s(\d{1,2})[\s._-]*e(\d{1,3})(?:\D|$)`)
	xPattern     = regexp.MustCompile(`(?i)(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?:\D|$)`)
	seasonDash   = regexp.MustCompile(`(?i)(?:^|[\s._-])s(\d{1,2})[\s._-]+(?:e[\s._-]*)?(\d{1,3})(?:\D|$)`)
	episodeOnly  = regexp.MustCompile(`(?i)(?:^|[\s._-])e(\d{1,3})(?:\D|$)`)
	yearPattern  = regexp.MustCompile(`(?:^|[\s([._-])(19\d{2}|20\d{2})(?:[\s)\]._,-]|$)`)
	brackets     = regexp.MustCompile(`\[[^\]]+\]`)
	openParen    = regexp.MustCompile(`\([^)]*$`)
	separators   = regexp.MustCompile(`[._-]+`)
	releaseTags  = regexp.MustCompile(`(?i)\b(720p|1080p|2160p|4k|web[- ]?dl|bluray|x264|x265|h264|h265|hevc|aac)\b`)
	spaces       = regexp.MustCompile(`\s+`)
	seasonFolder = regexp.MustCompile(`(?i)^season\s*\d+$`)
	showSuffix   = regexp.MustCompile(`(?i)\s+\b(?:s\d{1,2}|season\s*\d+)\b.*$`)
)

type parsedName struct {
	Kind                           MediaKind
	Title, ShowTitle, EpisodeTitle string
	Season, Episode, Year          *int
}

func parseMediaName(relativePath string) parsedName {
	normalized := filepath.ToSlash(relativePath)
	ext := filepath.Ext(normalized)
	base := strings.TrimSuffix(filepath.Base(normalized), ext)
	dir := filepath.ToSlash(filepath.Dir(normalized))
	var parts []string
	if dir != "." {
		parts = strings.FieldsFunc(dir, func(r rune) bool { return r == '/' })
	}
	patterns := []*regexp.Regexp{sxxExx, xPattern, seasonDash, episodeOnly}
	var match []int
	var groups []string
	fileMatch := false
	for _, p := range patterns {
		if idx := p.FindStringSubmatchIndex(base); idx != nil {
			match = idx
			groups = p.FindStringSubmatch(base)
			fileMatch = true
			break
		}
	}
	if match == nil {
		for _, p := range patterns {
			if idx := p.FindStringSubmatchIndex(normalized); idx != nil {
				match = idx
				groups = p.FindStringSubmatch(normalized)
				break
			}
		}
	}
	if match != nil {
		season, episode := 1, 0
		if len(groups) == 3 {
			season, _ = strconv.Atoi(groups[1])
			episode, _ = strconv.Atoi(groups[2])
		} else if len(groups) == 2 {
			episode, _ = strconv.Atoi(groups[1])
		}
		show := inferShowTitle(parts, base, func() int {
			if fileMatch {
				return match[0]
			}
			return 0
		}())
		episodeTitle := ""
		if fileMatch {
			episodeTitle = cleanTitle(base[match[1]:])
		}
		return parsedName{
			Kind: Episode, Title: show + " S" + pad2(season) + "E" + pad2(episode),
			ShowTitle: show, Season: &season, Episode: &episode,
			EpisodeTitle: episodeTitle,
		}
	}
	if match := yearPattern.FindStringSubmatchIndex(base); match != nil {
		year, _ := strconv.Atoi(base[match[2]:match[3]])
		title := cleanTitle(base[:match[0]])
		if title == "" {
			title = base
		}
		return parsedName{Kind: Movie, Title: title, Year: &year}
	}
	title := cleanTitle(base)
	if title == "" {
		title = base
	}
	return parsedName{Kind: Movie, Title: title}
}

func inferShowTitle(parts []string, base string, index int) string {
	if title := cleanTitle(base[:index]); title != "" {
		return title
	}
	for i, part := range parts {
		if seasonFolder.MatchString(part) && i > 0 {
			return cleanTitle(parts[i-1])
		}
	}
	collections := map[string]bool{
		"series": true, "show": true, "shows": true, "tv": true,
		"tv series": true, "tv shows": true, "television": true,
	}
	for i, part := range parts {
		if collections[strings.ToLower(cleanTitle(part))] && i+1 < len(parts) {
			return cleanTitle(parts[i+1])
		}
	}
	if len(parts) > 0 {
		return strings.TrimSpace(showSuffix.ReplaceAllString(cleanTitle(parts[0]), ""))
	}
	return "Unknown Show"
}
func cleanTitle(v string) string {
	v = brackets.ReplaceAllString(v, " ")
	v = openParen.ReplaceAllString(v, " ")
	v = separators.ReplaceAllString(v, " ")
	v = releaseTags.ReplaceAllString(v, " ")
	return strings.TrimSpace(spaces.ReplaceAllString(v, " "))
}
func pad2(v int) string {
	if v < 10 {
		return "0" + strconv.Itoa(v)
	}
	return strconv.Itoa(v)
}
