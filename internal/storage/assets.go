package storage

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "golang.org/x/image/webp"
)

const MaxImagePixels = 64_000_000

var ErrImage = errors.New("invalid clipboard image")
var ErrAssetSize = errors.New("asset exceeds size limit")

type Asset struct {
	Filename string `json:"filename"`
	URL      string `json:"url"`
	Kind     string `json:"kind"`
}

func BitmapFormat(reader io.ReadSeeker) (string, error) {
	config, format, err := image.DecodeConfig(reader)
	if err != nil {
		return "", err
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > MaxImagePixels {
		return "", ErrAssetSize
	}
	if format != "png" && format != "jpeg" && format != "gif" && format != "webp" {
		return "", ErrImage
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	if _, _, err := image.Decode(reader); err != nil {
		return "", err
	}
	return format, nil
}

func (w *Workspace) StoreAsset(filename, source string, data []byte, now time.Time) (Asset, error) {
	if source != "file" && source != "clipboard-image" {
		return Asset{}, fmt.Errorf("%w: sourceKind must be file or clipboard-image", ErrName)
	}
	if len(data) > MaxAsset {
		return Asset{}, ErrAssetSize
	}
	kind := "attachment"
	format, imageErr := BitmapFormat(bytes.NewReader(data))
	if imageErr == nil {
		kind = "image"
	}
	if errors.Is(imageErr, ErrAssetSize) {
		return Asset{}, ErrAssetSize
	}
	if source == "clipboard-image" {
		if imageErr != nil {
			return Asset{}, ErrImage
		}
		ext := format
		if ext == "jpeg" {
			ext = "jpg"
		}
		filename = now.Format("20060102150405") + "." + ext
	}
	if !visibleAssetName(filename) {
		return Asset{}, ErrName
	}
	if _, err := os.Lstat(filepath.Join(w.Static, filename)); err == nil {
		return Asset{}, os.ErrExist
	} else if !errors.Is(err, os.ErrNotExist) {
		return Asset{}, err
	}
	if err := CreateExclusive(filepath.Join(w.Static, filename), data); err != nil {
		return Asset{}, err
	}
	return Asset{Filename: filename, URL: "static/" + url.PathEscape(filename), Kind: kind}, nil
}

func visibleAssetName(name string) bool {
	return ValidName(name, false) == nil && !strings.HasPrefix(name, ".lannoto-create-") && !strings.HasPrefix(name, ".lannoto-write-")
}

func (w *Workspace) OpenWorkspaceAsset(name string) (*os.File, os.FileInfo, error) {
	if validWorkspacePath(name) != nil || ValidNotePath(name) == nil {
		return nil, nil, ErrName
	}
	if asset, ok := strings.CutPrefix(name, "static/"); ok {
		return w.OpenAsset(asset)
	}
	return openAssetAt(w.notesRoot, name)
}

func (w *Workspace) OpenAsset(name string) (*os.File, os.FileInfo, error) {
	return openAssetAt(w.staticRoot, name)
}

func openAssetAt(root *os.Root, name string) (*os.File, os.FileInfo, error) {
	var info os.FileInfo
	var err error
	parts := strings.Split(name, "/")
	for i, part := range parts {
		if !visibleAssetName(part) {
			return nil, nil, ErrName
		}
		info, err = root.Lstat(strings.Join(parts[:i+1], "/"))
		if err != nil {
			return nil, nil, err
		}
		if info.Name() != part {
			return nil, nil, os.ErrNotExist
		}
		if i < len(parts)-1 && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
			return nil, nil, ErrName
		}
	}
	if !info.Mode().IsRegular() {
		return nil, nil, fmt.Errorf("%w: asset is not a regular file", ErrName)
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, nil, err
	}
	opened, err := f.Stat()
	if err != nil {
		return nil, nil, errors.Join(err, f.Close())
	}
	if !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		return nil, nil, errors.Join(os.ErrNotExist, f.Close())
	}
	return f, opened, nil
}
