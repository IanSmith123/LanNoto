package storage

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func testPNG(t *testing.T) []byte {
	t.Helper()
	var data bytes.Buffer
	picture := image.NewNRGBA(image.Rect(0, 0, 4, 3))
	picture.Set(0, 0, color.NRGBA{R: 40, G: 120, B: 180, A: 255})
	if err := png.Encode(&data, picture); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestBitmapFormatsKeepBytesAndChooseActualScreenshotExtension(t *testing.T) {
	w := workspace(t)
	picture := image.NewRGBA(image.Rect(0, 0, 4, 3))
	for y := 0; y < 3; y++ {
		for x := 0; x < 4; x++ {
			picture.SetRGBA(x, y, color.RGBA{R: uint8(x * 60), G: uint8(y * 80), B: 120, A: 255})
		}
	}
	var jpg, animated bytes.Buffer
	if err := jpeg.Encode(&jpg, picture, nil); err != nil {
		t.Fatal(err)
	}
	if err := gif.Encode(&animated, picture, nil); err != nil {
		t.Fatal(err)
	}
	webp, err := os.ReadFile("testdata/bitmap.webp")
	if err != nil {
		t.Fatal(err)
	}
	for _, sample := range []struct {
		name, extension string
		data            []byte
	}{
		{"原名.png", "png", testPNG(t)}, {"原名.jpeg", "jpg", jpg.Bytes()}, {"原名.gif", "gif", animated.Bytes()}, {"原名.webp", "webp", webp},
	} {
		t.Run(sample.extension, func(t *testing.T) {
			now := time.Date(2026, 10, 30, 9, 15, 30, 0, time.Local)
			file, err := w.StoreAsset(sample.name, "file", sample.data, now)
			if err != nil || file.Kind != "image" || file.Filename != sample.name {
				t.Fatalf("original file was changed or not decoded: %+v %v", file, err)
			}
			shot, err := w.StoreAsset("image.png", "clipboard-image", sample.data, now)
			if err != nil || shot.Kind != "image" || shot.Filename != "20261030091530."+sample.extension {
				t.Fatalf("incorrect actual format naming: %+v %v", shot, err)
			}
			for _, name := range []string{file.Filename, shot.Filename} {
				stored, err := os.ReadFile(filepath.Join(w.Static, name))
				if err != nil || !bytes.Equal(stored, sample.data) {
					t.Fatalf("resource bytes were changed: %s %v", name, err)
				}
			}
		})
	}
}

func TestOversizePixelHeaderIsRejectedBeforeDecodeAndPublication(t *testing.T) {
	w := workspace(t)
	data := testPNG(t)
	// Keep a valid PNG IHDR checksum while declaring dimensions far above the
	// allocation limit. No huge pixel buffer is constructed by this test.
	binary.BigEndian.PutUint32(data[16:20], 65535)
	binary.BigEndian.PutUint32(data[20:24], 65535)
	binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))
	for _, source := range []string{"file", "clipboard-image"} {
		if _, err := w.StoreAsset("too-many-pixels.png", source, data, time.Now()); !errors.Is(err, ErrAssetSize) {
			t.Fatalf("oversize dimensions not rejected: %s %v", source, err)
		}
	}
	entries, err := os.ReadDir(w.Static)
	if err != nil || len(entries) != 0 {
		t.Fatalf("rejected image published a resource: %v %v", entries, err)
	}
}

func TestAssetSourcesPreserveNamesAndBytes(t *testing.T) {
	w := workspace(t)
	data := testPNG(t)
	now := time.Date(2026, 10, 30, 9, 15, 30, 0, time.FixedZone("CST", 8*60*60))
	for _, name := range []string{"image.png", "架构 图 (1).png"} {
		asset, err := w.StoreAsset(name, "file", data, now)
		if err != nil {
			t.Fatal(err)
		}
		if asset.Filename != name || asset.Kind != "image" || asset.URL[:7] != "static/" {
			t.Fatal(asset)
		}
		f, _, err := w.OpenAsset(name)
		if err != nil {
			t.Fatal(err)
		}
		stored, readErr := io.ReadAll(f)
		if err := errors.Join(readErr, f.Close()); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(stored, data) {
			t.Fatal("image bytes were transcoded")
		}
	}
	shot, err := w.StoreAsset("image.png", "clipboard-image", data, now)
	if err != nil {
		t.Fatal(err)
	}
	if shot.Filename != "20261030091530.png" {
		t.Fatal(shot)
	}
	if _, err := w.StoreAsset("image.png", "clipboard-image", data, now); !errors.Is(err, os.ErrExist) {
		t.Fatalf("screenshot conflict was hidden: %v", err)
	}
	attachment, err := w.StoreAsset("需求 说明.pdf", "file", []byte("%PDF-1.7\nexample"), now)
	if err != nil {
		t.Fatal(err)
	}
	if attachment.Filename != "需求 说明.pdf" || attachment.Kind != "attachment" {
		t.Fatal(attachment)
	}
	for _, name := range []string{"test.svg", "test.html", "test.js"} {
		asset, err := w.StoreAsset(name, "file", []byte("<svg onload='alert(1)'></svg>"), now)
		if err != nil {
			t.Fatal(err)
		}
		if asset.Kind != "attachment" {
			t.Fatalf("active content previewed: %+v", asset)
		}
	}
	if _, err := w.StoreAsset("fake.png", "clipboard-image", []byte("not an image"), now); !errors.Is(err, ErrImage) {
		t.Fatalf("invalid screenshot accepted: %v", err)
	}
}

func TestConcurrentAssetCollisionNeverOverwrites(t *testing.T) {
	w := workspace(t)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, data := range []string{"first", "second"} {
		wg.Add(1)
		go func(data string) {
			defer wg.Done()
			_, err := w.StoreAsset("same.txt", "file", []byte(data), time.Now())
			results <- err
		}(data)
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, os.ErrExist) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflict)
	}
	data, err := os.ReadFile(filepath.Join(w.Static, "same.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "first" && string(data) != "second" {
		t.Fatal("partial asset published")
	}
}
