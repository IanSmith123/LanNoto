package storage

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type TreeEntry struct {
	Path   string `json:"path"`
	Folder bool   `json:"folder"`
	Asset  bool   `json:"asset,omitempty"`
}

var ErrOwnSubtree = errors.New("cannot move a folder into its own subtree")
var ErrDifferentVolume = errors.New("cannot move across filesystem volumes")

func staticPath(name string) bool {
	return name == "static" || strings.HasPrefix(name, "static/")
}

func validWorkspacePath(name string) error {
	first, _, _ := strings.Cut(name, "/")
	if first != "static" && strings.EqualFold(first, "static") {
		return ErrName
	}
	for _, part := range strings.Split(name, "/") {
		if !visibleAssetName(part) {
			return ErrName
		}
	}
	return nil
}

func validTreePath(name string) error {
	if staticPath(name) {
		return ErrName
	}
	return validWorkspacePath(name)
}

func ValidNotePath(name string) error {
	if err := validTreePath(name); err != nil {
		return err
	}
	return ValidName(path.Base(name), true)
}

func (w *Workspace) checkFolder(name string) error {
	if name == "." {
		return nil
	}
	parts := strings.Split(name, "/")
	for i := range parts {
		entry, err := w.exactEntry(strings.Join(parts[:i+1], "/"))
		if err != nil {
			return err
		}
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return ErrName
		}
	}
	return nil
}

// A differently cased alias must not open a second room on the same file.
func (w *Workspace) exactEntry(name string) (fs.DirEntry, error) {
	dir, err := w.notesRoot.Open(path.Dir(name))
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	for {
		entries, err := dir.ReadDir(32)
		for _, entry := range entries {
			if entry.Name() == path.Base(name) {
				return entry, nil
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, os.ErrNotExist
			}
			return nil, err
		}
	}
}

func (w *Workspace) Tree() ([]TreeEntry, error) {
	w.notesMu.RLock()
	defer w.notesMu.RUnlock()
	return w.tree()
}

func (w *Workspace) tree() ([]TreeEntry, error) {
	entries := []TreeEntry{}
	err := fs.WalkDir(w.notesRoot.FS(), ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || name == "." {
			return err
		}
		isAsset := staticPath(name) || !entry.IsDir() && !strings.HasSuffix(name, ".md")
		if validWorkspacePath(name) != nil {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.IsDir() || entry.Type().IsRegular() {
			entries = append(entries, TreeEntry{Path: name, Folder: entry.IsDir(), Asset: isAsset})
		}
		return nil
	})
	return entries, err
}

func (w *Workspace) CreateFolder(name string) error {
	if validWorkspacePath(name) != nil || name == "static" {
		return ErrName
	}
	w.notesMu.Lock()
	defer w.notesMu.Unlock()
	if err := w.checkFolder(path.Dir(name)); err != nil {
		return err
	}
	if err := w.notesRoot.Mkdir(name, 0700); err != nil {
		return err
	}
	return syncDir(filepath.Join(w.Notes, path.Dir(name)))
}

func (w *Workspace) Relocate(from, to string) (string, error) {
	if validWorkspacePath(from) != nil || validWorkspacePath(to) != nil || from == "static" || to == "static" {
		return "", ErrName
	}
	if strings.HasPrefix(to, from+"/") {
		return "", ErrOwnSubtree
	}
	sourceParent, targetParent := path.Dir(from), path.Dir(to)
	w.notesMu.Lock()
	defer w.notesMu.Unlock()
	if err := w.checkFolder(sourceParent); err != nil {
		return "", err
	}
	if err := w.checkFolder(targetParent); err != nil {
		return "", err
	}
	entry, err := w.exactEntry(from)
	if err != nil {
		return "", err
	}
	info, err := entry.Info()
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() && !info.Mode().IsRegular() {
		return "", ErrName
	}
	note := !info.IsDir() && ValidNotePath(from) == nil
	if info.IsDir() && staticPath(from) != staticPath(to) || !info.IsDir() && note != (ValidNotePath(to) == nil) {
		return "", ErrName
	}
	if from == to {
		return to, nil
	}
	target, err := w.notesRoot.Lstat(to)
	if err == nil {
		if !strings.EqualFold(from, to) || !os.SameFile(info, target) {
			return "", os.ErrExist
		}
		// Case-insensitive filesystems can resolve both spellings to one
		// entry. Still reject a distinct destination hard link.
		if _, err := w.exactEntry(to); err == nil {
			return "", os.ErrExist
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	sourceDir, err := w.notesRoot.Open(sourceParent)
	if err != nil {
		return "", err
	}
	defer sourceDir.Close()
	targetDir := sourceDir
	if targetParent != sourceParent {
		targetDir, err = w.notesRoot.Open(targetParent)
		if err != nil {
			return "", err
		}
		defer targetDir.Close()
	}
	if !note && (!info.IsDir() || staticPath(from)) {
		if err := renameExclusive(sourceDir, targetDir, path.Base(from), path.Base(to)); err != nil {
			return "", err
		}
		return to, w.syncRelocation(from, to)
	}
	entries, err := w.tree()
	if err != nil {
		return "", err
	}
	if err := w.renameWithMetadata(sourceDir, targetDir, from, to, entries); err != nil {
		return "", err
	}
	return to, nil
}
