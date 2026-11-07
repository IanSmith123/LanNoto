package exporter

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"lannoto/internal/storage"
)

func fixture(t *testing.T) *Exporter {
	t.Helper()
	pandoc, err := exec.LookPath("pandoc")
	if err != nil {
		t.Fatal("Pandoc is required for exporter integration tests:", err)
	}
	w, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := w.Close(); err != nil {
			t.Error(err)
		}
	})
	var data bytes.Buffer
	pic := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	pic.Set(0, 0, color.NRGBA{G: 160, A: 255})
	if err := png.Encode(&data, pic); err != nil {
		t.Fatal(err)
	}
	if _, err := w.StoreAsset("架构 图.png", "file", data.Bytes(), time.Now()); err != nil {
		t.Fatal(err)
	}
	return New(pandoc, w)
}

func TestRealDOCXContainsChineseTableCodeMathAndImage(t *testing.T) {
	e := fixture(t)
	if err := e.workspace.CreateFolder("资料"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.workspace.Relocate("static/架构 图.png", "资料/架构 图.png"); err != nil {
		t.Fatal(err)
	}
	markdown := "# 导出测试\n\n中文正文。\n\n| 名称 | 数值 |\n| --- | --- |\n| 中文 | 42 |\n\n- [x] 已完成\n\n```go\nfmt.Println(\"你好\")\n```\n\n$$\nE = mc^2\n$$\n\n![架构](%E8%B5%84%E6%96%99/%E6%9E%B6%E6%9E%84%20%E5%9B%BE.png)\n"
	result, err := e.Convert(context.Background(), markdown)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := result.Close(); err != nil {
			t.Error(err)
		}
	}()
	archive, err := zip.NewReader(result.File, result.Size)
	if err != nil {
		t.Fatal(err)
	}
	var document string
	media := 0
	for _, entry := range archive.File {
		if strings.HasPrefix(entry.Name, "word/media/") {
			media++
		}
		if entry.Name == "word/document.xml" {
			reader, err := entry.Open()
			if err != nil {
				t.Fatal(err)
			}
			data, readErr := io.ReadAll(reader)
			if err := errors.Join(readErr, reader.Close()); err != nil {
				t.Fatal(err)
			}
			document = string(data)
		}
	}
	for _, content := range []string{"中文正文", "w:tbl", "fmt.Println", "m:oMath", "w:drawing", "已完成"} {
		if !strings.Contains(document, content) {
			t.Fatalf("DOCX lacks %s", content)
		}
	}
	if media != 1 {
		t.Fatalf("DOCX media count: %d", media)
	}
}

func TestASTRejectsExternalTraversalDataAndRawHTML(t *testing.T) {
	e := fixture(t)
	for _, source := range []string{"![x](https://example.com/private.png)", "![x](../secret.png)", "![x](static/../secret.png)", "![x](static/%2e%2e%2fsecret.png)", "![x](file:///etc/passwd)", "![x](data:image/png;base64,AAAA)", "<img src=\"file:///etc/passwd\">", "![x](static/missing.png)"} {
		result, err := e.Convert(context.Background(), source)
		if result != nil {
			if closeErr := result.Close(); closeErr != nil {
				t.Error(closeErr)
			}
		}
		var validation *ValidationError
		if !errors.As(err, &validation) {
			t.Fatalf("unsafe source not rejected: %q %v", source, err)
		}
	}
}

func TestRawBreakTagsAreNotAnEditorCompatibilityFormat(t *testing.T) {
	e := fixture(t)
	for _, tag := range []string{"<br>", "<br/>", "<br />", "<BR />"} {
		_, err := e.Convert(context.Background(), "正文"+tag+"正文")
		var validation *ValidationError
		if !errors.As(err, &validation) {
			t.Fatalf("raw HTML accepted: %v", err)
		}
	}
	result, err := e.Convert(context.Background(), "第一行  \n第二行\n\n`<br />`\n")
	if err != nil {
		t.Fatal(err)
	}
	if err := result.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestConverterConcurrencyAndCancellation(t *testing.T) {
	e := fixture(t)
	e.slots <- struct{}{}
	e.slots <- struct{}{}
	if result, err := e.Convert(context.Background(), "正文"); !errors.Is(err, ErrBusy) || result != nil {
		t.Fatal("busy converter accepted work")
	}
	<-e.slots
	<-e.slots
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if result, err := e.Convert(ctx, "正文"); !errors.Is(err, context.Canceled) || result != nil {
		t.Fatalf("cancel ignored: %v", err)
	}
}

func TestMermaidImagesAreTemporaryAndBoundToSource(t *testing.T) {
	e := fixture(t)
	var pic bytes.Buffer
	if err := png.Encode(&pic, image.NewNRGBA(image.Rect(0, 0, 30, 20))); err != nil {
		t.Fatal(err)
	}
	source := "flowchart LR\nA-->B"
	markdown := "```mermaid\n" + source + "\n```\n"
	result, err := e.Convert(context.Background(), markdown, Diagram{Source: source, PNG: pic.Bytes()})
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(result.File, result.Size)
	if err != nil {
		t.Fatal(err)
	}
	images := 0
	for _, entry := range archive.File {
		if strings.HasPrefix(entry.Name, "word/media/") {
			images++
		}
	}
	if images != 1 {
		t.Fatalf("embedded image count %d", images)
	}
	if err := result.Close(); err != nil {
		t.Fatal(err)
	}
	for _, diagrams := range [][]Diagram{nil, {{Source: source, PNG: []byte("invalid PNG")}}, {{Source: "wrong source", PNG: pic.Bytes()}}, {{Source: source, PNG: pic.Bytes()}, {Source: "unused", PNG: pic.Bytes()}}} {
		_, err := e.Convert(context.Background(), markdown, diagrams...)
		var validation *ValidationError
		if !errors.As(err, &validation) {
			t.Fatalf("expected validation error: %v", err)
		}
	}
	entries, err := os.ReadDir(e.workspace.Temp)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("temporary files leaked: %v", entries)
	}
}
