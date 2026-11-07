package exporter

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"lannoto/internal/storage"
)

var ErrBusy = errors.New("DOCX converter is busy")
var ErrIO = errors.New("export filesystem error")

type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

type ConversionError struct {
	Stage    string
	ExitCode int
	Stderr   string
	Cause    error
}

func (e *ConversionError) Error() string {
	return fmt.Sprintf("Pandoc %s failed (exit %d): %v", e.Stage, e.ExitCode, e.Cause)
}
func (e *ConversionError) Unwrap() error { return e.Cause }

type Exporter struct {
	executable string
	workspace  *storage.Workspace
	slots      chan struct{}
}

func New(executable string, workspace *storage.Workspace) *Exporter {
	return &Exporter{executable: executable, workspace: workspace, slots: make(chan struct{}, 2)}
}

type Result struct {
	File      *os.File
	Size      int64
	directory string
}

func (r *Result) Close() error { return errors.Join(r.File.Close(), os.RemoveAll(r.directory)) }

func (e *Exporter) Convert(parent context.Context, markdown string, diagrams ...Diagram) (result *Result, resultErr error) {
	if _, err := exec.LookPath(e.executable); err != nil {
		method := "安装所在 Linux 发行版提供的 pandoc 软件包，或从官方安装页下载二进制包"
		if runtime.GOOS == "windows" {
			method = "运行 winget install --source winget --exact --id JohnMacFarlane.Pandoc，或下载安装 MSI"
		}
		if runtime.GOOS == "darwin" {
			method = "运行 brew install pandoc，或下载安装 PKG"
		}
		return nil, &ValidationError{Message: "Word 导出需要 Pandoc。请在运行 LanNoto 的主机上" + method + "。安装说明：https://pandoc.org/installing.html；安装后确认 PATH，或使用 --pandoc 指定路径。"}
	}
	select {
	case e.slots <- struct{}{}:
	default:
		return nil, ErrBusy
	}
	defer func() { <-e.slots }()
	ctx, cancel := context.WithTimeout(parent, 60*time.Second)
	defer cancel()
	directory, err := os.MkdirTemp(e.workspace.Temp, "docx-*")
	if err != nil {
		return nil, errors.Join(ErrIO, err)
	}
	defer func() {
		if resultErr != nil {
			if err := os.RemoveAll(directory); err != nil {
				resultErr = errors.Join(resultErr, ErrIO, err)
			}
		}
	}()
	var ast bytes.Buffer
	if err := e.run(ctx, directory, "parse", strings.NewReader(markdown), &ast, "--from=gfm+tex_math_dollars", "--to=json", "--sandbox"); err != nil {
		return nil, err
	}
	prepared, err := e.prepareAST(ast.Bytes())
	if err != nil {
		return nil, err
	}
	prepared, err = prepareDiagrams(ctx, directory, prepared, diagrams)
	if err != nil {
		if ctx.Err() != nil {
			return nil, &ConversionError{Stage: "diagrams", ExitCode: -1, Cause: ctx.Err()}
		}
		return nil, err
	}
	output := filepath.Join(directory, "document.docx")
	if err := e.run(ctx, directory, "docx", bytes.NewReader(prepared), io.Discard, "--from=json", "--to=docx", "--standalone", "--no-highlight", "--fail-if-warnings", "--resource-path=.", "--output="+output); err != nil {
		return nil, err
	}
	f, err := os.Open(output)
	if err != nil {
		return nil, errors.Join(ErrIO, err)
	}
	info, err := f.Stat()
	if err != nil {
		return nil, errors.Join(ErrIO, err, f.Close())
	}
	archive, err := zip.NewReader(f, info.Size())
	if err != nil {
		conversion := &ConversionError{Stage: "validate-output", ExitCode: 0, Cause: err}
		if closeErr := f.Close(); closeErr != nil {
			return nil, errors.Join(conversion, ErrIO, closeErr)
		}
		return nil, conversion
	}
	valid := false
	for _, entry := range archive.File {
		if entry.Name == "word/document.xml" && entry.UncompressedSize64 > 0 {
			valid = true
			break
		}
	}
	if !valid {
		conversion := &ConversionError{Stage: "validate-output", ExitCode: 0, Cause: errors.New("missing Word document")}
		if closeErr := f.Close(); closeErr != nil {
			return nil, errors.Join(conversion, ErrIO, closeErr)
		}
		return nil, conversion
	}
	return &Result{File: f, Size: info.Size(), directory: directory}, nil
}

