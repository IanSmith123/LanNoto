package bundle

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"lannoto/internal/storage"
)

const MaxBytes = int64(512 << 20)
const MaxFiles = 10000

type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

type Exporter struct {
	workspace *storage.Workspace
}

func New(workspace *storage.Workspace) *Exporter { return &Exporter{workspace: workspace} }

type Result struct {
	File                  *os.File
	Size                  int64
	Filename, ContentType string
	directory             string
}

func (r *Result) Close() error { return errors.Join(r.File.Close(), os.RemoveAll(r.directory)) }

type archiveWriter struct {
	writer    *zip.Writer
	workspace *storage.Workspace
	bytes     int64
	names     map[string]bool
	ctx       context.Context
	plain     bool
	markdown  []byte
	prefix    string
}

func (a *archiveWriter) add(name string, data []byte) error {
	if err := a.ctx.Err(); err != nil {
		return err
	}
	name = a.prefix + name
	if a.names[name] {
		return nil
	}
	if len(a.names) >= MaxFiles || a.bytes+int64(len(data)) > MaxBytes {
		return &ValidationError{"ZIP 超过 512 MiB 或 10000 个文件限制"}
	}
	file, err := a.writer.Create(name)
	if err != nil {
		return errors.Join(storage.ErrIO, err)
	}
	if len(data) > 0 {
		if _, err := file.Write(data); err != nil {
			return errors.Join(storage.ErrIO, err)
		}
	}
	a.names[name] = true
	a.bytes += int64(len(data))
	return nil
}
func (a *archiveWriter) local(name string) error {
	zipName := a.prefix + name
	if a.names[zipName] {
		return nil
	}
	if len(a.names) >= MaxFiles {
		return &ValidationError{"ZIP 超过 10000 个文件限制"}
	}
	file, err := a.writer.Create(zipName)
	if err != nil {
		return errors.Join(storage.ErrIO, err)
	}
	size, err := a.workspace.CopyResource(a.ctx, name, file, MaxBytes-a.bytes)
	if err != nil {
		if errors.Is(err, storage.ErrIO) {
			return err
		}
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, storage.ErrName) || errors.Is(err, storage.ErrChanged) || errors.Is(err, storage.ErrResourceSize) {
			return &ValidationError{"引用资源不存在、路径无效、正在变化或超过大小限制：" + name}
		}
		return err
	}
	a.names[zipName] = true
	a.bytes += size
	return nil
}
func (e *Exporter) build(ctx context.Context, filename string, write func(*archiveWriter) error) (result *Result, resultErr error) {
	directory, err := os.MkdirTemp(e.workspace.Temp, "bundle-*")
	if err != nil {
		return nil, errors.Join(storage.ErrIO, err)
	}
	defer func() {
		if resultErr != nil {
			resultErr = errors.Join(resultErr, func() error {
				if err := os.RemoveAll(directory); err != nil {
					return errors.Join(storage.ErrIO, err)
				}
				return nil
			}())
		}
	}()
	file, err := os.Create(filepath.Join(directory, "bundle.zip"))
	if err != nil {
		return nil, errors.Join(storage.ErrIO, err)
	}
	writer := zip.NewWriter(file)
	archive := &archiveWriter{writer: writer, workspace: e.workspace, names: map[string]bool{}, ctx: ctx}
	writeErr := write(archive)
	zipErr := writer.Close()
	closeErr := file.Close()
	if zipErr != nil || closeErr != nil {
		return nil, errors.Join(writeErr, storage.ErrIO, zipErr, closeErr)
	}
	if writeErr != nil {
		return nil, writeErr
	}
	contentType := "application/zip"
	if archive.plain {
		if err := os.WriteFile(filepath.Join(directory, "bundle.zip"), archive.markdown, 0600); err != nil {
			return nil, errors.Join(storage.ErrIO, err)
		}
		filename = strings.TrimSuffix(filename, ".zip") + ".md"
		contentType = "text/markdown; charset=utf-8"
	}
	file, err = os.Open(filepath.Join(directory, "bundle.zip"))
	if err != nil {
		return nil, errors.Join(storage.ErrIO, err)
	}
	info, err := file.Stat()
	if err != nil {
		return nil, errors.Join(storage.ErrIO, err, file.Close())
	}
	return &Result{file, info.Size(), filename, contentType, directory}, nil
}
func (e *Exporter) Workspace(ctx context.Context, markdown map[string]string) (*Result, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	names, err := e.workspace.ResourceNames()
	if err != nil {
		return nil, err
	}
	return e.build(ctx, "workspace.zip", func(archive *archiveWriter) error {
		archive.prefix = "note/"
		for _, name := range names {
			if err := ctx.Err(); err != nil {
				return err
			}
			if strings.HasSuffix(name, "/") {
				if err := archive.add(name, nil); err != nil {
					return err
				}
			} else if content, ok := markdown[name]; ok {
				if err := archive.add(name, []byte(content)); err != nil {
					return err
				}
			} else if err := archive.local(name); err != nil {
				return err
			}
		}
		return nil
	})
}
func localURI(raw, origin string) (name, replacement string, local bool, err error) {
	uri, err := url.Parse(raw)
	if err != nil {
		return "", "", false, &ValidationError{"引用资源地址无效"}
	}
	if uri.Scheme != "" || uri.Host != "" {
		base, parseErr := url.Parse(origin)
		if parseErr != nil {
			return "", "", false, parseErr
		}
		if uri.Scheme == "" {
			uri.Scheme = base.Scheme
		}
		if uri.Scheme != base.Scheme || !strings.EqualFold(uri.Host, base.Host) {
			return "", "", false, nil
		}
	}
	if uri.Path == "" {
		return "", "", false, nil
	}
	resource := strings.TrimPrefix(uri.Path, "/note/")
	if strings.HasPrefix(resource, "/") || strings.ContainsAny(resource, "\\\x00") {
		return "", "", false, &ValidationError{"引用资源必须位于笔记工作区中"}
	}
	resource = path.Clean(resource)
	if resource == ".." || strings.HasPrefix(resource, "../") || resource == "." {
		return "", "", false, &ValidationError{"引用资源不能离开笔记工作区"}
	}
	// Always use a URL-encoded relative path in the exported copy.
	copy := url.URL{Path: resource, Fragment: uri.Fragment}
	return resource, copy.String(), true, nil
}
func (e *Exporter) Note(ctx context.Context, filename, markdown, origin string) (*Result, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	refs, err := references(markdown)
	if err != nil {
		return nil, err
	}
	return e.build(ctx, strings.TrimSuffix(path.Base(filename), ".md")+".zip", func(archive *archiveWriter) error {
		replacements := make(map[string]string)
		for _, ref := range refs {
			if err := ctx.Err(); err != nil {
				return err
			}
			if _, exists := replacements[ref.uri]; exists {
				continue
			}
			if ref.uri == "" || strings.HasPrefix(ref.uri, "#") || strings.HasPrefix(ref.uri, "mailto:") || strings.HasPrefix(ref.uri, "tel:") || strings.HasPrefix(ref.uri, "data:") {
				continue
			}
			name, replacement, local, err := localURI(ref.uri, origin)
			if err != nil {
				return err
			}
			if local {
				if name != filename {
					if err := archive.local(name); err != nil {
						return err
					}
				}
				replacements[ref.uri] = strings.Repeat("../", strings.Count(filename, "/")) + replacement
				continue
			}
		}
		output := []byte(markdown)
		for index := len(refs) - 1; index >= 0; index-- {
			ref := refs[index]
			replacement, exists := replacements[ref.uri]
			if !exists {
				continue
			}
			replacement = strings.ReplaceAll(replacement, "(", "%28")
			replacement = strings.ReplaceAll(replacement, ")", "%29")
			output = bytes.Join([][]byte{output[:ref.start], []byte(replacement), output[ref.end:]}, nil)
		}
		if len(archive.names) == 0 {
			archive.plain = true
			archive.markdown = []byte(markdown)
		}
		return archive.add(filename, output)
	})
}
