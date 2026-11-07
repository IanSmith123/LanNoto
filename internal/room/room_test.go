package room

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/reearth/ygo/crdt"
	"lannoto/internal/storage"
)

func persisted(t *testing.T, w *storage.Workspace, name string) (storage.Snapshot, error) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(w.State, name+".json"))
	if err != nil {
		return storage.Snapshot{}, err
	}
	var snapshot storage.Snapshot
	err = json.Unmarshal(data, &snapshot)
	return snapshot, err
}

func setup(t *testing.T) (*Room, *storage.Workspace, *Peer, *crdt.Doc, *crdt.YText) {
	t.Helper()
	w, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := w.Close(); err != nil {
			t.Error(err)
		}
	})
	if err := w.Create("测试.md", "正文😀"); err != nil {
		t.Fatal(err)
	}
	s, err := w.Load("测试.md")
	if err != nil {
		t.Fatal(err)
	}
	r := New(w, s)
	p := NewPeer(1, func() { t.Error("unexpected peer cancellation") })
	if err := r.Add(p); err != nil {
		t.Fatal(err)
	}
	if m := <-p.Out; m.Type != "bootstrap" {
		t.Fatal(m)
	}
	doc := crdt.New(crdt.WithGC(false))
	t.Cleanup(doc.Destroy)
	meta := doc.GetMap("lannoto")
	txt := doc.GetText("markdown")
	doc.Transact(func(txn *crdt.Transaction) {
		meta.Set(txn, "format", storage.MarkdownFormat)
		txt.Insert(txn, 0, "正文😀", nil)
	})
	if err := r.Handle(p, Message{Type: "initialize", RequestID: "seed", Data: crdt.EncodeStateAsUpdateV1(doc, nil), Markdown: "正文😀"}); err != nil {
		t.Fatal(err)
	}
	if (<-p.Out).Type != "init" || (<-p.Out).Type != "saved" {
		t.Fatal("initialization not acknowledged")
	}
	return r, w, p, doc, txt
}

func TestDeletionAdvancesRevisionAndRejectsStaleProjection(t *testing.T) {
	r, w, p, doc, txt := setup(t)
	vector := crdt.EncodeStateVectorV1(doc)
	doc.Transact(func(txn *crdt.Transaction) { txt.Delete(txn, 0, 1) })
	if !bytes.Equal(vector, crdt.EncodeStateVectorV1(doc)) {
		t.Fatal("deletion test must keep the state vector unchanged")
	}
	if err := r.Handle(p, Message{Type: "update", MessageID: "delete", Data: crdt.EncodeStateAsUpdateV1(doc, nil)}); err != nil {
		t.Fatal(err)
	}
	ack := <-p.Out
	if ack.Type != "update" || ack.Revision != 2 {
		t.Fatal(ack)
	}
	restored, err := persisted(t, w, "测试.md")
	if err != nil {
		t.Fatal(err)
	}
	if restored.Revision != 2 || restored.MarkdownRevision != 1 {
		t.Fatal("update acknowledged before durable snapshot")
	}
	err = r.Handle(p, Message{Type: "flush", RequestID: "stale", Revision: 1, Markdown: "不应写入"})
	var conflict *InputError
	if !errors.As(err, &conflict) || conflict.Code != "revision_conflict" {
		t.Fatalf("stale flush accepted: %v", err)
	}
	if err := r.Handle(p, Message{Type: "flush", RequestID: "current", Revision: 2, Markdown: "文😀"}); err != nil {
		t.Fatal(err)
	}
	if ack := <-p.Out; ack.Type != "saved" || ack.Revision != 2 {
		t.Fatal(ack)
	}
	data, err := w.ReadNote("测试.md")
	if err != nil || string(data) != "文😀" {
		t.Fatalf("projection not saved: %q %v", data, err)
	}
}

func TestFlushAlwaysUsesAuthoritativeMarkdown(t *testing.T) {
	r, w, peer, doc, text := setup(t)
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "原文\t", nil) })
	if err := r.Handle(peer, Message{Type: "update", MessageID: "edit", Data: crdt.EncodeStateAsUpdateV1(doc, nil)}); err != nil {
		t.Fatal(err)
	}
	<-peer.Out
	if err := r.Handle(peer, Message{Type: "flush", RequestID: "save", Revision: 2, Markdown: "不能作为正文的客户端投影"}); err != nil {
		t.Fatal(err)
	}
	if message := <-peer.Out; message.Type != "saved" || message.Revision != 2 {
		t.Fatal(message)
	}
	data, err := w.ReadNote("测试.md")
	if err != nil || string(data) != "原文\t正文😀" {
		t.Fatalf("incorrect authority %q, %v", data, err)
	}
}

