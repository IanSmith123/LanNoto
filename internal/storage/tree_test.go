package storage

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFolderRenameRetainsHistoryAcrossRestart(t *testing.T) {
	cwd := t.TempDir()
	w, err := Open(cwd)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if w != nil {
			_ = w.Close()
		}
	})
	if err := w.CreateFolder("项目"); err != nil {
		t.Fatal(err)
	}
	if err := w.CreateFolder("项目/空文件夹"); err != nil {
		t.Fatal(err)
	}
	if err := w.Create("项目/笔记.md", "原有正文"); err != nil {
		t.Fatal(err)
	}
	entry, err := w.SaveHistory("项目/笔记.md", "历史正文", 1, "manual", "", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got, err := w.Relocate("项目", "归档"); err != nil || got != "归档" {
		t.Fatalf("rename folder = %q, %v", got, err)
	}
	if got, err := w.Relocate("归档/笔记.md", "归档/重命名.md"); err != nil || got != "归档/重命名.md" {
		t.Fatalf("rename note = %q, %v", got, err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	w, err = Open(cwd)
	if err != nil {
		t.Fatal(err)
	}
	state, err := w.Load("归档/重命名.md")
	if err != nil || state.Markdown != "原有正文" {
		t.Fatalf("load renamed note = %+v, %v", state, err)
	}
	saved, err := w.HistoryEntry(state.Filename, entry.ID)
	if err != nil || saved.Filename != state.Filename || saved.Markdown != "历史正文" {
		t.Fatalf("renamed history = %+v, %v", saved, err)
	}
	if _, err := os.Stat(filepath.Join(w.Notes, "归档", "空文件夹")); err != nil {
		t.Fatal(err)
	}
	if err := w.CreateFolder("项目"); err != nil {
		t.Fatal(err)
	}
	if err := w.Create("项目/笔记.md", "全新正文"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.HistoryEntry("项目/笔记.md", entry.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("reused path inherited moved history: %v", err)
	}
}

func TestAttachmentRelocationDoesNotOverwriteOrEnterNoteList(t *testing.T) {
	w := workspace(t)
	if err := w.CreateFolder("archive"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.StoreAsset("attachment.txt", "file", []byte("original"), time.Now()); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(w.Notes, "archive", "attachment.txt")
	if err := os.WriteFile(destination, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Relocate("static/attachment.txt", "archive/attachment.txt"); !errors.Is(err, os.ErrExist) {
		t.Fatalf("move over existing file: %v", err)
	}
	if got, err := os.ReadFile(destination); err != nil || string(got) != "existing" {
		t.Fatalf("destination changed: %q, %v", got, err)
	}
	if err := os.Remove(destination); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Relocate("static/attachment.txt", "archive/attachment.txt"); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(destination); err != nil || string(got) != "original" {
		t.Fatalf("moved content: %q, %v", got, err)
	}
	if names, err := w.List(); err != nil || len(names) != 0 {
		t.Fatalf("attachments in note list: %v, %v", names, err)
	}
}

func TestTreeRejectsInvalidPathsAndRenameConflicts(t *testing.T) {
	w := workspace(t)
	for _, name := range []string{"../outside", "static", "Static/sub", "a//b", "a/../b", "a\\b"} {
		if err := w.CreateFolder(name); !errors.Is(err, ErrName) {
			t.Fatalf("accepted invalid folder %q: %v", name, err)
		}
	}
	for _, name := range []string{"源.md", "目标.md"} {
		if err := w.Create(name, name); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := w.Relocate("源.md", "目标.md"); !errors.Is(err, os.ErrExist) {
		t.Fatalf("rename conflict = %v", err)
	}
	if err := w.CreateFolder("父目录"); err != nil {
		t.Fatal(err)
	}
	if err := w.CreateFolder("父目录/子目录"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Relocate("父目录", "父目录/子目录/父目录"); !errors.Is(err, ErrOwnSubtree) {
		t.Fatalf("move into own descendant = %v", err)
	}
	parent, err := w.notesRoot.Open(".")
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	if err := renameExclusive(parent, parent, "源.md", "目标.md"); !errors.Is(err, os.ErrExist) {
		t.Fatalf("native rename must reject a destination that appears concurrently: %v", err)
	}
	for _, name := range []string{"源.md", "目标.md"} {
		if data, err := w.ReadNote(name); err != nil || string(data) != name {
			t.Fatalf("conflict changed %s: %q, %v", name, data, err)
		}
	}
}

func TestCaseOnlyRenameKeepsHistory(t *testing.T) {
	w := workspace(t)
	if err := w.Create("Case.md", "正文"); err != nil {
		t.Fatal(err)
	}
	original, err := w.SaveHistory("Case.md", "旧版本", 1, "manual", "", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Relocate("Case.md", "case.md"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.ReadNote("Case.md"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old case still resolves: %v", err)
	}
	entry, err := w.HistoryEntry("case.md", original.ID)
	if err != nil || entry.Filename != "case.md" || entry.Markdown != original.Markdown {
		t.Fatalf("renamed history = %+v, %v", entry, err)
	}
}

func TestInterruptedRenameReconcilesIndexWithDisk(t *testing.T) {
	for _, moved := range []bool{false, true} {
		label := "before filesystem rename"
		if moved {
			label = "after filesystem rename"
		}
		t.Run(label, func(t *testing.T) {
			cwd := t.TempDir()
			w, err := Open(cwd)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if w != nil {
					_ = w.Close()
				}
			})
			if err := w.Create("before.md", "原文"); err != nil {
				t.Fatal(err)
			}
			if err := w.CreateFolder("archive"); err != nil {
				t.Fatal(err)
			}
			version, err := w.SaveHistory("before.md", "旧版本", 1, "manual", "", time.Now())
			if err != nil {
				t.Fatal(err)
			}
			intent := &pathRename{From: "before.md", To: "archive/after.md", Keys: map[string]string{
				"archive/after.md": "before.md", "before.md": "\x00unused",
			}}
			if err := w.writePaths(pathIndex{Keys: w.keys, Pending: intent}); err != nil {
				t.Fatal(err)
			}
			name := "before.md"
			if moved {
				if err := w.notesRoot.Rename(intent.From, intent.To); err != nil {
					t.Fatal(err)
				}
				name = intent.To
			}
			if err := w.Close(); err != nil {
				t.Fatal(err)
			}
			w, err = Open(cwd)
			if err != nil {
				t.Fatal(err)
			}
			if entry, err := w.HistoryEntry(name, version.ID); err != nil || entry.Markdown != version.Markdown {
				t.Fatalf("recovered history = %+v, %v", entry, err)
			}
		})
	}
}
