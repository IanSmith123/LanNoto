package room

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
	"lannoto/internal/storage"
)

type InputError struct {
	Code    string
	Message string
}

func (e *InputError) Error() string      { return e.Message }
func invalid(code, message string) error { return &InputError{Code: code, Message: message} }

// Message is the single current JSON envelope. Byte slices are base64 in JSON.
type Message struct {
	Type             string `json:"type"`
	BuildID          string `json:"buildId,omitempty"`
	ClientID         uint64 `json:"clientId,omitempty"`
	PeerID           string `json:"peerId,omitempty"`
	Name             string `json:"name,omitempty"`
	Color            string `json:"color,omitempty"`
	MessageID        string `json:"messageId,omitempty"`
	RequestID        string `json:"requestId,omitempty"`
	Data             []byte `json:"data,omitempty"`
	Awareness        []byte `json:"awareness,omitempty"`
	Markdown         string `json:"markdown"`
	Revision         uint64 `json:"revision"`
	MarkdownRevision uint64 `json:"markdownRevision"`
	Code             string `json:"code,omitempty"`
	Message          string `json:"message,omitempty"`
	Close            bool   `json:"-"`
	Closing          bool   `json:"closing,omitempty"`
	Restored         bool   `json:"restored,omitempty"`
}

type Peer struct {
	Name     string
	ID       string
	OwnerID  string
	ClientID uint64
	Out      chan Message
	Cancel   func()
	drained  bool
}

func NewPeer(clientID uint64, cancel func()) *Peer {
	return &Peer{ID: rand.Text(), ClientID: clientID, Out: make(chan Message, 64), Cancel: cancel}
}

func (p *Peer) Send(m Message) {
	select {
	case p.Out <- m:
	default:
		p.Cancel()
	}
}

type Room struct {
	mu                  sync.Mutex
	workspace           *storage.Workspace
	state               storage.Snapshot
	peers               map[string]*Peer
	initializer         string
	stopped             *InputError
	closing             bool
	awareness           *awareness.Awareness
	history             *storage.HistoryEntry
	historyPendingSince time.Time
	lastAuthor          string
	historyDirty        bool
}

func New(workspace *storage.Workspace, state storage.Snapshot) *Room {
	a := awareness.New(0)
	a.SetMaxClients(storage.MaxPeers)
	a.SetMaxBytes(64 << 10)
	return &Room{workspace: workspace, state: state, peers: make(map[string]*Peer), awareness: a}
}

func (r *Room) broadcast(m Message) {
	for _, p := range r.peers {
		p.Send(m)
	}
}

func (r *Room) check() error {
	if r.stopped != nil {
		return r.stopped
	}
	if err := r.workspace.Check(r.state); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			r.stop("not_found", "文件已不存在，请打开实际文件的新路径")
		} else if errors.Is(err, storage.ErrChanged) || errors.Is(err, storage.ErrName) {
			r.stop("file_changed", "文件已在外部修改；停止编辑，请重启服务后重新打开")
		} else {
			return fmt.Errorf("check note %q: %w", r.state.Filename, err)
		}
		return r.stopped
	}
	return nil
}

func (r *Room) stop(code, message string) {
	r.stopped = &InputError{Code: code, Message: message}
	r.broadcast(Message{Type: "error", Code: code, Message: message, Close: true})
}

func (r *Room) Snapshot() (storage.Snapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.check(); err != nil {
		return storage.Snapshot{}, err
	}
	s := r.state
	s.CRDT = append([]byte(nil), s.CRDT...)
	return s, nil
}

type ExportSnapshot struct {
	Filename string `json:"filename"`
	Revision uint64 `json:"revision"`
	Markdown string `json:"markdown"`
}

func (r *Room) Export(revision uint64) (ExportSnapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.check(); err != nil {
		return ExportSnapshot{}, err
	}
	if !r.state.Initialized || r.state.Revision != revision || r.state.MarkdownRevision != revision {
		return ExportSnapshot{}, invalid("revision_conflict", "文档已变化或尚未保存，请重新发起导出")
	}
	return ExportSnapshot{Filename: r.state.Filename, Revision: revision, Markdown: r.state.Markdown}, nil
}

