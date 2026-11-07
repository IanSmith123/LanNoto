//go:build !lannoto_fault_test

package storage

// The ordinary build has no fault controls or environment reads. This empty
// checkpoint is inlined away; its test implementation is build-tag gated.
func atomicCheckpoint(stage, path string) error { return nil }
