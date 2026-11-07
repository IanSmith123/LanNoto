//go:build !windows

package storage

import "github.com/natefinch/atomic"

func replaceFile(source, destination string) error { return atomic.ReplaceFile(source, destination) }