func (r *Room) Add(p *Peer) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.check(); err != nil {
		return err
	}
	if r.closing {
		return invalid("closing", "服务正在关闭")
	}
	if err := r.ensureHistory(); err != nil {
		return err
	}
	for _, other := range r.peers {
		if other.ClientID == p.ClientID {
			if other.OwnerID != p.OwnerID {
				return invalid("client_conflict", "此 client ID 已被其他会话使用")
			}
			// A reconnect from the same session takes over a half-open socket.
			// Remove ownership now so the old handler cannot remove new presence.
			other.Cancel()
			delete(r.peers, other.ID)
			if r.initializer == other.ID {
				r.initializer = ""
			}
		}
	}
	if len(r.peers) >= storage.MaxPeers {
		return invalid("room_full", "此文件最多允许 16 个连接")
	}
	r.peers[p.ID] = p
	if r.state.Initialized {
		r.sendInit(p)
	} else if r.initializer == "" {
		r.initializer = p.ID
		p.Send(Message{Type: "bootstrap", PeerID: p.ID, Markdown: r.state.Markdown, Revision: r.state.Revision})
	} else {
		p.Send(Message{Type: "waiting", PeerID: p.ID})
	}
	return nil
}

func (r *Room) sendInit(p *Peer) {
	p.Send(Message{Type: "init", PeerID: p.ID, Data: r.state.CRDT, Awareness: r.awareness.EncodeUpdate(nil), Revision: r.state.Revision, MarkdownRevision: r.state.MarkdownRevision})
}

func (r *Room) Remove(p *Peer) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.peers[p.ID]; !ok {
		return nil
	}
	delete(r.peers, p.ID)
	if state, ok := r.awareness.GetStates()[p.ClientID]; ok && state.State != nil {
		encoder := encoding.NewEncoder()
		encoder.WriteVarUint(1)
		encoder.WriteVarUint(p.ClientID)
		encoder.WriteVarUint(state.Clock)
		encoder.WriteVarString("null")
		data := encoder.Bytes()
		if err := r.awareness.ApplyUpdate(data, "disconnect"); err != nil {
			return fmt.Errorf("remove awareness: %w", err)
		}
		r.broadcast(Message{Type: "awareness", Data: data})
		r.awareness.PurgeTombstones(0)
	}
	if r.initializer == p.ID && !r.state.Initialized {
		r.initializer = ""
		for id, next := range r.peers {
			r.initializer = id
			next.Send(Message{Type: "bootstrap", PeerID: next.ID, Markdown: r.state.Markdown, Revision: r.state.Revision})
			break
		}
	}
	return nil
}

func candidate(base, update []byte) ([]byte, error) {
	if len(update) == 0 || len(update) > storage.MaxCRDT {
		return nil, invalid("invalid_update", "CRDT 更新大小无效")
	}
	doc := crdt.New(crdt.WithGC(false))
	defer doc.Destroy()
	if len(base) > 0 {
		if err := crdt.ApplyUpdateV1(doc, base, nil); err != nil {
			return nil, fmt.Errorf("decode committed CRDT: %w", err)
		}
	}
	if err := crdt.ApplyUpdateV1(doc, update, nil); err != nil {
		return nil, invalid("invalid_update", "无法解码 Yjs V1 更新")
	}
	pending := doc.PendingStats()
	if pending.Items != 0 || pending.DeleteRanges != 0 {
		return nil, invalid("missing_dependency", "更新依赖的先前内容尚未提交")
	}
	encoded := crdt.EncodeStateAsUpdateV1(doc, nil)
	if _, err := storage.MarkdownText(encoded); err != nil {
		return nil, invalid("invalid_update", "Markdown 文档无效或超过大小限制")
	}
	if len(encoded) > storage.MaxCRDT {
		return nil, invalid("too_large", "完整 CRDT 超过 16 MiB")
	}
	return encoded, nil
}

