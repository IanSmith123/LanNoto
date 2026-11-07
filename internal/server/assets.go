package server

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"lannoto/internal/storage"
)

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	if s.closing.Load() {
		s.problem(w, 503, "closing", "服务正在关闭")
		return
	}
	value, err := s.Rooms.Get(r.PathValue("name"))
	if err != nil {
		s.operationError(w, err)
		return
	}
	if _, err := value.Snapshot(); err != nil {
		s.operationError(w, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, storage.MaxAsset+(64<<10))
	reader, err := r.MultipartReader()
	if err != nil {
		s.problem(w, 400, "invalid_upload", "需要 multipart 文件上传")
		return
	}
	var data []byte
	var filename, source string
	fileSeen, sourceSeen := false, false
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			s.uploadReadError(w, err)
			return
		}
		switch part.FormName() {
		case "file":
			if fileSeen {
				s.problem(w, 400, "invalid_upload", "每次请求只允许一个文件")
				return
			}
			fileSeen = true
			_, params, err := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
			if err != nil {
				s.problem(w, 400, "invalid_upload", "文件声明无效")
				return
			}
			filename = params["filename"] // Do not use FileName(), which strips directories.
			if filename != "" {
				if err := storage.ValidName(filename, false); err != nil {
					s.operationError(w, err)
					return
				}
			}
			data, err = io.ReadAll(io.LimitReader(part, storage.MaxAsset+1))
			if err != nil {
				s.uploadReadError(w, err)
				return
			}
			if len(data) > storage.MaxAsset {
				s.problem(w, 413, "too_large", "文件超过 50 MiB")
				return
			}
		case "sourceKind":
			if sourceSeen {
				s.problem(w, 400, "invalid_upload", "重复的 sourceKind")
				return
			}
			sourceSeen = true
			field, err := io.ReadAll(io.LimitReader(part, 32))
			if err != nil {
				s.uploadReadError(w, err)
				return
			}
			source = string(field)
		default:
			s.problem(w, 400, "invalid_upload", "未知上传字段")
			return
		}
		if err := part.Close(); err != nil {
			s.uploadReadError(w, err)
			return
		}
	}
	if !fileSeen || !sourceSeen || (source != "file" && source != "clipboard-image") {
		s.problem(w, 400, "invalid_upload", "缺少文件或有效 sourceKind")
		return
	}
	if _, err := value.Snapshot(); err != nil {
		s.operationError(w, err)
		return
	}
	asset, err := s.Workspace.StoreAsset(filename, source, data, time.Now())
	if err != nil {
		switch {
		case errors.Is(err, storage.ErrImage):
			s.problem(w, 400, "invalid_image", "截图载荷不是完整的 PNG、JPEG、WebP 或 GIF 图片")
		case errors.Is(err, storage.ErrAssetSize):
			s.problem(w, 413, "too_large", "资源超过大小限制，或图片超过 6400 万像素")
		default:
			s.operationError(w, err)
		}
		return
	}
	s.json(w, asset)
}

func (s *Server) uploadReadError(w http.ResponseWriter, err error) {
	var limit *http.MaxBytesError
	if errors.As(err, &limit) {
		s.problem(w, 413, "too_large", "上传请求超过 50 MiB 限制")
	} else {
		s.problem(w, 400, "invalid_upload", "上传请求不完整或格式无效")
	}
}

func (s *Server) asset(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	f, info, err := s.Workspace.OpenWorkspaceAsset(strings.TrimPrefix(r.URL.Path, "/note/"))
	if err != nil {
		s.operationError(w, err)
		return
	}
	defer func() {
		if err := f.Close(); err != nil {
			s.fail(err)
		}
	}()
	header := make([]byte, 512)
	n, err := f.Read(header)
	if err != nil && !errors.Is(err, io.EOF) {
		s.operationError(w, err)
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		s.operationError(w, err)
		return
	}
	format, imageErr := storage.BitmapFormat(f)
	var pathErr *os.PathError
	if errors.As(imageErr, &pathErr) {
		s.operationError(w, imageErr)
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		s.operationError(w, err)
		return
	}
	contentType := ""
	if imageErr == nil {
		contentType = "image/" + format
	}
	disposition := "inline"
	if contentType == "" {
		contentType = http.DetectContentType(header[:n])
		disposition = "attachment"
		if r.URL.Query().Get("preview") == "1" {
			switch strings.ToLower(filepath.Ext(info.Name())) {
			case ".pdf":
				if contentType == "application/pdf" {
					disposition = "inline"
				}
			case ".txt", ".log", ".csv", ".tsv", ".md", ".json":
				contentType = "text/plain; charset=utf-8"
				disposition = "inline"
			}
		}
	}
	if r.URL.Query().Get("download") == "1" {
		disposition = "attachment"
	}
	if disposition == "attachment" {
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": info.Name()}))
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
