//go:build linux || darwin

package storage

import (
	"errors"
	"os"
)

func syncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(f.Sync(), f.Close())
}
