package bundle

import (
	"bytes"
	"errors"
	"html"
	"sort"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

type reference struct {
	uri        string
	start, end int
}

func references(markdown string) ([]reference, error) {
	source := []byte(markdown)
	doc := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser().Parse(text.NewReader(source))
	result := []reference{}
	used := map[string]bool{}
	var visit func(ast.Node) (int, error)
	visit = func(node ast.Node) (int, error) {
		end := node.Pos()
		if text, ok := node.(*ast.Text); ok {
			end = text.Segment.Stop
		}
		for child := node.FirstChild(); child != nil; child = child.NextSibling() {
			childEnd, err := visit(child)
			if err != nil {
				return 0, err
			}
			if childEnd > end {
				end = childEnd
			}
		}
		var destination []byte
		var title []byte
		isReference := false
		switch value := node.(type) {
		case *ast.Image:
			destination = value.Destination
			title = value.Title
			isReference = value.Reference != nil
		case *ast.Link:
			destination = value.Destination
			title = value.Title
			isReference = value.Reference != nil
		}
		if len(destination) == 0 {
			return end, nil
		}
		raw := string(destination)
		used[raw] = true
		if isReference {
			return end, nil
		}
		start := max(end, node.Pos())
		if start < 0 || start > len(source) {
			return 0, errors.New("Markdown link position is unavailable")
		}
		offset := bytes.Index(source[start:], destination)
		if offset < 0 {
			return 0, errors.New("Markdown destination position is unavailable")
		}
		start += offset
		stop := start + len(destination)
		result = append(result, reference{html.UnescapeString(string(util.UnescapePunctuations(destination))), start, stop})
		// A parent's destination follows the entire child link, including its
		// optional title. A title may itself contain the parent's URL.
		childEnd := stop
		if len(title) > 0 {
			if offset := bytes.Index(source[childEnd:], title); offset >= 0 {
				childEnd += offset + len(title)
			}
		}
		return childEnd, nil
	}
	if _, err := visit(doc); err != nil {
		return nil, err
	}
	err := ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		definition, ok := node.(*ast.LinkReferenceDefinition)
		if !ok {
			return ast.WalkContinue, nil
		}
		_, exists := used[string(definition.Destination)]
		if !exists {
			return ast.WalkContinue, nil
		}
		start := definition.Pos()
		if start < 0 {
			return ast.WalkStop, errors.New("Markdown reference position is unavailable")
		}
		label := bytes.Index(source[start:], definition.Label)
		if label < 0 {
			return ast.WalkStop, errors.New("Markdown reference label is unavailable")
		}
		start += label + len(definition.Label)
		offset := bytes.Index(source[start:], definition.Destination)
		if offset < 0 {
			return ast.WalkStop, errors.New("Markdown reference destination is unavailable")
		}
		start += offset
		result = append(result, reference{html.UnescapeString(string(util.UnescapePunctuations(definition.Destination))), start, start + len(definition.Destination)})
		return ast.WalkContinue, nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(result, func(i, j int) bool { return result[i].start < result[j].start })
	return result, nil
}
