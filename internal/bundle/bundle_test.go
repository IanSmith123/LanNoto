package bundle

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lannoto/internal/storage"
)

func workspace(t *testing.T) *storage.Workspace {
	t.Helper()
	w, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := w.Close(); err != nil {
			t.Error(err)
		}
	})
	return w
}
func files(t *testing.T, result *Result) map[string]string {
	t.Helper()
	defer func() {
		if err := result.Close(); err != nil {
			t.Error(err)
		}
	}()
	archive, err := zip.NewReader(result.File, result.Size)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, entry := range archive.File {
		reader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		if err := errors.Join(err, reader.Close()); err != nil {
			t.Fatal(err)
		}
		if _, exists := out[entry.Name]; exists {
			t.Fatal("duplicate ZIP member")
		}
		out[entry.Name] = string(data)
	}
	return out
}
func TestNoteBundlesOnlyParsedReferencesWithoutChangingOriginal(t *testing.T) {
	w := workspace(t)
	for name, data := range map[string]string{"图 one.png": "image bytes", "data.txt": "attachment bytes", "unused.txt": "not referenced"} {
		if err := os.WriteFile(filepath.Join(w.Static, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	markdown := "# 原文\r\n\r\n![static/图%20one.png](<static/图%20one.png>)\r\n\r\n[附件][ref]\r\n\r\n[ref]: ./static/data.txt \"title\"\r\n\r\n```md\n![ignored](static/not-present.png)\n```\n"
	if err := w.Create("原文.md", markdown); err != nil {
		t.Fatal(err)
	}
	result, err := New(w).Note(context.Background(), "原文.md", markdown, "http://app.example")
	if err != nil {
		t.Fatal(err)
	}
	if result.Filename != "原文.zip" {
		t.Fatal(result.Filename)
	}
	archive := files(t, result)
	if len(archive) != 3 || archive["static/图 one.png"] != "image bytes" || archive["static/data.txt"] != "attachment bytes" {
		t.Fatalf("wrong members: %v", archive)
	}
	if !strings.Contains(archive["原文.md"], "[ref]: static/data.txt") || !strings.Contains(archive["原文.md"], "![ignored](static/not-present.png)") {
		t.Fatal("rewrote code or lost reference definition")
	}
	original, err := w.ReadNote("原文.md")
	if err != nil || string(original) != markdown {
		t.Fatal("export changed original Markdown", err)
	}
}
func TestNoAssetsReturnsExactMarkdownAndMissingResourceFails(t *testing.T) {
	w := workspace(t)
	exporter := New(w)
	body := "#   Precise\r\n\r\n* a\r\n\r\n"
	result, err := exporter.Note(context.Background(), "plain.md", body, "http://app.example")
	if err != nil {
		t.Fatal(err)
	}
	if result.Filename != "plain.md" || !strings.HasPrefix(result.ContentType, "text/markdown") {
		t.Fatal("unnecessary ZIP")
	}
	data, err := io.ReadAll(result.File)
	if err := errors.Join(err, result.Close()); err != nil {
		t.Fatal(err)
	}
	if string(data) != body {
		t.Fatal("plain export changed bytes")
	}
	for _, uri := range []string{"static/missing.png", "../outside.txt", "%2e%2e/outside.txt", "/etc/passwd"} {
		_, err := exporter.Note(context.Background(), "plain.md", "![x]("+uri+")", "http://app.example")
		var invalid *ValidationError
		if !errors.As(err, &invalid) {
			t.Fatalf("unsafe/missing reference accepted %q: %v", uri, err)
		}
	}
	entries, err := os.ReadDir(w.Temp)
	if err != nil || len(entries) != 0 {
		t.Fatal("failed export left files", err)
	}
}
func TestWorkspaceContainsNotesAndResourcesButExcludesPersistentHistory(t *testing.T) {
	w := workspace(t)
	if err := w.Create("a.md", "old"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.SaveHistory("a.md", "old", 1, "manual", "Tom", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(w.Notes, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.Notes, "nested", "file.bin"), []byte("binary"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := New(w).Workspace(context.Background(), map[string]string{"a.md": "current accepted Markdown"})
	if err != nil {
		t.Fatal(err)
	}
	archive := files(t, result)
	if archive["note/a.md"] != "current accepted Markdown" || archive["note/nested/file.bin"] != "binary" {
		t.Fatal(archive)
	}
	for name := range archive {
		if !strings.HasPrefix(name, "note/") {
			t.Fatalf("unexpected metadata entry %s", name)
		}
	}
}

func TestRemoteReferencesArePreservedWithoutAnyNetworkDownload(t *testing.T) {
	w := workspace(t)
	markdown := "![remote](https://files.example/image.png)\n\n[attachment](http://127.0.0.1/private.pdf)\n"
	result, err := New(w).Note(context.Background(), "a.md", markdown, "http://app.example")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(result.ContentType, "text/markdown") {
		t.Fatal("remote-only note unexpectedly produced a ZIP")
	}
	data, err := io.ReadAll(result.File)
	if err := errors.Join(err, result.Close()); err != nil {
		t.Fatal(err)
	}
	if string(data) != markdown {
		t.Fatal("remote references changed")
	}
}

func TestNestedNoteBundleKeepsImagesRelativeToNote(t *testing.T) {
	w := workspace(t)
	if err := w.CreateFolder("专题"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.Static, "图.png"), []byte("image"), 0600); err != nil {
		t.Fatal(err)
	}
	bundle, err := New(w).Note(context.Background(), "专题/图示.md", "![图](static/图.png)\n", "http://app.example")
	if err != nil {
		t.Fatal(err)
	}
	if bundle.Filename != "图示.zip" {
		t.Fatal(bundle.Filename)
	}
	archive := files(t, bundle)
	if archive["static/图.png"] != "image" || !strings.Contains(archive["专题/图示.md"], "../static/%E5%9B%BE.png") {
		t.Fatalf("nested note lost its image reference: %v", archive)
	}
}

func TestNestedImageTitleDoesNotCaptureParentDestination(t *testing.T) {
	source := `[![image](static/image.png "https://local.test/note/static/file.txt")](https://local.test/note/static/file.txt)`
	refs, err := references(source)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 {
		t.Fatalf("references: %#v", refs)
	}
	if refs[1].start != strings.LastIndex(source, "https://local.test/note/static/file.txt") {
		t.Fatalf("parent matched child title: %#v", refs)
	}
}
