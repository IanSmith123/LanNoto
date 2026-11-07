package room

import (
	"bytes"
	"errors"
	"strconv"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/reearth/ygo/crdt"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
	"lannoto/internal/storage"
)

const HistoryInterval = time.Minute
const HistoryBlockDelay = 2 * time.Second

func (r *Room) ensureHistory() error {
	if r.history != nil {
		return nil
	}
	entry, err := r.workspace.SaveHistory(r.state.Filename, r.state.Markdown, r.state.MarkdownRevision, "initial", "", time.Now())
	if err != nil {
		return err
	}
	r.history = &entry
	return nil
}
func (r *Room) recordHistory(reason, author string, now time.Time) (storage.HistoryEntry, error) {
	if err := r.ensureHistory(); err != nil {
		return storage.HistoryEntry{}, err
	}
	entry, err := r.workspace.SaveHistory(r.state.Filename, r.state.Markdown, r.state.MarkdownRevision, reason, author, now)
	if err == nil {
		r.history = &entry
		r.historyPendingSince = time.Time{}
		r.historyDirty = false
	}
	return entry, err
}
func (r *Room) projectCurrent() error {
	if !r.state.Initialized {
		return invalid("not_initialized", "文档尚未初始化")
	}
	if r.state.MarkdownRevision == r.state.Revision {
		return nil
	}
	markdown, err := storage.MarkdownText(r.state.CRDT)
	if err != nil {
		return err
	}
	next := r.state
	next.Markdown = markdown
	next.MarkdownRevision = next.Revision
	return r.commitProjection(next)
}
func (r *Room) Checkpoint(revision uint64, author string) (storage.HistoryVersion, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.check(); err != nil {
		return storage.HistoryVersion{}, err
	}
	if r.closing || revision > r.state.Revision {
		return storage.HistoryVersion{}, invalid("revision_conflict", "文档已变化，请重新保存")
	}
	if err := r.ensureHistory(); err != nil {
		return storage.HistoryVersion{}, err
	}
	if err := r.projectCurrent(); err != nil {
		return storage.HistoryVersion{}, err
	}
	entry, err := r.recordHistory("manual", author, time.Now())
	if err == nil {
		r.broadcast(Message{Type: "saved", Revision: r.state.Revision})
	}
	return entry.HistoryVersion, err
}
func (r *Room) History(before string) (storage.HistoryPage, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.check(); err != nil {
		return storage.HistoryPage{}, err
	}
	if err := r.ensureHistory(); err != nil {
		return storage.HistoryPage{}, err
	}
	return r.workspace.History(r.state.Filename, before)
}
func (r *Room) HistoryEntry(id string) (storage.HistoryEntry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.check(); err != nil {
		return storage.HistoryEntry{}, err
	}
	return r.workspace.HistoryEntry(r.state.Filename, id)
}
func (r *Room) Restore(id string, revision uint64, author string) (ExportSnapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.check(); err != nil {
		return ExportSnapshot{}, err
	}
	if r.closing || !r.state.Initialized || revision != r.state.Revision {
		return ExportSnapshot{}, invalid("revision_conflict", "文档已变化，请刷新历史比较后重试")
	}
	target, err := r.workspace.HistoryEntry(r.state.Filename, id)
	if err != nil {
		return ExportSnapshot{}, err
	}
	if err := r.projectCurrent(); err != nil {
		return ExportSnapshot{}, err
	}
	if _, err := r.recordHistory("restore-before", author, time.Now()); err != nil {
		return ExportSnapshot{}, err
	}
	if target.Markdown == r.state.Markdown {
		return ExportSnapshot{r.state.Filename, r.state.Revision, r.state.Markdown}, nil
	}
	doc := crdt.New(crdt.WithGC(false))
	defer doc.Destroy()
	if err := crdt.ApplyUpdateV1(doc, r.state.CRDT, nil); err != nil {
		return ExportSnapshot{}, err
	}
	vector, err := crdt.DecodeStateVectorV1(crdt.EncodeStateVectorV1(doc))
	if err != nil {
		return ExportSnapshot{}, err
	}
	content := doc.GetText("markdown")
	oldRunes, newRunes := []rune(r.state.Markdown), []rune(target.Markdown)
	prefix := 0
	for prefix < len(oldRunes) && prefix < len(newRunes) && oldRunes[prefix] == newRunes[prefix] {
		prefix++
	}
	oldEnd, newEnd := len(oldRunes), len(newRunes)
	for oldEnd > prefix && newEnd > prefix && oldRunes[oldEnd-1] == newRunes[newEnd-1] {
		oldEnd--
		newEnd--
	}
	position, removed := 0, 0
	for _, point := range oldRunes[:prefix] {
		position += utf16.RuneLen(point)
	}
	for _, point := range oldRunes[prefix:oldEnd] {
		removed += utf16.RuneLen(point)
	}
	inserted := string(newRunes[prefix:newEnd])
	doc.Transact(func(txn *crdt.Transaction) {
		if removed > 0 {
			content.Delete(txn, position, removed)
		}
		if inserted != "" {
			content.Insert(txn, position, inserted, nil)
		}
	})
	delta := crdt.EncodeStateAsUpdateV1(doc, vector)
	encoded, err := candidate(r.state.CRDT, delta)
	if err != nil {
		return ExportSnapshot{}, err
	}
	next := r.state
	next.Revision++
	if next.Revision > 9007199254740991 {
		return ExportSnapshot{}, errors.New("revision exhausted")
	}
	next.CRDT = encoded
	next.Markdown = target.Markdown
	next.MarkdownRevision = next.Revision
	if err := r.commitProjection(next); err != nil {
		return ExportSnapshot{}, err
	}
	if _, err := r.recordHistory("restore", author, time.Now()); err != nil {
		return ExportSnapshot{}, err
	}
	r.broadcast(Message{Type: "update", PeerID: "history", Data: delta, Revision: next.Revision, MessageID: "restore-" + id, Restored: true})
	r.broadcast(Message{Type: "saved", Revision: next.Revision})
	return ExportSnapshot{next.Filename, next.Revision, next.Markdown}, nil
}

