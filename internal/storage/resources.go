package storage

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
	"unicode/utf8"
)

var ErrResourceSize = errors.New("export resource exceeds size limit")

func validResource(name string) bool {
	if name == "" || !utf8.ValidString(name) || strings.ContainsAny(name, "\\\x00") || path.IsAbs(name) || path.Clean(name) != name {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "." || part == ".." || part == "" {
			return false
		}
	}
	return true
}
func (w *Workspace) ResourceNames() ([]string, error) {
	w.notesMu.RLock()
	defer w.notesMu.RUnlock()
	return resourceNames(w.notesRoot)
}
func resourceNames(root *os.Root) ([]string, error) {
	var names []string
	err := fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if name == "." {
			return nil
		}
		if strings.HasPrefix(entry.Name(), ".lannoto-write-") || strings.HasPrefix(entry.Name(), ".lannoto-create-") {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return ErrName
		}
		if !validResource(name) || !entry.IsDir() && !entry.Type().IsRegular() {
			return ErrName
		}
		if entry.IsDir() {
			name += "/"
		}
		names = append(names, name)
		return nil
	})
	return names, err
}

type contextWriter struct {
	ctx    context.Context
	writer io.Writer
}

func (w contextWriter) Write(data []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	return w.writer.Write(data)
}
func (w *Workspace) CopyResource(ctx context.Context, name string, writer io.Writer, limit int64) (size int64, resultErr error) {
	// Note writers atomically replace Markdown at any depth.
	if ValidNotePath(name) == nil {
		w.notesMu.RLock()
		defer w.notesMu.RUnlock()
	}
	return copyRootResource(ctx, w.notesRoot, name, writer, limit)
}
func copyRootResource(ctx context.Context, root *os.Root, name string, writer io.Writer, limit int64) (size int64, resultErr error) {
	if !validResource(name) {
		return 0, ErrName
	}
	parts := strings.Split(name, "/")
	for index := range parts {
		info, err := root.Lstat(strings.Join(parts[:index+1], "/"))
		if err != nil {
			return 0, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return 0, ErrName
		}
	}
	info, err := root.Lstat(name)
	if err != nil {
		return 0, err
	}
	if !info.Mode().IsRegular() {
		return 0, ErrName
	}
	if info.Size() > limit {
		return 0, ErrResourceSize
	}
	file, err := root.Open(name)
	if err != nil {
		return 0, err
	}
	defer func() {
		if err := file.Close(); err != nil {
			resultErr = errors.Join(ErrIO, resultErr, err)
		}
	}()
	size, err = io.Copy(contextWriter{ctx, writer}, io.LimitReader(file, limit+1))
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return size, err
		}
		return size, errors.Join(ErrIO, err)
	}
	if size > limit {
		return size, ErrResourceSize
	}
	after, err := file.Stat()
	if err != nil {
		return size, errors.Join(ErrIO, err)
	}
	if size != info.Size() || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return size, ErrChanged
	}
	return size, nil
}
