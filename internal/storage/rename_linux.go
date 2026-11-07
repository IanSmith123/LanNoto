package storage

import (
	"os"

	"golang.org/x/sys/unix"
)

func renameExclusive(sourceDir, targetDir *os.File, from, to string) error {
	err := unix.Renameat2(int(sourceDir.Fd()), from, int(targetDir.Fd()), to, unix.RENAME_NOREPLACE)
	if err == unix.EXDEV {
		return ErrDifferentVolume
	}
	return err
}
