package storage

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type pathIndex struct {
	Keys    map[string]string `json:"keys"`
	Pending *pathRename       `json:"pending,omitempty"`
}

type pathRename struct {
	From string            `json:"from"`
	To   string            `json:"to"`
	Keys map[string]string `json:"keys"`
}

func snapshotFile(key string) string {
	if strings.ContainsAny(key, "/\x00") {
		return "note-" + Hash([]byte(key)) + ".json"
	}
	return key + ".json"
}

func (w *Workspace) metadataKey(name string) string {
	w.keysMu.RLock()
	defer w.keysMu.RUnlock()
	return keyFor(w.keys, name)
}

func keyFor(keys map[string]string, name string) string {
	if key, ok := keys[name]; ok {
		return key
	}
	return name
}

func validKeys(keys map[string]string) bool {
	seen := make(map[string]bool, len(keys))
	for name, key := range keys {
		if ValidNotePath(name) != nil || seen[key] || !strings.HasPrefix(key, "\x00") && ValidNotePath(key) != nil {
			return false
		}
		seen[key] = true
	}
	return true
}

func (w *Workspace) pathsFile() string {
	return filepath.Join(filepath.Dir(w.State), "paths.json")
}

func (w *Workspace) writePaths(index pathIndex) error {
	data, err := json.Marshal(index)
	if err != nil {
		return err
	}
	return AtomicWrite(w.pathsFile(), data)
}

func (w *Workspace) loadPaths() (result error) {
	w.keys = map[string]string{}
	root, err := os.OpenRoot(filepath.Dir(w.State))
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, root.Close()) }()
	data, err := readRegular(root, "paths.json", 32<<20)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var index pathIndex
	if err := json.Unmarshal(data, &index); err != nil {
		return fmt.Errorf("read note paths: %w", err)
	}
	if index.Keys == nil || !validKeys(index.Keys) {
		return errors.New("invalid note path index")
	}
	w.keys = index.Keys
	if index.Pending == nil {
		return nil
	}
	move := index.Pending
	if validTreePath(move.From) != nil || validTreePath(move.To) != nil || move.From == move.To || strings.HasPrefix(move.To, move.From+"/") || move.Keys == nil || !validKeys(move.Keys) {
		return errors.New("invalid pending note rename")
	}
	_, oldErr := w.exactEntry(move.From)
	_, newErr := w.exactEntry(move.To)
	for _, err := range []error{oldErr, newErr} {
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	oldExists, newExists := oldErr == nil, newErr == nil
	if oldExists == newExists {
		return fmt.Errorf("cannot determine whether note rename %q to %q completed", move.From, move.To)
	}
	if newExists {
		w.keys = move.Keys
	}
	return w.writePaths(pathIndex{Keys: w.keys})
}

func (w *Workspace) prepareNewKey(name string) error {
	w.keysMu.Lock()
	defer w.keysMu.Unlock()
	if _, renamed := w.keys[name]; !renamed {
		return nil
	}
	keys := maps.Clone(w.keys)
	keys[name] = "\x00" + rand.Text()
	if err := w.writePaths(pathIndex{Keys: keys}); err != nil {
		return err
	}
	w.keys = keys
	return nil
}

func (w *Workspace) renameWithMetadata(sourceDir, targetDir *os.File, from, to string, entries []TreeEntry) error {
	w.keysMu.Lock()
	defer w.keysMu.Unlock()
	keys := maps.Clone(w.keys)
	for _, entry := range entries {
		if entry.Folder || entry.Asset || entry.Path != from && !strings.HasPrefix(entry.Path, from+"/") {
			continue
		}
		keys[to+strings.TrimPrefix(entry.Path, from)] = keyFor(w.keys, entry.Path)
		// An old path reused later must never attach to the moved note's data.
		keys[entry.Path] = "\x00" + rand.Text()
	}
	intent := &pathRename{From: from, To: to, Keys: keys}
	if err := w.writePaths(pathIndex{Keys: w.keys, Pending: intent}); err != nil {
		return err
	}
	if err := renameExclusive(sourceDir, targetDir, path.Base(from), path.Base(to)); err != nil {
		return errors.Join(err, w.writePaths(pathIndex{Keys: w.keys}))
	}
	if err := w.syncRelocation(from, to); err != nil {
		return err
	}
	if err := w.writePaths(pathIndex{Keys: keys}); err != nil {
		return err
	}
	w.keys = keys
	return nil
}

func (w *Workspace) syncRelocation(from, to string) error {
	if err := syncDir(filepath.Join(w.Notes, path.Dir(from))); err != nil {
		return errors.Join(ErrIO, err)
	}
	if path.Dir(from) != path.Dir(to) {
		if err := syncDir(filepath.Join(w.Notes, path.Dir(to))); err != nil {
			return errors.Join(ErrIO, err)
		}
	}
	return nil
}
