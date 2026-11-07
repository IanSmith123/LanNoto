//go:build lannoto_fault_test

package storage

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Only an explicitly tagged acceptance binary contains this implementation.
// It observes real completed writes; it does not manufacture recovery state.
func atomicCheckpoint(stage, path string) error {
	directory := os.Getenv("LANNOTO_TEST_FAULT_DIR")
	if directory == "" {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(directory, "control.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var control struct {
		Stage      string `json:"stage"`
		File       string `json:"file"`
		Action     string `json:"action"`
		Projection bool   `json:"projection"`
	}
	if err := json.Unmarshal(data, &control); err != nil {
		return fmt.Errorf("test fault control: %w", err)
	}
	if control.Stage != "before-write" && control.Stage != "before-sync" && control.Stage != "after-replace" {
		return errors.New("invalid test fault stage")
	}
	if control.Action != "pause" && control.Action != "fail" {
		return errors.New("invalid test fault action")
	}
	if control.Stage != stage || control.File != filepath.Base(path) {
		return nil
	}
	if control.Projection {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var snapshot Snapshot
		if err := json.Unmarshal(data, &snapshot); err != nil {
			return err
		}
		if snapshot.MarkdownRevision != snapshot.Revision || snapshot.DiskHash == Hash([]byte(snapshot.Markdown)) {
			return nil
		}
	}
	if control.Action == "fail" {
		return fmt.Errorf("injected %s failure", stage)
	}
	ready, err := json.Marshal(map[string]string{"stage": stage, "file": filepath.Base(path)})
	if err != nil {
		return err
	}
	readyTemp := filepath.Join(directory, "ready.tmp")
	if err := os.WriteFile(readyTemp, ready, 0600); err != nil {
		return err
	}
	if err := os.Rename(readyTemp, filepath.Join(directory, "ready.json")); err != nil {
		return err
	}
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline.C:
			return errors.New("test checkpoint was not released within 20 seconds")
		case <-tick.C:
			_, err := os.Stat(filepath.Join(directory, "release"))
			if err == nil {
				return nil
			}
			if !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
}
