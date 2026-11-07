package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"

	"lannoto/internal/exporter"
)

func (s *Server) exportSnapshot(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	var input struct {
		Revision uint64 `json:"revision"`
	}
	if err := readJSON(w, r, &input, 1024); err != nil || input.Revision > 9007199254740991 {
		s.problem(w, 400, "invalid_export", "导出请求无效")
		return
	}
	value, err := s.Rooms.Get(r.PathValue("name"))
	if err != nil {
		s.operationError(w, err)
		return
	}
	snapshot, err := value.Export(input.Revision)
	if err != nil {
		s.operationError(w, err)
		return
	}
	s.json(w, snapshot)
}

func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	var input struct {
		Format   string             `json:"format"`
		Diagrams []exporter.Diagram `json:"diagrams,omitempty"`
		Revision uint64             `json:"revision"`
	}
	if err := readJSON(w, r, &input, 16<<20); err != nil || input.Revision > 9007199254740991 {
		s.problem(w, 400, "invalid_export", "导出请求无效")
		return
	}
	if input.Format != "markdown" && input.Format != "docx" && input.Format != "print" && input.Format != "bundle" {
		s.problem(w, 400, "invalid_format", "仅支持 markdown、docx、print")
		return
	}
	if len(input.Diagrams) > 0 && input.Format != "docx" {
		s.problem(w, 400, "invalid_export", "Mermaid 图片仅用于 Word 导出")
		return
	}
	value, err := s.Rooms.Get(r.PathValue("name"))
	if err != nil {
		s.operationError(w, err)
		return
	}
	snapshot, err := value.Export(input.Revision)
	if err != nil {
		s.operationError(w, err)
		return
	}
	if input.Format == "print" {
		s.json(w, snapshot)
		return
	}
	if input.Format == "bundle" {
		result, err := s.Bundles.Note(r.Context(), snapshot.Filename, snapshot.Markdown, requestOrigin(r))
		if err != nil {
			s.bundleError(w, err)
			return
		}
		s.sendBundle(w, result)
		return
	}
	if input.Format == "markdown" {
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": path.Base(snapshot.Filename)}))
		w.Header().Set("Content-Length", strconv.Itoa(len(snapshot.Markdown)))
		if _, err := io.WriteString(w, snapshot.Markdown); err != nil {
			slog.Debug("Markdown download ended", "error", err)
		}
		return
	}
	result, err := s.Exporter.Convert(r.Context(), snapshot.Markdown, input.Diagrams...)
	if err != nil {
		var validation *exporter.ValidationError
		var conversion *exporter.ConversionError
		switch {
		case errors.Is(err, exporter.ErrIO):
			s.operationError(w, err)
		case errors.Is(err, exporter.ErrBusy):
			s.problem(w, 503, "export_busy", "已有两个 Word 转换任务，请稍后重试")
		case errors.As(err, &validation):
			s.problem(w, 422, "invalid_resource", validation.Message)
		case errors.As(err, &conversion):
			slog.Warn("DOCX conversion ended", "filename", snapshot.Filename, "stage", conversion.Stage, "exit_code", conversion.ExitCode, "stderr", conversion.Stderr)
			status := 422
			message := "Word 转换失败，请查看主机日志。"
			if errors.Is(conversion.Cause, context.DeadlineExceeded) {
				status = 504
				message = "Word 转换超过 60 秒，已停止。"
			}
			if errors.Is(conversion.Cause, context.Canceled) {
				status = 408
				message = "Word 转换已取消。"
			}
			s.problem(w, status, "export_failed", message)
		default:
			s.operationError(w, err)
		}
		return
	}
	defer func() {
		if err := result.Close(); err != nil {
			s.fail(err)
		}
	}()
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": strings.TrimSuffix(path.Base(snapshot.Filename), ".md") + ".docx"}))
	w.Header().Set("Content-Length", strconv.FormatInt(result.Size, 10))
	if _, err := io.Copy(w, result.File); err != nil {
		slog.Debug("DOCX download ended", "error", err)
	}
}
