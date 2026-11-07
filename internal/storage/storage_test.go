package storage

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"

	"github.com/reearth/ygo/crdt"
)

func TestConcurrentPageReadsDoNotBlockAtomicProjection(t *testing.T) {
	w := workspace(t)
	initial := "版本初始" + strings.Repeat("正文", 1024) + "完整结尾"
	if err := w.Create("并发读取.md", initial); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	readErrors := make(chan error, 8)
	var readers sync.WaitGroup
	for index := 0; index < 8; index++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				data, err := w.ReadNote("并发读取.md")
				if err != nil {
					readErrors <- err
					return
				}
				if !strings.HasPrefix(string(data), "版本") || !strings.HasSuffix(string(data), "完整结尾") {
					readErrors <- fmt.Errorf("partial note read: %q", data)
					return
				}
			}
		}()
	}
	current := initial
	var writeError error
	for index := 0; index < 100; index++ {
		next := fmt.Sprintf("版本%d", index) + strings.Repeat("正文", 1024) + "完整结尾"
		writeError = w.WriteMarkdown(Snapshot{Filename: "并发读取.md", Markdown: next, DiskHash: Hash([]byte(current))})
		if writeError != nil {
			break
		}
		current = next
	}
	close(stop)
	readers.Wait()
	close(readErrors)
	for err := range readErrors {
		t.Error(err)
	}
	if writeError != nil {
		t.Fatalf("own page readers blocked projection: %v", writeError)
	}
}

func workspace(t *testing.T) *Workspace {
	t.Helper()
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := w.Close(); err != nil {
			t.Error(err)
		}
	})
	return w
}

func TestRejectedNativeFilenameDoesNotPublishNoteOrSnapshot(t *testing.T) {
	w := workspace(t)
	err := w.Create(strings.Repeat("a", 300)+".md", "正文")
	if err == nil {
		t.Fatal("filesystem unexpectedly accepted the oversized component")
	}
	var native syscall.Errno
	if errors.As(err, &native) {
		t.Logf("native filename rejection: %d %v", native, err)
	}
	notes, listErr := w.List()
	if listErr != nil || len(notes) != 0 {
		t.Fatalf("rejected name published a note: %v %v", notes, listErr)
	}
	states, readErr := os.ReadDir(w.State)
	if readErr != nil || len(states) != 0 {
		t.Fatalf("rejected name published a snapshot: %v %v", states, readErr)
	}
}

func TestMarkdownUTF8LimitIsInclusiveAndRejectsBeforePublication(t *testing.T) {
	w := workspace(t)
	text := strings.Repeat("界", MaxMarkdown/3) + "\n"
	if len(text) != MaxMarkdown {
		t.Fatal("fixture must be exactly the UTF-8 byte limit")
	}
	if err := w.Create("limit.md", text); err != nil {
		t.Fatal(err)
	}
	stored, err := w.ReadNote("limit.md")
	if err != nil || string(stored) != text {
		t.Fatalf("exact limit was not preserved: %v", err)
	}
	for _, invalid := range []struct{ name, text string }{{"too-big.md", text + "x"}, {"bad-utf8.md", "\xff"}} {
		if err := w.Create(invalid.name, invalid.text); !errors.Is(err, ErrMarkdown) {
			t.Fatalf("invalid Markdown accepted: %s %v", invalid.name, err)
		}
		if _, err := os.Stat(filepath.Join(w.Notes, invalid.name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("rejected note was published")
		}
		if _, err := os.Stat(filepath.Join(w.State, invalid.name+".json")); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("rejected snapshot was published")
		}
	}
}

func state(t *testing.T, w *Workspace) Snapshot {
	t.Helper()
	if err := w.Create("会议纪要.md", "原正文"); err != nil {
		t.Fatal(err)
	}
	doc := crdt.New(crdt.WithGC(false))
	defer doc.Destroy()
	meta, text := doc.GetMap("lannoto"), doc.GetText("markdown")
	doc.Transact(func(txn *crdt.Transaction) {
		meta.Set(txn, "format", MarkdownFormat)
		text.Insert(txn, 0, "新正文😀", nil)
	})
	s := Snapshot{Format: MarkdownFormat, Filename: "会议纪要.md", Initialized: true, Revision: 2, CRDT: crdt.EncodeStateAsUpdateV1(doc, nil), MarkdownRevision: 2, Markdown: "新正文😀", DiskHash: Hash([]byte("原正文"))}
	return s
}

func TestRecoveryFinishesBothInterruptedProjectionSteps(t *testing.T) {
	for _, replaced := range []bool{false, true} {
		t.Run(map[bool]string{false: "snapshot_committed", true: "markdown_replaced"}[replaced], func(t *testing.T) {
			w := workspace(t)
			s := state(t, w)
			if err := w.Save(s); err != nil {
				t.Fatal(err)
			}
			if replaced {
				if err := w.WriteMarkdown(s); err != nil {
					t.Fatal(err)
				}
			}
			recovered, err := w.Load(s.Filename)
			if err != nil {
				t.Fatal(err)
			}
			data, err := w.ReadNote(s.Filename)
			if err != nil {
				t.Fatal(err)
			}
			if string(data) != s.Markdown || recovered.DiskHash != Hash(data) || recovered.Revision != s.Revision {
				t.Fatalf("incomplete recovery: %+v %q", recovered, data)
			}
		})
	}
}

func TestExternalEditAndRenameNeverReplayOldState(t *testing.T) {
	w := workspace(t)
	s := state(t, w)
	if err := w.Save(s); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(w.Notes, s.Filename)
	if err := os.WriteFile(path, []byte("用户外部修改"), 0600); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(w.Check(s), ErrChanged) {
		t.Fatal("external edit was not detected")
	}
	fresh, err := w.Load(s.Filename)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Initialized || fresh.Markdown != "用户外部修改" {
		t.Fatalf("replayed old CRDT: %+v", fresh)
	}
	if err := os.Rename(path, filepath.Join(w.Notes, "Project Notes.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Load(s.Filename); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old name revived: %v", err)
	}
	names, err := w.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != "Project Notes.md" {
		t.Fatal(names)
	}
}

func TestWorkspaceLockCorruptionAndExplicitCreate(t *testing.T) {
	w := workspace(t)
	if other, err := Open(filepath.Dir(w.Notes)); err == nil {
		if closeErr := other.Close(); closeErr != nil {
			t.Error(closeErr)
		}
		t.Fatal("second writer acquired workspace")
	}
	s := state(t, w)
	if err := w.Create(s.Filename, "覆盖"); !errors.Is(err, os.ErrExist) {
		t.Fatalf("create overwrote existing note: %v", err)
	}
	if err := os.WriteFile(filepath.Join(w.State, s.Filename+".json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Load(s.Filename); err == nil {
		t.Fatal("corrupt snapshot accepted")
	}
	for _, name := range []string{"../escape.md", "nested/../test.md", "..\\test.md", "", "test.txt"} {
		if err := w.Create(name, ""); !errors.Is(err, ErrName) {
			t.Fatalf("unsafe filename %q: %v", name, err)
		}
	}
}

func TestRecreatedFilenameDoesNotInheritOrphanCRDT(t *testing.T) {
	w := workspace(t)
	s := state(t, w)
	if err := w.Save(s); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(w.Notes, s.Filename)); err != nil {
		t.Fatal(err)
	}
	if err := w.Create(s.Filename, "原正文"); err != nil {
		t.Fatal(err)
	}
	fresh, err := w.Load(s.Filename)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Initialized || fresh.Revision != 0 {
		t.Fatal("new file inherited orphan CRDT")
	}
}
