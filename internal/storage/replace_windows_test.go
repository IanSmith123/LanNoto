package storage

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsReplacementReportsResourceUsers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "held.md")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := f.Close(); err != nil {
			t.Error(err)
		}
	}()
	err = AtomicWrite(path, []byte("new"))
	if err == nil {
		t.Fatal("replacement unexpectedly succeeded while delete sharing is denied")
	}
	if !strings.Contains(err.Error(), fmt.Sprintf("pid=%d", os.Getpid())) {
		t.Fatalf("holder not identified: %v", err)
	}
}

func TestUnchangedProjectionDoesNotReplaceHeldMarkdown(t *testing.T) {
	w := workspace(t)
	const name = "unchanged.md"
	if err := w.Create(name, "original"); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(filepath.Join(w.Notes, name))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := f.Close(); err != nil {
			t.Error(err)
		}
	}()
	projection := Snapshot{Filename: name, Markdown: "original", DiskHash: Hash([]byte("original"))}
	if err := w.WriteMarkdown(projection); err != nil {
		t.Fatalf("unchanged content was replaced: %v", err)
	}
	projection.DiskHash = Hash([]byte("stale"))
	if err := w.WriteMarkdown(projection); !errors.Is(err, ErrChanged) {
		t.Fatalf("external-change check bypassed: %v", err)
	}
}
