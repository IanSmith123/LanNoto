package exporter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"

	"lannoto/internal/storage"
)

type Diagram struct {
	Source string `json:"source"`
	PNG    []byte `json:"png"`
}

func diagramKey(source string) string {
	return strings.TrimSpace(strings.ReplaceAll(source, "\r\n", "\n"))
}

// Replace only validated Mermaid CodeBlock nodes in the temporary Pandoc AST.
// The original Markdown and workspace assets are never written.
func prepareDiagrams(ctx context.Context, directory string, data []byte, diagrams []Diagram) ([]byte, error) {
	if len(diagrams) > 32 {
		return nil, &ValidationError{"Word 最多导出 32 幅 Mermaid 图表"}
	}
	supplied := make(map[string]Diagram, len(diagrams))
	total := 0
	for _, diagram := range diagrams {
		total += len(diagram.PNG)
		key := diagramKey(diagram.Source)
		if key == "" || len(diagram.Source) > 200000 || len(diagram.PNG) == 0 || len(diagram.PNG) > 2<<20 || total > 8<<20 {
			return nil, &ValidationError{"Mermaid 图片为空或超过导出大小限制"}
		}
		if _, exists := supplied[key]; exists {
			return nil, &ValidationError{"Mermaid 图片重复"}
		}
		supplied[key] = diagram
	}
	var ast interface{}
	if err := json.Unmarshal(data, &ast); err != nil {
		return nil, err
	}
	used := map[string]string{}
	widths := map[string]string{}
	pixels := int64(0)
	var walk func(interface{}) error
	walk = func(value interface{}) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		switch node := value.(type) {
		case map[string]interface{}:
			if node["t"] == "CodeBlock" {
				content, ok := node["c"].([]interface{})
				if !ok || len(content) != 2 {
					return errors.New("invalid Pandoc code block")
				}
				attrs, ok := content[0].([]interface{})
				if !ok || len(attrs) != 3 {
					return errors.New("invalid Pandoc code attributes")
				}
				classes, ok := attrs[1].([]interface{})
				if !ok {
					return errors.New("invalid Pandoc code classes")
				}
				mermaid := false
				for _, class := range classes {
					if name, ok := class.(string); ok && strings.EqualFold(name, "mermaid") {
						mermaid = true
					}
				}
				if mermaid {
					source, ok := content[1].(string)
					if !ok {
						return errors.New("invalid Mermaid code")
					}
					key := diagramKey(source)
					diagram, exists := supplied[key]
					if !exists {
						return &ValidationError{"Mermaid 图表需要先在浏览器渲染，再导出 Word"}
					}
					imagePath, exists := used[key]
					if !exists {
						config, err := png.DecodeConfig(bytes.NewReader(diagram.PNG))
						if err != nil {
							return &ValidationError{"Mermaid 图片必须是有效 PNG"}
						}
						size := int64(config.Width) * int64(config.Height)
						pixels += size
						if size <= 0 || size > 16000000 || pixels > 32000000 {
							return &ValidationError{"Mermaid 图片像素超过限制"}
						}
						format, err := storage.BitmapFormat(bytes.NewReader(diagram.PNG))
						if err != nil || format != "png" {
							return &ValidationError{"Mermaid 图片无法解码"}
						}
						imagePath = filepath.Join(directory, fmt.Sprintf("mermaid-%d.png", len(used)+1))
						if err := os.WriteFile(imagePath, diagram.PNG, 0600); err != nil {
							return errors.Join(ErrIO, err)
						}
						used[key] = imagePath
						width := math.Min(6, float64(config.Width)/192)
						width = math.Min(width, 8*float64(config.Width)/float64(config.Height))
						widths[key] = fmt.Sprintf("%.3fin", width)
					}
					image := map[string]interface{}{"t": "Image", "c": []interface{}{[]interface{}{"", []interface{}{}, []interface{}{[]interface{}{"width", widths[key]}}}, []interface{}{map[string]interface{}{"t": "Str", "c": "Mermaid"}}, []interface{}{filepath.ToSlash(imagePath), ""}}}
					node["t"] = "Para"
					node["c"] = []interface{}{image}
					return nil
				}
			}
			for _, child := range node {
				if err := walk(child); err != nil {
					return err
				}
			}
		case []interface{}:
			for _, child := range node {
				if err := walk(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(ast); err != nil {
		return nil, err
	}
	if len(used) != len(supplied) {
		return nil, &ValidationError{"Mermaid 图片与导出快照不匹配，请重试"}
	}
	return json.Marshal(ast)
}
