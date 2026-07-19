package cake

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	MediaDir                  string `json:"mediaDir"`
	LibraryFile               string `json:"libraryFile"`
	Hostname                  string `json:"hostname"`
	Port                      int    `json:"port"`
	PlaybackMode              string `json:"playbackMode"`
	TranscodeCacheDir         string `json:"transcodeCacheDir"`
	TranscodeCacheMaxAgeHours int    `json:"transcodeCacheMaxAgeHours"`
	MaxTranscodes             int    `json:"maxTranscodes"`
	HardwareAcceleration      string `json:"hardwareAcceleration"`
	TranscodeVideoMode        string `json:"transcodeVideoMode"`
	TranscodeAudioCodec       string `json:"transcodeAudioCodec"`
	AutoScan                  bool   `json:"autoScan"`
	AutoScanDelaySeconds      int    `json:"autoScanDelaySeconds"`
	LibraryUpdatePollSeconds  int    `json:"libraryUpdatePollSeconds"`
}

func LoadConfig(path string) (Config, error) {
	c := Config{
		MediaDir: "./media", LibraryFile: "./library.json", Hostname: "127.0.0.1", Port: 8080,
		PlaybackMode: "auto", TranscodeCacheDir: ".cache/transcodes",
		TranscodeCacheMaxAgeHours: 24, MaxTranscodes: 1, HardwareAcceleration: "auto",
		TranscodeVideoMode: "avc", TranscodeAudioCodec: "aac", AutoScanDelaySeconds: 10,
		LibraryUpdatePollSeconds: 20,
	}
	data, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(data, &c); err != nil {
			return Config{}, fmt.Errorf("read config: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return Config{}, err
	}

	stringEnv := map[string]*string{
		"MEDIA_DIR": &c.MediaDir, "LIBRARY_FILE": &c.LibraryFile, "HOST": &c.Hostname,
		"PLAYBACK_MODE": &c.PlaybackMode, "TRANSCODE_CACHE_DIR": &c.TranscodeCacheDir,
		"HARDWARE_ACCELERATION": &c.HardwareAcceleration,
		"TRANSCODE_VIDEO_MODE":  &c.TranscodeVideoMode, "TRANSCODE_AUDIO_CODEC": &c.TranscodeAudioCodec,
	}
	for name, target := range stringEnv {
		if value, ok := os.LookupEnv(name); ok {
			*target = value
		}
	}
	for name, target := range map[string]*int{
		"PORT": &c.Port, "TRANSCODE_CACHE_MAX_AGE_HOURS": &c.TranscodeCacheMaxAgeHours,
		"MAX_TRANSCODES": &c.MaxTranscodes, "AUTO_SCAN_DELAY_SECONDS": &c.AutoScanDelaySeconds,
		"LIBRARY_UPDATE_POLL_SECONDS": &c.LibraryUpdatePollSeconds,
	} {
		if value, ok := os.LookupEnv(name); ok {
			parsed, err := strconv.Atoi(value)
			if err != nil {
				return Config{}, fmt.Errorf("invalid %s: %s", name, value)
			}
			*target = parsed
		}
	}
	if value, ok := os.LookupEnv("AUTO_SCAN"); ok {
		switch strings.ToLower(value) {
		case "true", "1":
			c.AutoScan = true
		case "false", "0":
			c.AutoScan = false
		default:
			return Config{}, fmt.Errorf("invalid AUTO_SCAN: %s", value)
		}
	}
	if c.Port < 1 || c.Port > 65535 {
		return Config{}, fmt.Errorf("invalid port: %d", c.Port)
	}
	if c.TranscodeCacheMaxAgeHours < 1 || c.MaxTranscodes < 1 || c.AutoScanDelaySeconds < 1 || c.LibraryUpdatePollSeconds < 1 {
		return Config{}, fmt.Errorf("positive configuration values must be at least 1")
	}
	if !oneOf(c.PlaybackMode, "direct", "auto", "server") {
		return Config{}, fmt.Errorf("invalid playbackMode: %s", c.PlaybackMode)
	}
	if !oneOf(c.HardwareAcceleration, "auto", "prefer-software") {
		return Config{}, fmt.Errorf("invalid hardwareAcceleration: %s", c.HardwareAcceleration)
	}
	if !oneOf(c.TranscodeVideoMode, "copy", "avc") {
		return Config{}, fmt.Errorf("invalid transcodeVideoMode: %s", c.TranscodeVideoMode)
	}
	if !oneOf(c.TranscodeAudioCodec, "aac", "opus") {
		return Config{}, fmt.Errorf("invalid transcodeAudioCodec: %s", c.TranscodeAudioCodec)
	}
	if c.MediaDir, err = filepath.Abs(c.MediaDir); err != nil {
		return Config{}, err
	}
	if c.LibraryFile, err = filepath.Abs(c.LibraryFile); err != nil {
		return Config{}, err
	}
	if c.TranscodeCacheDir, err = filepath.Abs(c.TranscodeCacheDir); err != nil {
		return Config{}, err
	}
	return c, nil
}

func oneOf(value string, values ...string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
