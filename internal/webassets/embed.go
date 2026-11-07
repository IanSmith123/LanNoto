package webassets

import (
	"embed"
	"fmt"
	"io/fs"
	"strings"
)

//go:embed all:dist
var embedded embed.FS

func Open() (fs.FS, string, error) {
	assets, err := fs.Sub(embedded, "dist")
	if err != nil {
		return nil, "", err
	}
	index, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		return nil, "", fmt.Errorf("embedded index.html missing: %w", err)
	}
	if len(index) == 0 {
		return nil, "", fmt.Errorf("embedded index.html is empty")
	}
	id, err := fs.ReadFile(assets, "build-id.txt")
	if err != nil {
		return nil, "", err
	}
	build := strings.TrimSpace(string(id))
	if len(build) != 36 {
		return nil, "", fmt.Errorf("invalid embedded build ID")
	}
	return assets, build, nil
}
