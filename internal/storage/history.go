package storage

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type HistoryVersion struct {
	ID        string    `json:"id"`
	Filename  string    `json:"filename"`
	CreatedAt time.Time `json:"createdAt"`
	Revision  uint64    `json:"revision"`
	Reason    string    `json:"reason"`
	Author    string    `json:"author"`
	Bytes     int       `json:"bytes"`
	Hash      string    `json:"hash"`
}
type HistoryEntry struct {
	HistoryVersion
	Markdown string `json:"markdown"`
}
type HistoryPage struct {
	Items []HistoryVersion `json:"items"`
	Next  string           `json:"next"`
}

var historyID = regexp.MustCompile(`^[0-9]{20}-[A-Za-z0-9_-]{26,64}$`)

func (w *Workspace) historyDirectory(identity string, create bool) (*os.Root, error) {
	key := Hash([]byte(identity))
	if create {
		if err := ensureDir(filepath.Join(w.HistoryDir, key)); err != nil {
			return nil, err
		}
	}
	info, err := w.historyRoot.Lstat(key)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("invalid history directory")
	}
	return w.historyRoot.OpenRoot(key)
}
func historyFiles(root *os.Root) ([]string, error) {
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".lannoto-") {
			continue
		}
		id, found := strings.CutSuffix(entry.Name(), ".json.gz")
		if !found || !historyID.MatchString(id) || entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
			return nil, fmt.Errorf("invalid history file %q", entry.Name())
		}
		names = append(names, id)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	return names, nil
}
func readHistory(root *os.Root, name, id string) (HistoryEntry, error) {
	if !historyID.MatchString(id) {
		return HistoryEntry{}, ErrName
	}
	compressed, err := readRegular(root, id+".json.gz", 7*MaxMarkdown)
	if err != nil {
		return HistoryEntry{}, err
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return HistoryEntry{}, err
	}
	raw, readErr := io.ReadAll(io.LimitReader(reader, 7*MaxMarkdown+1))
	if err := errors.Join(readErr, reader.Close()); err != nil {
		return HistoryEntry{}, err
	}
	if len(raw) > 7*MaxMarkdown || !utf8.Valid(raw) {
		return HistoryEntry{}, errors.New("invalid history size or encoding")
	}
	var entry HistoryEntry
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&entry); err != nil {
		return entry, err
	}
	if err := decoder.Decode(new(interface{})); !errors.Is(err, io.EOF) {
		return entry, errors.New("trailing history content")
	}
	if entry.ID != id || entry.Filename != name || len(entry.Markdown) > MaxMarkdown || !utf8.ValidString(entry.Markdown) || entry.Hash != Hash([]byte(entry.Markdown)) || entry.Bytes != len(entry.Markdown) || entry.CreatedAt.IsZero() || entry.Revision > 9007199254740991 || len(entry.Author) > 80 || !utf8.ValidString(entry.Author) {
		return entry, errors.New("corrupt history entry")
	}
	return entry, nil
}

func (w *Workspace) History(name, before string) (page HistoryPage, resultErr error) {
	w.historyMu.Lock()
	defer w.historyMu.Unlock()
	page.Items = []HistoryVersion{}
	if ValidNotePath(name) != nil || before != "" && !historyID.MatchString(before) {
		return page, ErrName
	}
	key := w.metadataKey(name)
	root, err := w.historyDirectory(key, false)
	if errors.Is(err, os.ErrNotExist) {
		return page, nil
	}
	if err != nil {
		return page, err
	}
	defer func() { resultErr = errors.Join(resultErr, root.Close()) }()
	names, err := historyFiles(root)
	if err != nil {
		return page, err
	}
	for _, id := range names {
		if before != "" && id >= before {
			continue
		}
		if len(page.Items) == 50 {
			page.Next = page.Items[len(page.Items)-1].ID
			break
		}
		entry, err := readHistory(root, key, id)
		if err != nil {
			return page, err
		}
		entry.Filename = name
		page.Items = append(page.Items, entry.HistoryVersion)
	}
	return page, nil
}
func (w *Workspace) HistoryEntry(name, id string) (entry HistoryEntry, resultErr error) {
	w.historyMu.Lock()
	defer w.historyMu.Unlock()
	if ValidNotePath(name) != nil || !historyID.MatchString(id) {
		return entry, ErrName
	}
	key := w.metadataKey(name)
	root, err := w.historyDirectory(key, false)
	if err != nil {
		return entry, err
	}
	defer func() { resultErr = errors.Join(resultErr, root.Close()) }()
	entry, err = readHistory(root, key, id)
	if err == nil {
		entry.Filename = name
	}
	return entry, err
}
func (w *Workspace) SaveHistory(name, markdown string, revision uint64, reason, author string, now time.Time) (entry HistoryEntry, resultErr error) {
	w.historyMu.Lock()
	defer w.historyMu.Unlock()
	if err := ValidNotePath(name); err != nil {
		return entry, err
	}
	key := w.metadataKey(name)
	if len(markdown) > MaxMarkdown || !utf8.ValidString(markdown) {
		return entry, ErrMarkdown
	}
	if len(author) > 80 || !utf8.ValidString(author) || revision > 9007199254740991 {
		return entry, errors.New("invalid history metadata")
	}
	root, err := w.historyDirectory(key, true)
	if err != nil {
		return entry, errors.Join(ErrIO, err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, root.Close())
		if resultErr != nil {
			resultErr = errors.Join(ErrIO, resultErr)
		}
	}()
	names, err := historyFiles(root)
	if err != nil {
		return entry, err
	}
	sequence := uint64(1)
	if len(names) > 0 {
		previous, err := readHistory(root, key, names[0])
		if err != nil {
			return entry, err
		}
		if previous.Hash == Hash([]byte(markdown)) {
			previous.Filename = name
			return previous, nil
		}
		last, err := strconv.ParseUint(names[0][:20], 10, 64)
		if err != nil || last == ^uint64(0) {
			return entry, errors.New("history sequence exhausted")
		}
		sequence = last + 1
	}
	id := fmt.Sprintf("%020d-%s", sequence, rand.Text())
	entry = HistoryEntry{HistoryVersion: HistoryVersion{ID: id, Filename: key, CreatedAt: now.UTC(), Revision: revision, Reason: reason, Author: author, Bytes: len(markdown), Hash: Hash([]byte(markdown))}, Markdown: markdown}
	raw, err := json.Marshal(entry)
	if err != nil {
		return entry, err
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(raw); err != nil {
		return entry, errors.Join(err, writer.Close())
	}
	if err := writer.Close(); err != nil {
		return entry, err
	}
	entry.Filename = name
	return entry, CreateExclusive(filepath.Join(w.HistoryDir, Hash([]byte(key)), id+".json.gz"), compressed.Bytes())
}
