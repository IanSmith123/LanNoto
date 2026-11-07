package storage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/gofrs/flock"
	"github.com/reearth/ygo/crdt"
)

const (
	MaxMarkdown = 1 << 20
	MaxAsset    = 50 << 20
	MaxCRDT     = 16 << 20
	MaxFrame    = 24 << 20
	MaxPeers    = 16
)

var ErrName = errors.New("invalid filename")
var ErrIO = errors.New("storage I/O failure")
var ErrMarkdown = errors.New("Markdown must be valid UTF-8 and at most 1 MiB")
var ErrChanged = errors.New("file_changed")

type Snapshot struct {
	Format           string `json:"format,omitempty"`
	Filename         string `json:"filename"`
	Initialized      bool   `json:"initialized"`
	Revision         uint64 `json:"revision"`
	CRDT             []byte `json:"crdt"`
	MarkdownRevision uint64 `json:"markdownRevision"`
	Markdown         string `json:"markdown"`
	DiskHash         string `json:"diskHash"`
}

const MarkdownFormat = "markdown-v1"

// MarkdownText is the only document content in the current collaboration format.
func MarkdownText(data []byte) (string, error) {
	doc := crdt.New(crdt.WithGC(false))
	defer doc.Destroy()
	if err := crdt.ApplyUpdateV1(doc, data, nil); err != nil {
		return "", err
	}
	format, ok := doc.GetMap("lannoto").Get("format")
	if !ok || format != MarkdownFormat {
		return "", errors.New("missing Markdown format marker")
	}
	pending := doc.PendingStats()
	if pending.Items != 0 || pending.DeleteRanges != 0 {
		return "", errors.New("incomplete Markdown CRDT")
	}
	text := doc.GetText("markdown").ToString()
	if len(text) > MaxMarkdown || !utf8.ValidString(text) {
		return "", ErrMarkdown
	}
	return text, nil
}

type Workspace struct {
	Notes       string
	State       string
	Static      string
	Temp        string
	HistoryDir  string
	lock        *flock.Flock
	notesRoot   *os.Root
	stateRoot   *os.Root
	staticRoot  *os.Root
	historyRoot *os.Root
	notesMu     sync.RWMutex
	historyMu   sync.Mutex
	keysMu      sync.RWMutex
	keys        map[string]string
}

func ValidName(name string, markdown bool) error {
	if name == "" || name == "." || name == ".." || !utf8.ValidString(name) || strings.ContainsAny(name, "/\\\x00") {
		return ErrName
	}
	if markdown && !strings.HasSuffix(name, ".md") {
		return fmt.Errorf("%w: expected .md extension", ErrName)
	}
	if runtime.GOOS == "windows" {
		if strings.ContainsAny(name, "<>:\"|?*") || strings.TrimRight(name, " .") != name {
			return ErrName
		}
		for _, r := range name {
			if r < 32 {
				return ErrName
			}
		}
		base := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CONIN$" || base == "CONOUT$" {
			return ErrName
		}
		if strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT") {
			suffix := strings.TrimPrefix(strings.TrimPrefix(base, "COM"), "LPT")
			if utf8.RuneCountInString(suffix) == 1 && strings.ContainsAny(suffix, "123456789¹²³") {
				return ErrName
			}
		}
	}
	return nil
}

func Hash(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }

func ensureDir(path string) error {
	if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("expected real directory: %s", path)
	}
	return nil
}