func TestMarkdownByteLimitRejectsBeforePublishing(t *testing.T) {
	r, w, peer, doc, text := setup(t)
	before, err := os.ReadFile(filepath.Join(w.State, "测试.md.json"))
	if err != nil {
		t.Fatal(err)
	}
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, strings.Repeat("中", storage.MaxMarkdown/3+1), nil) })
	err = r.Handle(peer, Message{Type: "update", MessageID: "oversize", Data: crdt.EncodeStateAsUpdateV1(doc, nil)})
	var input *InputError
	if !errors.As(err, &input) || input.Code != "invalid_update" {
		t.Fatalf("oversize Markdown accepted: %v", err)
	}
	if r.state.Revision != 1 {
		t.Fatal("rejected edit advanced revision")
	}
	after, err := os.ReadFile(filepath.Join(w.State, "测试.md.json"))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("rejected edit changed snapshot: %v", err)
	}
	select {
	case message := <-peer.Out:
		t.Fatalf("rejected edit was acknowledged: %+v", message)
	default:
	}
}

func TestSlowPeerIsCancelledAndCanRecoverAllCommittedUpdates(t *testing.T) {
	r, w, healthy, doc, txt := setup(t)
	cancelled := false
	slow := NewPeer(2, func() { cancelled = true })
	if err := r.Add(slow); err != nil {
		t.Fatal(err)
	}
	// Leave the slow connection's finite writer queue unread, while a healthy
	// connection keeps consuming its acknowledgements.
	for index := 0; index < 65; index++ {
		doc.Transact(func(txn *crdt.Transaction) { txt.Insert(txn, 0, "x", nil) })
		id := fmt.Sprintf("slow-peer-%d", index)
		if err := r.Handle(healthy, Message{Type: "update", MessageID: id, Data: crdt.EncodeStateAsUpdateV1(doc, nil)}); err != nil {
			t.Fatal(err)
		}
		if message := <-healthy.Out; message.Type != "update" || message.MessageID != id {
			t.Fatalf("healthy peer lost update: %+v", message)
		}
	}
	if !cancelled {
		t.Fatal("full slow queue did not cancel its connection")
	}
	if len(slow.Out) != cap(slow.Out) {
		t.Fatal("slow queue did not remain bounded")
	}
	if err := r.Remove(slow); err != nil {
		t.Fatal(err)
	}
	reconnected := NewPeer(2, func() { t.Error("unexpected reconnect cancellation") })
	if err := r.Add(reconnected); err != nil {
		t.Fatal(err)
	}
	message := <-reconnected.Out
	if message.Type != "init" || message.Revision != 66 {
		t.Fatalf("reconnect did not receive current snapshot: %+v", message)
	}
	recovered := crdt.New(crdt.WithGC(false))
	defer recovered.Destroy()
	if err := crdt.ApplyUpdateV1(recovered, message.Data, nil); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(crdt.EncodeStateVectorV1(recovered), crdt.EncodeStateVectorV1(doc)) {
		t.Fatal("reconnect snapshot lacks committed CRDT items")
	}
	state, err := w.Load("测试.md")
	if err != nil {
		t.Fatal(err)
	}
	if state.Revision != 66 {
		t.Fatal("slow connection prevented durable commits")
	}
}

func TestMergedCRDTLimitRejectsValidIncrementWithoutPublishing(t *testing.T) {
	r, w, peer, doc, text := setup(t)
	// Deleted history can grow while projected Markdown remains small. Each
	// increment fits the input cap, but the merged undo-preserving state does not.
	firstSize := storage.MaxCRDT / 2
	doc.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 0, strings.Repeat("x", firstSize), nil)
		text.Delete(txn, 0, firstSize)
	})
	first := crdt.EncodeStateAsUpdateV1(doc, nil)
	if len(first) <= firstSize || len(first) >= storage.MaxCRDT {
		t.Fatal("fixture did not retain the deleted history below the cap")
	}
	if err := r.Handle(peer, Message{Type: "update", MessageID: "first-history", Data: first}); err != nil {
		t.Fatal(err)
	}
	if message := <-peer.Out; message.Type != "update" || message.Revision != 2 {
		t.Fatal("first history was not committed")
	}
	path := filepath.Join(w.State, "测试.md.json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	vector, err := crdt.DecodeStateVectorV1(crdt.EncodeStateVectorV1(doc))
	if err != nil {
		t.Fatal(err)
	}
	secondSize := firstSize + (1 << 20)
	doc.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 0, strings.Repeat("y", secondSize), nil)
		text.Delete(txn, 0, secondSize)
	})
	increment := crdt.EncodeStateAsUpdateV1(doc, vector)
	if len(increment) >= storage.MaxCRDT {
		t.Fatal("increment itself must fit the cap")
	}
	err = r.Handle(peer, Message{Type: "update", MessageID: "too-much-history", Data: increment})
	var input *InputError
	if !errors.As(err, &input) || input.Code != "too_large" {
		t.Fatalf("merged state cap not enforced: %v", err)
	}
	if r.state.Revision != 2 {
		t.Fatal("rejected update advanced authority")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("rejected history changed authoritative snapshot")
	}
	select {
	case message := <-peer.Out:
		t.Fatalf("rejected history was acknowledged: %+v", message)
	default:
	}
}

