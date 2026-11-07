package server

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"testing/fstest"
	"time"

	"lannoto/internal/room"
	"lannoto/internal/storage"
)

func TestExpectedInputErrorCannotHideJoinedIOFailure(t *testing.T) {
	name := fmt.Errorf("storage operation: %w", &os.PathError{Op: "open", Path: "name", Err: syscall.ENAMETOOLONG})
	for _, sample := range []struct {
		name   string
		err    error
		status int
		fatal  bool
	}{
		{"native-name", name, 400, false},
		{"conflict", fmt.Errorf("publish: %w", os.ErrExist), 409, false},
		{"name-and-cleanup", errors.Join(name, errors.New("cleanup failed")), 500, true},
		{"conflict-and-cleanup", errors.Join(os.ErrExist, errors.New("cleanup failed")), 500, true},
		{"missing-and-close", errors.Join(os.ErrNotExist, os.ErrPermission), 500, true},
		{"validation-and-close", errors.Join(storage.ErrName, os.ErrPermission), 500, true},
		{"persistence-and-missing", errors.Join(storage.ErrIO, os.ErrNotExist), 500, true},
		{"persistence-and-name", errors.Join(storage.ErrIO, name), 500, true},
		{"room-and-close", errors.Join(&room.InputError{Code: "not_found", Message: "missing"}, os.ErrPermission), 500, true},
	} {
		t.Run(sample.name, func(t *testing.T) {
			s := New(nil, nil, nil, "build", "password", "pandoc")
			response := httptest.NewRecorder()
			s.operationError(response, sample.err)
			if response.Code != sample.status {
				t.Fatalf("wrong classification: %d %s", response.Code, response.Body.String())
			}
			select {
			case err := <-s.Fatal:
				if !sample.fatal || err != sample.err {
					t.Fatalf("unexpected fatal error: %v", err)
				}
			default:
				if sample.fatal {
					t.Fatal("joined I/O failure did not stop the service")
				}
			}
		})
	}
}

func TestStaticTreeAndPreview(t *testing.T) {
	workspace, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()
	dir := filepath.Join(workspace.Static, "资料")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"文字.txt":  "<script>alert(1)</script>",
		"报告.pdf":  "%PDF-1.7\n",
		"页面.html": "<script>alert(1)</script>",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	handler := New(workspace, nil, fstest.MapFS{}, "test-build", "test-password", "pandoc").Handler()
	login := httptest.NewRequest(http.MethodPost, "http://example.test/api/session", strings.NewReader(`{"password":"test-password"}`))
	login.Header.Set("Origin", "http://example.test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, login)
	cookies := response.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatalf("login returned %d", response.Code)
	}
	get := func(path string, authenticated bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "http://example.test"+path, nil)
		if authenticated {
			req.AddCookie(cookies[0])
		}
		result := httptest.NewRecorder()
		handler.ServeHTTP(result, req)
		return result
	}
	tree := get("/api/workspace/tree", true)
	if tree.Code != http.StatusOK || !strings.Contains(tree.Body.String(), `"path":"static/资料/文字.txt","folder":false,"asset":true`) {
		t.Fatalf("asset tree: %d %s", tree.Code, tree.Body.String())
	}
	base := "/note/static/" + url.PathEscape("资料") + "/"
	if got := get(base+url.PathEscape("文字.txt")+"?preview=1", false); got.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated preview: %d", got.Code)
	}
	for _, sample := range []struct {
		name, query, disposition, contentType string
	}{
		{"文字.txt", "?preview=1", "inline", "text/plain; charset=utf-8"},
		{"报告.pdf", "?preview=1", "inline", "application/pdf"},
		{"报告.pdf", "?preview=1&download=1", "attachment", "application/pdf"},
		{"页面.html", "?preview=1", "attachment", "text/html; charset=utf-8"},
	} {
		got := get(base+url.PathEscape(sample.name)+sample.query, true)
		if got.Code != http.StatusOK || !strings.HasPrefix(got.Header().Get("Content-Disposition"), sample.disposition) ||
			got.Header().Get("Content-Type") != sample.contentType || got.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("asset %s: %d, %v", sample.name, got.Code, got.Header())
		}
	}
	if got := get(base+"%2e%2e%2f%2e%2e%2foutside.txt?preview=1", true); got.Code != http.StatusBadRequest {
		t.Fatalf("asset traversal: %d", got.Code)
	}
}

type panicAssets struct{}

func (panicAssets) Open(string) (fs.File, error) { panic("test asset read panic") }

func TestHandlerPanicBecomesFatalAndStopsServing(t *testing.T) {
	s := New(nil, nil, panicAssets{}, "test-build", "test-password", "unused-pandoc")
	handler := s.Handler()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://example.test/note/", nil))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("panic response: %d", response.Code)
	}
	select {
	case err := <-s.Fatal:
		if !strings.Contains(err.Error(), "test asset read panic") || !strings.Contains(err.Error(), "goroutine") {
			t.Fatalf("fatal panic lacks error or stack: %v", err)
		}
	default:
		t.Fatal("handler panic was swallowed without notifying process owner")
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://example.test/api/config", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatal("server kept serving after internal panic")
	}
}

func TestSessionCookieExpiryAndPeerCancellation(t *testing.T) {
	s := New(nil, nil, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("LanNoto")}}, "test-build", "test-password", "unused-pandoc")
	handler := s.Handler()
	login := httptest.NewRequest(http.MethodPost, "http://example.test/api/session", strings.NewReader(`{"password":"test-password"}`))
	login.Header.Set("Origin", "http://example.test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, login)
	if response.Code != http.StatusOK {
		t.Fatalf("login: %d %s", response.Code, response.Body.String())
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("session cookies: %d", len(cookies))
	}
	cookie := cookies[0]
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.Secure || cookie.MaxAge != 8*60*60 {
		t.Fatalf("invalid HTTP session cookie attributes: %+v", cookie)
	}
	if cookie.Value == "" || cookie.Value == "test-password" {
		t.Fatal("session token is missing or is the password")
	}
	cancelled := false
	peer := room.NewPeer(1, func() { cancelled = true })
	s.mu.Lock()
	session := s.sessions[cookie.Value]
	session.expires = time.Now().Add(-time.Second)
	session.peers[peer] = struct{}{}
	s.mu.Unlock()
	request := httptest.NewRequest(http.MethodGet, "http://example.test/api/session", nil)
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || !cancelled {
		t.Fatal("expired session did not reject access and cancel its peers")
	}
	if _, exists := s.sessions[cookie.Value]; exists {
		t.Fatal("expired session was retained")
	}
}