// A large block's content or structure changed, or a single edit replaced at
// least 500 characters. Parsing is only for checkpoint decisions, never saving.
func largeChange(previous, current string) bool {
	a, b := []rune(previous), []rune(current)
	start := 0
	for start < len(a) && start < len(b) && a[start] == b[start] {
		start++
	}
	endA, endB := len(a), len(b)
	for endA > start && endB > start && a[endA-1] == b[endB-1] {
		endA--
		endB--
	}
	if endA-start >= 500 || endB-start >= 500 {
		return true
	}
	old, new := documentBlocks(previous), documentBlocks(current)
	prefix := 0
	for prefix < len(old) && prefix < len(new) && old[prefix].hash == new[prefix].hash {
		prefix++
	}
	endOld, endNew := len(old), len(new)
	for endOld > prefix && endNew > prefix && old[endOld-1].hash == new[endNew-1].hash {
		endOld--
		endNew--
	}
	for _, block := range append(old[prefix:endOld], new[prefix:endNew]...) {
		if block.size >= 200 {
			return true
		}
	}
	return false
}

type documentBlock struct {
	hash string
	size int
}

func documentBlocks(markdown string) []documentBlock {
	source := []byte(markdown)
	parser := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser()
	doc := parser.Parse(text.NewReader(source))
	result := []documentBlock{}
	for block := doc.FirstChild(); block != nil; block = block.NextSibling() {
		var raw bytes.Buffer
		raw.WriteString(block.Kind().String())
		walkErr := ast.Walk(block, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
			if !entering || n.Type() != ast.TypeBlock {
				return ast.WalkContinue, nil
			}
			raw.WriteString(n.Kind().String())
			if heading, ok := n.(*ast.Heading); ok {
				raw.WriteString(strconv.Itoa(heading.Level))
			}
			if code, ok := n.(*ast.FencedCodeBlock); ok {
				raw.Write(code.Language(source))
			}
			for i := 0; i < n.Lines().Len(); i++ {
				segment := n.Lines().At(i)
				raw.Write(segment.Value(source))
			}
			return ast.WalkContinue, nil
		})
		if walkErr != nil {
			panic(walkErr)
		}
		result = append(result, documentBlock{storage.Hash(raw.Bytes()), utf8.RuneCount(raw.Bytes())})
	}
	return result
}
func (r *Room) checkpointDue(now time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped != nil || r.closing || !r.state.Initialized {
		return nil
	}
	if r.history != nil && !r.historyDirty {
		return nil
	}
	if err := r.check(); err != nil {
		var input *InputError
		if errors.As(err, &input) {
			return nil
		}
		return err
	}
	if err := r.ensureHistory(); err != nil {
		return err
	}
	markdown, err := storage.MarkdownText(r.state.CRDT)
	if err != nil {
		return err
	}
	if r.history.Hash == storage.Hash([]byte(markdown)) {
		r.historyDirty = false
		return nil
	}
	reason := ""
	if now.Sub(r.history.CreatedAt) >= HistoryInterval {
		reason = "interval"
	}
	if reason == "" && !r.historyPendingSince.IsZero() && now.Sub(r.historyPendingSince) >= HistoryBlockDelay && largeChange(r.history.Markdown, markdown) {
		reason = "block"
	}
	if reason == "" {
		return nil
	}
	if err := r.projectCurrent(); err != nil {
		return err
	}
	if _, err := r.recordHistory(reason, r.lastAuthor, now); err != nil {
		return err
	}
	r.broadcast(Message{Type: "saved", Revision: r.state.Revision})
	return nil
}
func (m *Manager) CheckpointDue(now time.Time) error {
	m.mu.Lock()
	rooms := make([]*Room, 0, len(m.rooms))
	for _, room := range m.rooms {
		rooms = append(rooms, room)
	}
	m.mu.Unlock()
	for _, room := range rooms {
		if err := room.checkpointDue(now); err != nil {
			return err
		}
	}
	return nil
}
func (m *Manager) ArchiveMarkdown() (map[string]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	snapshots := make(map[string]string, len(m.rooms))
	names, err := m.workspace.List()
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		room, exists := m.rooms[name]
		if !exists {
			continue
		}
		room.mu.Lock()
		if err := room.check(); err != nil {
			room.mu.Unlock()
			var input *InputError
			if errors.As(err, &input) {
				continue
			}
			return nil, err
		}
		markdown := room.state.Markdown
		if room.state.Initialized {
			var err error
			markdown, err = storage.MarkdownText(room.state.CRDT)
			if err != nil {
				room.mu.Unlock()
				return nil, err
			}
		}
		snapshots[name] = markdown
		room.mu.Unlock()
	}
	return snapshots, nil
}
