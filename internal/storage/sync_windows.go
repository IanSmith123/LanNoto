package storage

// ReplaceFile uses Windows MOVEFILE_WRITE_THROUGH. Windows directory handles
// do not support the Unix fsync operation. Power-loss durability is not claimed.
func syncDir(_ string) error { return nil }
