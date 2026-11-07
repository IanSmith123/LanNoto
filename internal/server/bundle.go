package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"

	"lannoto/internal/bundle"
	"lannoto/internal/storage"
)

func requestOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}
func (s *Server) workspaceExport(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	var input struct{}
	if err := readJSON(w, r, &input, 1024); err != nil {
		s.problem(w, 400, "invalid_export", "导出请求无效")
		return
	}
	markdown, err := s.Rooms.ArchiveMarkdown()
	if err != nil {
		s.operationError(w, err)
		return
	}
	result, err := s.Bundles.Workspace(r.Context(), markdown)
	if err != nil {
		s.bundleError(w, err)
		return
	}
	s.sendBundle(w, result)
}
func (s *Server) bundleError(w http.ResponseWriter, err error) {
	var validation *bundle.ValidationError
	switch {
	case errors.Is(err, storage.ErrIO):
		s.operationError(w, err)
	case errors.As(err, &validation):
		s.problem(w, 422, "invalid_resource", validation.Message)
	case errors.Is(err, context.Canceled):
		s.problem(w, 408, "export_cancelled", "打包导出已取消")
	case errors.Is(err, context.DeadlineExceeded):
		s.problem(w, 504, "export_timeout", "打包导出超过 60 秒，请缩小范围后重试")
	default:
		s.operationError(w, err)
	}
}
func (s *Server) sendBundle(w http.ResponseWriter, result *bundle.Result) {
	defer func() {
		if err := result.Close(); err != nil {
			s.fail(err)
		}
	}()
	w.Header().Set("Content-Type", result.ContentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": result.Filename}))
	w.Header().Set("Content-Length", strconv.FormatInt(result.Size, 10))
	if _, err := io.Copy(w, result.File); err != nil {
		slog.Debug("bundle download ended", "error", err)
	}
}
