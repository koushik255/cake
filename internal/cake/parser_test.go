package cake

import "testing"

func TestParseMediaNameCompatibility(t *testing.T) {
	tests := []struct {
		name, path, kind, show, title, episodeTitle string
		season, episode, year                       int
	}{
		{"season dash", "Grand Blue S02 1080p WEBRip DD+ x265-EMBER/[EMBER] Grand Blue S2 - 01.mkv", "episode", "Grand Blue", "", "", 2, 1, 0},
		{
			"episode only",
			"[Reaktor] Legend of the Galactic Heroes - Ginga Eiyuu Densetsu [720p][x265][10-bit]/[Reaktor] Legend of the Galactic Heroes - E001 [720p][x265][10-bit].mkv",
			"episode", "Legend of the Galactic Heroes", "", "", 1, 1, 0,
		},
		{"numbered movie", "Movies/Ocean's 11 (2001).mkv", "movie", "", "Ocean's 11", "", 0, 0, 2001},
		{"sxxexx", "Grand Blue Dreaming S01 1080p BDRip/S01E01-Deep Blue.mkv", "episode", "Grand Blue Dreaming", "", "Deep Blue", 1, 1, 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := parseMediaName(test.path)
			matches := string(got.Kind) == test.kind && got.ShowTitle == test.show &&
				(test.title == "" || got.Title == test.title) &&
				got.EpisodeTitle == test.episodeTitle &&
				intValue(got.Season) == test.season &&
				intValue(got.Episode) == test.episode && intValue(got.Year) == test.year
			if !matches {
				t.Fatalf("parseMediaName(%q) = %#v", test.path, got)
			}
		})
	}
}

func TestStableIDMatchesDenoSHA256(t *testing.T) {
	if got, want := stableID("Movies/Ocean's 11 (2001).mkv"), "149e4f140767d0a88788d2c9"; got != want {
		t.Fatalf("stableID = %q, want %q", got, want)
	}
}
