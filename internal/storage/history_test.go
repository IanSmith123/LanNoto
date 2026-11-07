package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHistorySurvivesRestartDeduplicatesAndDetectsCorruption(t *testing.T) {
	directory := t.TempDir()
	w, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Create("历史.md", "# 原文\r\n\t😀\n"); err != nil {
		t.Fatal(err)
	}
	first, err := w.SaveHistory("历史.md", "# 原文\r\n\t😀\n", 1, "manual", "Tom", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	same, err := w.SaveHistory("历史.md", first.Markdown, 2, "manual", "Tim", time.Now())
	if err != nil || first.ID != same.ID {
		t.Fatal("duplicate version", err)
	}
	second, err := w.SaveHistory("历史.md", "纯删除后的正文", 3, "interval", "Tim", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	w, err = Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := w.Close(); err != nil {
			t.Error(err)
		}
	}()
	page, err := w.History("历史.md", "")
	if err != nil || len(page.Items) != 2 || page.Items[0].ID != second.ID {
		t.Fatal("history did not persist", err)
	}
	entry, err := w.HistoryEntry("历史.md", first.ID)
	if err != nil || entry.Markdown != first.Markdown {
		t.Fatal("history bytes changed", err)
	}
	if _, err := w.HistoryEntry("历史.md", "../../outside"); err == nil {
		t.Fatal("path escaped")
	}
	if err := os.WriteFile(filepath.Join(w.HistoryDir, Hash([]byte("历史.md")), second.ID+".json.gz"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := w.History("历史.md", ""); err == nil {
		t.Fatal("corrupt history ignored")
	}
}
func TestHistoryPaginationDoesNotDropVersions(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := w.Close(); err != nil {
			t.Error(err)
		}
	}()
	for index := 0; index < 52; index++ {
		if _, err := w.SaveHistory("a.md", strings.Repeat("x", index), uint64(index), "manual", "Tom", time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	first, err := w.History("a.md", "")
	if err != nil || len(first.Items) != 50 || first.Next == "" {
		t.Fatal(first, err)
	}
	second, err := w.History("a.md", first.Next)
	if err != nil || len(second.Items) != 2 || second.Next != "" {
		t.Fatal(second, err)
	}
	if first.Items[49].ID <= second.Items[0].ID {
		t.Fatal("pages overlap")
	}
}