func TestPersistenceFailureDoesNotPublishOrAdvanceState(t *testing.T) {
	r, w, p, doc, txt := setup(t)
	doc.Transact(func(txn *crdt.Transaction) { txt.Insert(txn, 0, "修改", nil) })
	snapshot := filepath.Join(w.State, "测试.md.json")
	if err := os.Remove(snapshot); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(snapshot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := r.Handle(p, Message{Type: "update", MessageID: "must-not-ack", Data: crdt.EncodeStateAsUpdateV1(doc, nil)}); err == nil {
		t.Fatal("snapshot failure hidden")
	}
	select {
	case message := <-p.Out:
		t.Fatalf("acknowledged failed update: %+v", message)
	default:
	}
	if r.state.Revision != 1 {
		t.Fatal("in-memory revision advanced before persistence")
	}
}

func TestMissingFileStopsRoom(t *testing.T) {
	r, w, p, _, _ := setup(t)
	if err := os.Rename(filepath.Join(w.Notes, "测试.md"), filepath.Join(w.Notes, "新名字.md")); err != nil {
		t.Fatal(err)
	}
	if err := r.Handle(p, Message{Type: "flush", RequestID: "old", Revision: 1, Markdown: "正文😀"}); err == nil {
		t.Fatal("old room accepted renamed file")
	}
	if _, err := os.Stat(filepath.Join(w.Notes, "测试.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("old file revived")
	}
	if m := <-p.Out; m.Code != "not_found" || !m.Close {
		t.Fatal(m)
	}
}

func TestInitializerTransfersToOnlyOneWaitingPeer(t *testing.T) {
	w, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := w.Close(); err != nil {
			t.Error(err)
		}
	}()
	if err := w.Create("首次.md", "已有内容"); err != nil {
		t.Fatal(err)
	}
	s, err := w.Load("首次.md")
	if err != nil {
		t.Fatal(err)
	}
	r := New(w, s)
	a := NewPeer(1, func() { t.Error("cancelled a") })
	b := NewPeer(2, func() { t.Error("cancelled b") })
	c := NewPeer(3, func() { t.Error("cancelled c") })
	for _, p := range []*Peer{a, b, c} {
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if (<-a.Out).Type != "bootstrap" || (<-b.Out).Type != "waiting" || (<-c.Out).Type != "waiting" {
		t.Fatal("multiple initializers")
	}
	if err := r.Remove(a); err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, p := range []*Peer{b, c} {
		select {
		case m := <-p.Out:
			if m.Type != "bootstrap" {
				t.Fatal(m)
			}
			count++
		default:
		}
	}
	if count != 1 {
		t.Fatalf("transferred to %d peers", count)
	}
}

func TestConcurrentCommitsAreSerializedAndDurable(t *testing.T) {
	r, w, p, base, _ := setup(t)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		doc := crdt.New(crdt.WithGC(false))
		if err := crdt.ApplyUpdateV1(doc, crdt.EncodeStateAsUpdateV1(base, nil), nil); err != nil {
			t.Fatal(err)
		}
		txt := doc.GetText("markdown")
		doc.Transact(func(txn *crdt.Transaction) {
			txt.Insert(txn, 0, fmt.Sprintf("并发%d", i), nil)
		})
		update := crdt.EncodeStateAsUpdateV1(doc, nil)
		doc.Destroy()
		wg.Add(1)
		go func(id int, data []byte) {
			defer wg.Done()
			if err := r.Handle(p, Message{Type: "update", MessageID: fmt.Sprintf("update-%d", id), Data: data}); err != nil {
				t.Error(err)
			}
		}(i, update)
	}
	wg.Wait()
	s, err := persisted(t, w, "测试.md")
	if err != nil {
		t.Fatal(err)
	}
	if s.Revision != 5 || s.MarkdownRevision != 1 {
		t.Fatalf("lost commit: %d / %d", s.Revision, s.MarkdownRevision)
	}
	for revision := uint64(2); revision <= 5; revision++ {
		if message := <-p.Out; message.Revision != revision {
			t.Fatalf("out of order: %+v", message)
		}
	}
}