func (r *Room) Handle(p *Peer, m Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.check(); err != nil {
		return err
	}
	if _, ok := r.peers[p.ID]; !ok {
		return invalid("not_joined", "连接未加入房间")
	}
	switch m.Type {
	case "initialize":
		if r.state.Initialized || r.initializer != p.ID || m.Revision != r.state.Revision {
			return invalid("not_initializer", "没有此文件的初始化资格")
		}
		if m.RequestID == "" || len(m.RequestID) > 128 || len(m.Markdown) > storage.MaxMarkdown || !utf8.ValidString(m.Markdown) {
			return invalid("invalid_message", "初始化字段无效")
		}
		encoded, err := candidate(nil, m.Data)
		if err != nil {
			return err
		}
		next := r.state
		next.Format = storage.MarkdownFormat
		next.Initialized = true
		next.Revision++
		next.CRDT = encoded
		next.Markdown, err = storage.MarkdownText(encoded)
		if err != nil {
			return err
		}
		if !r.state.Initialized && next.Markdown != r.state.Markdown {
			return invalid("invalid_message", "初始化改变了 Markdown 原文")
		}
		next.MarkdownRevision = next.Revision
		if err := r.commitProjection(next); err != nil {
			return err
		}
		if _, err := r.recordHistory("initial", p.Name, time.Now()); err != nil {
			return err
		}
		r.initializer = ""
		for _, member := range r.peers {
			r.sendInit(member)
		}
		r.broadcast(Message{Type: "saved", Revision: r.state.Revision, RequestID: m.RequestID})
	case "update":
		if p.drained {
			return invalid("closing", "关闭确认后不再接受输入")
		}
		if !r.state.Initialized {
			return invalid("not_initialized", "文档尚未初始化")
		}
		if m.MessageID == "" || len(m.MessageID) > 128 {
			return invalid("invalid_message", "缺少有效 messageId")
		}
		encoded, err := candidate(r.state.CRDT, m.Data)
		if err != nil {
			return err
		}
		next := r.state
		next.CRDT = encoded
		next.Revision++
		if next.Revision > 9007199254740991 {
			return errors.New("revision exhausted")
		}
		if err := r.workspace.Save(next); err != nil {
			return err
		}
		r.state = next
		r.lastAuthor = p.Name
		r.historyPendingSince = time.Now()
		r.historyDirty = true
		if r.closing {
			for _, member := range r.peers {
				member.drained = false
			}
		}
		r.broadcast(Message{Type: "update", Data: m.Data, PeerID: p.ID, MessageID: m.MessageID, Revision: next.Revision})
	case "flush":
		if m.RequestID == "" || len(m.RequestID) > 128 || len(m.Markdown) > storage.MaxMarkdown || !utf8.ValidString(m.Markdown) {
			return invalid("invalid_message", "Markdown 提交字段无效")
		}
		if !r.state.Initialized || m.Revision != r.state.Revision {
			return invalid("revision_conflict", "文档已变化，请提交当前修订")
		}
		markdown, err := storage.MarkdownText(r.state.CRDT)
		if err != nil {
			return fmt.Errorf("read authoritative Markdown: %w", err)
		}
		if r.state.MarkdownRevision == m.Revision {
			if r.state.Markdown != markdown {
				return fmt.Errorf("projection invariant failed for %q revision %d", r.state.Filename, m.Revision)
			}
		} else {
			next := r.state
			next.Markdown = markdown
			next.MarkdownRevision = m.Revision
			if err := r.commitProjection(next); err != nil {
				return err
			}
		}
		r.broadcast(Message{Type: "saved", Revision: r.state.Revision, RequestID: m.RequestID})
		if r.closing && m.Closing {
			p.drained = true
		}
	case "awareness":
		if err := r.applyAwareness(p, m.Data); err != nil {
			return err
		}
	default:
		return invalid("invalid_message", "未知消息类型")
	}
	return nil
}

// The three writes deliberately remain under the same room mutex. Any I/O
// error is returned to the process fatal path before acknowledgement.
func (r *Room) commitProjection(next storage.Snapshot) error {
	if err := r.workspace.Save(next); err != nil {
		return err
	}
	if err := r.workspace.WriteMarkdown(next); err != nil {
		return err
	}
	next.DiskHash = storage.Hash([]byte(next.Markdown))
	if err := r.workspace.Save(next); err != nil {
		return err
	}
	r.state = next
	return nil
}

