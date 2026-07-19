package cake

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ProfileStore struct {
	path string
	mu   sync.Mutex
}

type profilesFile struct {
	Profiles []Profile `json:"profiles"`
}

func NewProfileStore(path string) *ProfileStore {
	return &ProfileStore{path: path}
}

func (s *ProfileStore) All() ([]Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

func (s *ProfileStore) Find(id string) (*Profile, error) {
	profiles, err := s.All()
	if err != nil {
		return nil, err
	}
	for i := range profiles {
		if profiles[i].ID == id {
			return &profiles[i], nil
		}
	}
	return nil, nil
}
func (s *ProfileStore) Create(name string) (Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	name = strings.TrimSpace(name)
	if name == "" {
		return Profile{}, errors.New("Profile name is required.")
	}
	profiles, err := s.load()
	if err != nil {
		return Profile{}, err
	}
	ids := make(map[string]bool)
	for _, p := range profiles {
		ids[p.ID] = true
	}
	base := slugify(name)
	if base == "" {
		base = "profile"
	}
	id := base
	for n := 2; ids[id]; n++ {
		id = base + "-" + strconv.Itoa(n)
	}
	profile := Profile{ID: id, Name: name, CreatedAt: isoTime(time.Now())}
	profiles = append(profiles, profile)
	data, err := json.MarshalIndent(profilesFile{Profiles: profiles}, "", "  ")
	if err == nil {
		data = append(data, '\n')
		err = writeFileAtomic(s.path, data, 0o644)
	}
	return profile, err
}

func (s *ProfileStore) load() ([]Profile, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return []Profile{}, nil
	}
	if err != nil {
		return nil, err
	}
	var f profilesFile
	if json.Unmarshal(data, &f) != nil {
		return []Profile{}, nil
	}
	if f.Profiles == nil {
		return []Profile{}, nil
	}
	return f.Profiles, nil
}

func selectedProfileID(r *http.Request) string {
	cookie, err := r.Cookie("cake_profile")
	if err != nil {
		return ""
	}
	return cookie.Value
}

func setProfileCookie(w http.ResponseWriter, p Profile) {
	http.SetCookie(w, &http.Cookie{
		Name: "cake_profile", Value: p.ID, Path: "/",
		SameSite: http.SameSiteLaxMode,
		MaxAge:   31536000,
	})
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	return strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(s), "-"), "-")
}