func Open(cwd string) (*Workspace, error) {
	w := &Workspace{Notes: filepath.Join(cwd, "note"), State: filepath.Join(cwd, ".lannoto", "state"), Static: filepath.Join(cwd, "note", "static"), Temp: filepath.Join(cwd, ".lannoto", "tmp"), HistoryDir: filepath.Join(cwd, ".lannoto", "history")}
	for _, dir := range []string{filepath.Join(cwd, ".lannoto"), w.Notes, w.Static, w.State, w.Temp, w.HistoryDir} {
		if err := ensureDir(dir); err != nil {
			return nil, fmt.Errorf("prepare workspace: %w", err)
		}
	}
	w.lock = flock.New(filepath.Join(cwd, ".lannoto", "workspace.lock"))
	locked, err := w.lock.TryLock()
	if err != nil {
		return nil, fmt.Errorf("lock workspace: %w", err)
	}
	if !locked {
		return nil, errors.New("workspace is already in use by another process")
	}
	w.notesRoot, err = os.OpenRoot(w.Notes)
	if err != nil {
		return nil, errors.Join(err, w.lock.Close())
	}
	w.stateRoot, err = os.OpenRoot(w.State)
	if err != nil {
		return nil, errors.Join(err, w.notesRoot.Close(), w.lock.Close())
	}
	w.staticRoot, err = os.OpenRoot(w.Static)
	if err != nil {
		return nil, errors.Join(err, w.stateRoot.Close(), w.notesRoot.Close(), w.lock.Close())
	}
	w.historyRoot, err = os.OpenRoot(w.HistoryDir)
	if err != nil {
		return nil, errors.Join(err, w.staticRoot.Close(), w.stateRoot.Close(), w.notesRoot.Close(), w.lock.Close())
	}
	for _, directory := range []string{w.Notes, w.Static, w.State, w.Temp} {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return nil, errors.Join(fmt.Errorf("inspect temporary files: %w", err), w.Close())
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".lannoto-write-") || strings.HasPrefix(entry.Name(), ".lannoto-create-") || (directory == w.Temp && strings.HasPrefix(entry.Name(), "docx-")) {
				slog.Warn("ignoring leftover temporary file", "path", filepath.Join(directory, entry.Name()))
			}
		}
	}
	if err := w.loadPaths(); err != nil {
		return nil, errors.Join(err, w.Close())
	}
	return w, nil
}

func (w *Workspace) Close() error {
	return errors.Join(w.notesRoot.Close(), w.stateRoot.Close(), w.staticRoot.Close(), w.historyRoot.Close(), w.lock.Close())
}

func (w *Workspace) List() ([]string, error) {
	entries, err := w.Tree()
	if err != nil {
		return nil, err
	}
	names := make([]string, 0)
	for _, entry := range entries {
		if !entry.Folder && !entry.Asset {
			names = append(names, entry.Path)
		}
	}
	return names, nil
}

func readRegular(root *os.Root, name string, limit int64) ([]byte, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: not a regular file", ErrName)
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(f, limit+1))
	if err := errors.Join(readErr, f.Close()); err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%w: file exceeds size limit", ErrName)
	}
	return data, nil
}

func (w *Workspace) ReadNote(name string) ([]byte, error) {
	w.notesMu.RLock()
	defer w.notesMu.RUnlock()
	return w.readNote(name)
}

func (w *Workspace) readNote(name string) ([]byte, error) {
	if err := ValidNotePath(name); err != nil {
		return nil, err
	}
	if err := w.checkFolder(path.Dir(name)); err != nil {
		return nil, err
	}
	if _, err := w.exactEntry(name); err != nil {
		return nil, err
	}
	data, err := readRegular(w.notesRoot, name, MaxMarkdown)
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("%w: Markdown must be UTF-8", ErrName)
	}
	return data, nil
}

func (w *Workspace) Check(s Snapshot) error {
	data, err := w.ReadNote(s.Filename)
	if err != nil {
		return err
	}
	if Hash(data) != s.DiskHash {
		return ErrChanged
	}
	return nil
}

