//go:build !windows

package server

import (
	"errors"
	"syscall"
)

func nativeFilenameError(err error) bool { return errors.Is(err, syscall.ENAMETOOLONG) }
