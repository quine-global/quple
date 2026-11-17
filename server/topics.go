package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
)

// Topics is each person's ntfy topic, where their call notifications go:
// quple_<random>, unguessable since anyone may read a topic on our ntfy
// server (petersweb-infra docs/NTFY.md). Kept in a JSON file, like
// contacts, so a phone's subscription keeps working across restarts.
type Topics struct {
	mu     sync.Mutex
	path   string
	topics map[string]string
}

func LoadTopics(path string) (*Topics, error) {
	t := &Topics{path: path, topics: map[string]string{}}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return t, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &t.topics); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return t, nil
}

// Get returns username's topic, making one the first time.
func (t *Topics) Get(username string) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if topic, ok := t.topics[username]; ok {
		return topic, nil
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	topic := "quple_" + hex.EncodeToString(buf)
	t.topics[username] = topic
	raw, err := json.Marshal(t.topics)
	if err != nil {
		return "", err
	}
	tmp := t.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return "", err
	}
	return topic, os.Rename(tmp, t.path)
}