// AtomicWrite checks each I/O operation itself; only ReplaceFile comes from
// the cross-platform library (Windows uses MoveFileEx with WRITE_THROUGH).
func AtomicWrite(path string, data []byte) (result error) {
	defer func() {
		if result != nil {
			result = errors.Join(ErrIO, result)
		}
	}()
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".lannoto-write-*")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}
	tmp := f.Name()
	closed := false
	defer func() {
		if !closed {
			result = errors.Join(result, f.Close())
		}
		if err := os.Remove(tmp); err != nil && !errors.Is(err, os.ErrNotExist) {
			result = errors.Join(result, err)
		}
	}()
	err = atomicCheckpoint("before-write", path)
	if err == nil {
		_, err = f.Write(data)
	}
	if err != nil {
		return fmt.Errorf("write temporary file: %w", err)
	}
	err = atomicCheckpoint("before-sync", path)
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		return fmt.Errorf("sync temporary file: %w", err)
	}
	err = f.Close()
	closed = true
	if err != nil {
		return fmt.Errorf("close temporary file: %w", err)
	}
	if err = replaceFile(tmp, path); err != nil {
		return fmt.Errorf("replace %q: %w", filepath.Base(path), err)
	}
	if err := syncDir(dir); err != nil {
		return err
	}
	return atomicCheckpoint("after-replace", path)
}

func (w *Workspace) Save(s Snapshot) error {
	if err := ValidNotePath(s.Filename); err != nil {
		return err
	}
	filename := s.Filename
	s.Filename = w.metadataKey(filename)
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if err = AtomicWrite(filepath.Join(w.State, snapshotFile(s.Filename)), data); err != nil {
		return fmt.Errorf("snapshot %q revision %d: %w", filename, s.Revision, err)
	}
	return nil
}

func (w *Workspace) WriteMarkdown(s Snapshot) error {
	// Windows note readers do not share delete access. Finish our own reads
	// before replacing the file, without retrying or suppressing I/O errors.
	w.notesMu.Lock()
	defer w.notesMu.Unlock()
	data, err := w.readNote(s.Filename)
	if err != nil {
		return err
	}
	if Hash(data) != s.DiskHash {
		return ErrChanged
	}
	// Initialization and CRDT-only revisions can leave the source unchanged.
	// The checked disk contents already satisfy this projection; replacing the
	// same bytes needlessly competes with Windows readers and file scanners.
	if bytes.Equal(data, []byte(s.Markdown)) {
		return nil
	}
	return AtomicWrite(filepath.Join(w.Notes, s.Filename), []byte(s.Markdown))
}

func validate(s Snapshot, name string) error {
	if (s.Initialized && s.Format != MarkdownFormat) || (!s.Initialized && s.Format != "") {
		return errors.New("unknown document format")
	}
	if s.Filename != name || s.MarkdownRevision > s.Revision || s.Revision > 9007199254740991 || len(s.Markdown) > MaxMarkdown || !utf8.ValidString(s.Markdown) || len(s.CRDT) > MaxCRDT {
		return errors.New("invalid snapshot fields")
	}
	hash, err := hex.DecodeString(s.DiskHash)
	if err != nil || len(hash) != sha256.Size {
		return errors.New("invalid disk hash")
	}
	if !s.Initialized {
		if len(s.CRDT) != 0 || s.Revision != 0 || s.MarkdownRevision != 0 {
			return errors.New("invalid uninitialized snapshot")
		}
	} else {
		if s.Revision == 0 || len(s.CRDT) == 0 {
			return errors.New("missing initialized CRDT")
		}
		text, err := MarkdownText(s.CRDT)
		if err != nil {
			return err
		}
		if s.MarkdownRevision == s.Revision && s.Markdown != text {
			return errors.New("Markdown snapshot differs from authoritative text")
		}
	}
	return nil
}

