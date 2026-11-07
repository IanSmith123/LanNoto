package room

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/reearth/ygo/crdt"
)

func TestManualHistoryRestoreBroadcastsIncrementalUnicodeAndPreservesBeforeVersion(t *testing.T) {
	r, w, peer, doc, text := setup(t)
	first, err := r.Checkpoint(1, "Tom")
	if err != nil {
		t.Fatal(err)
	}
	<-peer.Out
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "😀变更\t", nil) })
	if err := r.Handle(peer, Message{Type: "update", MessageID: "change", Data: crdt.EncodeStateAsUpdateV1(doc, nil)}); err != nil {
		t.Fatal(err)
	}
	<-peer.Out
	if _, err := r.Restore(first.ID, 1, "Tim"); err == nil {
		t.Fatal("stale restore overwrote new edits")
	}
	snapshot, err := r.Restore(first.ID, 2, "Tom")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Revision != 3 || snapshot.Markdown != "正文😀" {
		t.Fatal(snapshot)
	}
	update := <-peer.Out
	if !update.Restored || update.Type != "update" || update.Revision != 3 {
		t.Fatal(update)
	}
	if err := crdt.ApplyUpdateV1(doc, update.Data, nil); err != nil {
		t.Fatal(err)
	}
	if text.ToString() != "正文😀" {
		t.Fatal("browser-compatible delta has wrong Unicode positions")
	}
	if saved := <-peer.Out; saved.Type != "saved" || saved.Revision != 3 {
		t.Fatal(saved)
	}
	list, err := w.History("测试.md", "")
	if err != nil || len(list.Items) != 3 {
		t.Fatal(list, err)
	}
	before, err := w.HistoryEntry("测试.md", list.Items[1].ID)
	if err != nil || before.Markdown != "😀变更\t正文😀" {
		t.Fatal("lost pre-restore content", err)
	}
}
func TestAutomaticHistoryRecordsLargeBlocksAndTimedSmallEdits(t *testing.T) {
	r, w, peer, doc, text := setup(t)
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, strings.Repeat("长", 210), nil) })
	if err := r.Handle(peer, Message{Type: "update", MessageID: "block", Data: crdt.EncodeStateAsUpdateV1(doc, nil)}); err != nil {
		t.Fatal(err)
	}
	<-peer.Out
	if err := r.checkpointDue(r.historyPendingSince.Add(HistoryBlockDelay + time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	page, err := w.History("测试.md", "")
	if err != nil || len(page.Items) != 2 || page.Items[0].Reason != "block" {
		t.Fatal(page, err)
	}
	<-peer.Out
	// A short replacement has no large Markdown block. It is captured by time.
	doc.Transact(func(txn *crdt.Transaction) { text.Delete(txn, 0, text.Len()); text.Insert(txn, 0, "短文", nil) })
	if err := r.Handle(peer, Message{Type: "update", MessageID: "small", Data: crdt.EncodeStateAsUpdateV1(doc, nil)}); err != nil {
		t.Fatal(err)
	}
	<-peer.Out
	if err := r.checkpointDue(r.history.CreatedAt.Add(HistoryInterval + time.Second)); err != nil {
		t.Fatal(err)
	}
	page, err = w.History("测试.md", "")
	if err != nil || page.Items[0].Reason != "interval" {
		t.Fatal(page, err)
	}
	disk, err := w.ReadNote("测试.md")
	if err != nil || string(disk) != "短文" {
		t.Fatal("timed checkpoint was not projected", err)
	}
}
func TestLargeBlockHeuristicPreservesSmallTypingAndDetectsCodeAndDeletion(t *testing.T) {
	for _, sample := range []struct {
		before, after string
		large         bool
	}{
		{"短文", "短文追加", false},
		{"", strings.Repeat("x", 500), true},
		{"```go\n" + strings.Repeat("fmt.Println(1)\n", 20) + "```", "```go\n" + strings.Repeat("fmt.Println(1)\n", 19) + "fmt.Println(2)\n```", true},
		{strings.Repeat("x", 250), "", true},
	} {
		if largeChange(sample.before, sample.after) != sample.large {
			t.Fatal(sample)
		}
	}
}
func TestHistoryFailurePreventsRestoreAndLeavesNoteUnchanged(t *testing.T) {
	r, _, peer, _, _ := setup(t)
	initial := r.state
	_, err := r.Restore("../../invalid", 1, "Tom")
	if err == nil {
		t.Fatal("unsafe history identifier accepted")
	}
	if r.state.Revision != initial.Revision || r.state.Markdown != initial.Markdown {
		t.Fatal("failed restore changed note")
	}
	select {
	case value := <-peer.Out:
		t.Fatal("failed restore broadcast", value)
	default:
	}
	var input *InputError
	if errors.As(err, &input) {
		t.Fatal("expected storage identifier validation")
	}
}
