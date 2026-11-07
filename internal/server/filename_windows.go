package server

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows"
)

func nativeFilenameError(err error) bool {
	return errors.Is(err, windows.ERROR_INVALID_NAME) || errors.Is(err, windows.ERROR_FILENAME_EXCED_RANGE) || errors.Is(err, syscall.ENAMETOOLONG)
}