func (w *Workspace) Load(name string) (Snapshot, error) {
	disk, err := w.ReadNote(name)
	if err != nil {
		return Snapshot{}, err
	}
	fresh := Snapshot{Filename: name, Markdown: string(disk), DiskHash: Hash(disk)}
	key := w.metadataKey(name)
	data, err := readRegular(w.stateRoot, snapshotFile(key), 32<<20)
	if errors.Is(err, os.ErrNotExist) {
		return fresh, nil
	}
	if err != nil {
		return Snapshot{}, err
	}
	var s Snapshot
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&s); err != nil {
		return Snapshot{}, fmt.Errorf("snapshot %q: %w", name, err)
	}
	if err := decoder.Decode(new(interface{})); !errors.Is(err, io.EOF) {
		return Snapshot{}, fmt.Errorf("snapshot %q: trailing content", name)
	}
	if err := validate(s, key); err != nil {
		return Snapshot{}, fmt.Errorf("snapshot %q: %w", name, err)
	}
	s.Filename = name
	current := Hash(disk)
	if s.MarkdownRevision < s.Revision && current == s.DiskHash {
		s.Markdown, err = MarkdownText(s.CRDT)
		if err != nil {
			return Snapshot{}, err
		}
		s.MarkdownRevision = s.Revision
		if err := w.Save(s); err != nil {
			return Snapshot{}, err
		}
	}
	projected := Hash([]byte(s.Markdown))
	switch {
	case current == s.DiskHash:
		if current != projected {
			if err := w.WriteMarkdown(s); err != nil {
				return Snapshot{}, err
			}
			s.DiskHash = projected
			if err := w.Save(s); err != nil {
				return Snapshot{}, err
			}
		}
	case current == projected:
		s.DiskHash = current
		if err := w.Save(s); err != nil {
			return Snapshot{}, err
		}
	default:
		slog.Info("external Markdown change; start a new room", "filename", name)
		if err := w.Save(fresh); err != nil {
			return Snapshot{}, err
		}
		return fresh, nil
	}
	return s, nil
}

// CreateExclusive publishes a complete synced file without overwriting a
// concurrent creator. A same-directory hard link is atomic and exclusive.
func CreateExclusive(path string, data []byte) (result error) {
	conflict := false
	defer func() {
		if result != nil && !conflict {
			result = errors.Join(ErrIO, result)
		}
	}()
	f, err := os.CreateTemp(filepath.Dir(path), ".lannoto-create-*")
	if err != nil {
		return err
	}
	closed := false
	tmp := f.Name()
	defer func() {
		if !closed {
			if err := f.Close(); err != nil {
				conflict = false
				result = errors.Join(result, err)
			}
		}
		if err := os.Remove(tmp); err != nil {
			conflict = false
			result = errors.Join(result, err)
		}
	}()
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	err = f.Close()
	closed = true
	if err != nil {
		return err
	}
	if err = os.Link(tmp, path); err != nil {
		conflict = errors.Is(err, os.ErrExist)
		return err
	}
	return syncDir(filepath.Dir(path))
}

func (w *Workspace) Create(name, markdown string) error {
	if err := ValidNotePath(name); err != nil {
		return err
	}
	if len(markdown) > MaxMarkdown || !utf8.ValidString(markdown) {
		return ErrMarkdown
	}
	w.notesMu.Lock()
	defer w.notesMu.Unlock()
	if err := w.checkFolder(path.Dir(name)); err != nil {
		return err
	}
	filename := filepath.Join(w.Notes, name)
	if _, err := w.notesRoot.Lstat(name); err == nil {
		return os.ErrExist
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// The actual filesystem also validates the derived snapshot name before
	// any persistence operation, without inventing a universal Unicode cap.
	if _, err := w.stateRoot.Lstat(snapshotFile(name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := w.prepareNewKey(name); err != nil {
		return err
	}
	// Reset an orphan snapshot before publishing the explicit new file. A
	// crash cannot attach the old document's CRDT to a newly created note.
	if err := w.Save(Snapshot{Filename: name, Markdown: markdown, DiskHash: Hash([]byte(markdown))}); err != nil {
		return err
	}
	return CreateExclusive(filename, []byte(markdown))
}