func (e *Exporter) run(ctx context.Context, directory, stage string, input io.Reader, output io.Writer, args ...string) error {
	args = append(args, "--data-dir="+directory)
	command := exec.CommandContext(ctx, e.executable, args...)
	command.Dir = e.workspace.Notes
	command.Stdin = input
	command.Stdout = output
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		code := -1
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			code = exited.ExitCode()
		}
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return &ConversionError{Stage: stage, ExitCode: code, Stderr: stderr.String(), Cause: err}
	}
	return nil
}

func (e *Exporter) prepareAST(data []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	depth := 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("invalid Pandoc AST: %w", err)
		}
		if delim, ok := token.(json.Delim); ok {
			if delim == '{' || delim == '[' {
				depth++
				if depth > 256 {
					return nil, &ValidationError{Message: "文档结构嵌套过深，无法导出"}
				}
			} else {
				depth--
			}
		}
	}
	var document struct {
		Version []int                  `json:"pandoc-api-version"`
		Meta    map[string]interface{} `json:"meta"`
		Blocks  []interface{}          `json:"blocks"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, fmt.Errorf("decode Pandoc AST: %w", err)
	}
	if len(document.Version) == 0 || document.Blocks == nil {
		return nil, errors.New("Pandoc returned incomplete AST")
	}
	if err := e.walk(document.Meta); err != nil {
		return nil, err
	}
	if err := e.walk(document.Blocks); err != nil {
		return nil, err
	}
	return json.Marshal(document)
}

func (e *Exporter) walk(value interface{}) error {
	switch node := value.(type) {
	case map[string]interface{}:
		if kind, ok := node["t"].(string); ok {
			if kind == "RawBlock" || kind == "RawInline" {
				return &ValidationError{Message: "DOCX 导出不接受原始 HTML/XML；请使用标准 Markdown 内容"}
			}
			if kind == "Image" {
				content, ok := node["c"].([]interface{})
				if !ok || len(content) != 3 {
					return errors.New("invalid Pandoc Image content")
				}
				target, ok := content[2].([]interface{})
				if !ok || len(target) != 2 {
					return errors.New("invalid Pandoc Image target")
				}
				uri, ok := target[0].(string)
				if !ok {
					return errors.New("invalid Pandoc Image URI")
				}
				if err := e.validateImage(uri); err != nil {
					return err
				}
			}
		}
		for _, child := range node {
			if err := e.walk(child); err != nil {
				return err
			}
		}
	case []interface{}:
		for _, child := range node {
			if err := e.walk(child); err != nil {
				return err
			}
		}
	}
	return nil
}

func (e *Exporter) validateImage(uri string) error {
	parsed, err := url.Parse(uri)
	if err != nil || parsed.Scheme != "" || parsed.Host != "" || parsed.Opaque != "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return &ValidationError{Message: "导出图片只能引用工作区中的本地文件"}
	}
	name := parsed.Path
	f, _, err := e.workspace.OpenWorkspaceAsset(name)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, storage.ErrName) {
			return &ValidationError{Message: "本地图片不存在或路径无效：" + name}
		}
		return errors.Join(ErrIO, err)
	}
	_, imageErr := storage.BitmapFormat(f)
	if closeErr := f.Close(); closeErr != nil {
		return errors.Join(ErrIO, closeErr)
	}
	if imageErr != nil {
		var pathErr *os.PathError
		if errors.As(imageErr, &pathErr) {
			return errors.Join(ErrIO, imageErr)
		}
		return &ValidationError{Message: "无法解码本地位图：" + name}
	}
	return nil
}