func (r *Room) applyAwareness(p *Peer, data []byte) error {
	if len(data) > 4<<10 {
		return invalid("invalid_awareness", "Awareness 过大")
	}
	decoder := encoding.NewDecoder(data)
	count, err := decoder.ReadVarUint()
	if err != nil || count != 1 {
		return invalid("invalid_awareness", "只允许更新本连接的 Awareness")
	}
	id, err := decoder.ReadVarUint()
	if err != nil || id != p.ClientID {
		return invalid("invalid_awareness", "Awareness client ID 不匹配")
	}
	if _, err = decoder.ReadVarUint(); err != nil {
		return invalid("invalid_awareness", "Awareness clock 无效")
	}
	state, err := decoder.ReadVarString()
	if err != nil || decoder.HasContent() {
		return invalid("invalid_awareness", "Awareness 状态无效")
	}
	var object map[string]interface{}
	if err := json.Unmarshal([]byte(state), &object); err != nil || awarenessDepth(object) > 20 {
		return invalid("invalid_awareness", "Awareness 必须是有效且有限深度的 JSON 对象")
	}
	if user, ok := object["user"].(map[string]interface{}); ok {
		if name, ok := user["name"].(string); ok && len(name) <= 80 && utf8.ValidString(name) {
			p.Name = name
		}
	}
	if err := r.awareness.ApplyUpdate(data, p.ID); err != nil {
		return invalid("invalid_awareness", "无法解码 Awareness")
	}
	r.broadcast(Message{Type: "awareness", Data: data})
	return nil
}

func awarenessDepth(value interface{}) int {
	depth := 0
	switch node := value.(type) {
	case map[string]interface{}:
		for _, child := range node {
			if d := awarenessDepth(child); d > depth {
				depth = d
			}
		}
		return depth + 1
	case []interface{}:
		for _, child := range node {
			if d := awarenessDepth(child); d > depth {
				depth = d
			}
		}
		return depth + 1
	default:
		return 0
	}
}

func (r *Room) BeginClose() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closing = true
	r.broadcast(Message{Type: "closing"})
}

func (r *Room) Pending() (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	pending := r.state.Revision != r.state.MarkdownRevision
	if r.closing && r.state.Initialized {
		for _, p := range r.peers {
			if !p.drained {
				pending = true
			}
		}
	}
	return fmt.Sprintf("%s revision=%d markdownRevision=%d", r.state.Filename, r.state.Revision, r.state.MarkdownRevision), pending
}

type Manager struct {
	mu        sync.Mutex
	workspace *storage.Workspace
	rooms     map[string]*Room
	closing   bool
}

func Open(workspace *storage.Workspace) (*Manager, error) {
	m := &Manager{workspace: workspace, rooms: make(map[string]*Room)}
	names, err := workspace.List()
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		state, err := workspace.Load(name)
		if err != nil {
			return nil, err
		}
		m.rooms[name] = New(workspace, state)
	}
	return m, nil
}

func (m *Manager) Get(name string) (*Room, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return nil, invalid("closing", "服务正在关闭")
	}
	if err := storage.ValidNotePath(name); err != nil {
		return nil, err
	}
	if r, ok := m.rooms[name]; ok {
		return r, nil
	}
	state, err := m.workspace.Load(name)
	if err != nil {
		return nil, err
	}
	r := New(m.workspace, state)
	m.rooms[name] = r
	return r, nil
}

func (m *Manager) Create(name, markdown string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return invalid("closing", "服务正在关闭")
	}
	if err := m.workspace.Create(name, markdown); err != nil {
		return err
	}
	state := storage.Snapshot{Filename: name, Markdown: markdown, DiskHash: storage.Hash([]byte(markdown))}
	m.rooms[name] = New(m.workspace, state)
	return nil
}

func (m *Manager) BeginClose() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closing = true
	for _, r := range m.rooms {
		r.BeginClose()
	}
}

func (m *Manager) Pending() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var pending []string
	for _, r := range m.rooms {
		if name, yes := r.Pending(); yes {
			pending = append(pending, name)
		}
	}
	return pending
}
