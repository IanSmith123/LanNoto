package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
	"lannoto/internal/bundle"
	"lannoto/internal/exporter"
	"lannoto/internal/room"
	"lannoto/internal/storage"
)

type session struct {
	id      string
	expires time.Time
	peers   map[*room.Peer]struct{}
}

type Server struct {
	Workspace *storage.Workspace
	Rooms     *room.Manager
	BuildID   string
	assets    fs.FS
	password  [32]byte
	mu        sync.Mutex
	sessions  map[string]*session
	Fatal     chan error
	dead      atomic.Bool
	closing   atomic.Bool
	socketWG  sync.WaitGroup
	Exporter  *exporter.Exporter
	Bundles   *bundle.Exporter
}

func New(workspace *storage.Workspace, rooms *room.Manager, assets fs.FS, buildID, password, pandoc string) *Server {
	return &Server{Workspace: workspace, Rooms: rooms, assets: assets, BuildID: buildID, password: sha256.Sum256([]byte(password)), sessions: make(map[string]*session), Fatal: make(chan error, 1), Exporter: exporter.New(pandoc, workspace), Bundles: bundle.New(workspace)}
}

func (s *Server) fail(err error) {
	if s.dead.CompareAndSwap(false, true) {
		s.Fatal <- err
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) { s.json(w, map[string]string{"buildId": s.BuildID}) })
	mux.HandleFunc("GET /api/session", func(w http.ResponseWriter, r *http.Request) {
		if s.require(w, r) != nil {
			s.json(w, map[string]bool{"authenticated": true})
		}
	})
	mux.HandleFunc("POST /api/session", s.login)
	mux.HandleFunc("DELETE /api/session", s.logout)
	mux.HandleFunc("GET /api/notes", s.list)
	mux.HandleFunc("POST /api/notes", s.create)
	mux.HandleFunc("GET /api/workspace/tree", s.tree)
	mux.HandleFunc("POST /api/workspace/folders", s.createFolder)
	mux.HandleFunc("POST /api/workspace/rename", s.renameEntry)
	mux.HandleFunc("POST /api/workspace/move", s.moveEntry)
	mux.HandleFunc("GET /api/notes/{name}", s.note)
	mux.HandleFunc("GET /api/notes/{name}/ws", s.connect)
	mux.HandleFunc("POST /api/notes/{name}/assets", s.upload)
	mux.HandleFunc("GET /note/static/{name...}", s.asset)
	mux.HandleFunc("POST /api/notes/{name}/export", s.export)
	mux.HandleFunc("POST /api/notes/{name}/export/snapshot", s.exportSnapshot)
	mux.HandleFunc("POST /api/workspace/export", s.workspaceExport)
	mux.HandleFunc("GET /api/notes/{name}/history", s.history)
	mux.HandleFunc("POST /api/notes/{name}/history", s.checkpoint)
	mux.HandleFunc("GET /api/notes/{name}/history/{id}", s.historyEntry)
	mux.HandleFunc("POST /api/notes/{name}/history/{id}/restore", s.restore)
	mux.Handle("GET /assets/", http.FileServerFS(s.assets))
	mux.HandleFunc("GET /note/", s.page)
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/note/", http.StatusFound) })
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if value := recover(); value != nil {
				s.fail(fmt.Errorf("HTTP handler panic: %v\n%s", value, debug.Stack()))
				http.Error(w, "fatal internal error", 500)
			}
		}()
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		if s.dead.Load() {
			http.Error(w, "service stopped", 503)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && !sameOrigin(r) {
			s.problem(w, 403, "origin_mismatch", "仅允许同源请求")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func sameOrigin(r *http.Request) bool {
	origin, err := url.Parse(r.Header.Get("Origin"))
	if err != nil || origin.Host == "" {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return origin.Scheme == scheme && strings.EqualFold(origin.Host, r.Host) && origin.User == nil && origin.Path == "" && origin.RawQuery == "" && origin.Fragment == ""
}

func readJSON(w http.ResponseWriter, r *http.Request, target interface{}, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	if !utf8.Valid(data) {
		return errors.New("JSON must be UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(interface{})); !errors.Is(err, io.EOF) {
		return errors.New("expected one JSON object")
	}
	return nil
}

func (s *Server) json(w http.ResponseWriter, value interface{}) {
	data, err := json.Marshal(value)
	if err != nil {
		s.fail(fmt.Errorf("encode response: %w", err))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if _, err = w.Write(data); err != nil {
		slog.Debug("client response write ended", "error", err)
	}
}

func (s *Server) problem(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	s.json(w, map[string]string{"code": code, "message": message})
}

func (s *Server) operationError(w http.ResponseWriter, err error) {
	var input *room.InputError
	switch {
	case errors.As(err, &input) && allCausesMatch(err, func(cause error) bool { _, ok := cause.(*room.InputError); return ok }):
		status := 409
		if input.Code == "not_found" {
			status = 404
		}
		s.problem(w, status, input.Code, input.Message)
	case allCausesMatch(err, func(cause error) bool { return errors.Is(cause, storage.ErrName) }):
		s.problem(w, 400, "invalid_filename", err.Error())
	case allCausesMatch(err, nativeFilenameError):
		s.problem(w, 400, "invalid_filename", "当前文件系统不接受该文件名或路径，请缩短或修改文件名。")
	case allCausesMatch(err, func(cause error) bool { return errors.Is(cause, storage.ErrMarkdown) }):
		s.problem(w, 400, "invalid_markdown", "Markdown 必须是有效 UTF-8 文本，且不能超过 1 MiB")
	case allCausesMatch(err, func(cause error) bool { return errors.Is(cause, os.ErrNotExist) }):
		s.problem(w, 404, "not_found", "文件不存在")
	case allCausesMatch(err, func(cause error) bool { return errors.Is(cause, os.ErrExist) }):
		s.problem(w, 409, "already_exists", "同名文件已存在")
	default:
		s.fail(err)
		s.problem(w, 500, "fatal", "服务内部错误，已停止")
	}
}

func (s *Server) current(r *http.Request) *session {
	cookie, err := r.Cookie("lannoto_session")
	if err != nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.sessions[cookie.Value]
	if !ok {
		return nil
	}
	if !time.Now().Before(value.expires) {
		delete(s.sessions, cookie.Value)
		for p := range value.peers {
			p.Cancel()
		}
		return nil
	}
	return value
}

func (s *Server) require(w http.ResponseWriter, r *http.Request) *session {
	value := s.current(r)
	if value == nil {
		s.problem(w, 401, "unauthorized", "请登录，或当前会话已过期")
	}
	return value
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if s.closing.Load() {
		s.problem(w, 503, "closing", "服务正在关闭")
		return
	}
	var input struct {
		Password string `json:"password"`
	}
	if err := readJSON(w, r, &input, 4096); err != nil {
		s.problem(w, 400, "invalid_request", "登录请求无效")
		return
	}
	provided := sha256.Sum256([]byte(input.Password))
	if subtle.ConstantTimeCompare(provided[:], s.password[:]) != 1 {
		s.problem(w, 401, "unauthorized", "密码错误")
		return
	}
	token := rand.Text()
	expires := time.Now().Add(8 * time.Hour)
	s.mu.Lock()
	for key, value := range s.sessions {
		if !time.Now().Before(value.expires) {
			delete(s.sessions, key)
			for p := range value.peers {
				p.Cancel()
			}
		}
	}
	s.sessions[token] = &session{id: rand.Text(), expires: expires, peers: make(map[*room.Peer]struct{})}
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "lannoto_session", Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Expires: expires, MaxAge: 8 * 60 * 60})
	s.json(w, map[string]bool{"authenticated": true})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if value := s.current(r); value != nil {
		cookie, err := r.Cookie("lannoto_session")
		if err != nil {
			s.fail(err)
			return
		}
		s.mu.Lock()
		delete(s.sessions, cookie.Value)
		for p := range value.peers {
			p.Cancel()
		}
		s.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: "lannoto_session", Value: "", Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	s.json(w, map[string]bool{"authenticated": false})
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	names, err := s.Workspace.List()
	if err != nil {
		s.operationError(w, err)
		return
	}
	s.json(w, names)
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	var input struct {
		Filename string `json:"filename"`
		Markdown string `json:"markdown"`
	}
	if err := readJSON(w, r, &input, 7*storage.MaxMarkdown); err != nil {
		s.problem(w, 400, "invalid_request", "新建请求无效或内容过大")
		return
	}
	if err := s.Rooms.Create(input.Filename, input.Markdown); err != nil {
		s.operationError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusCreated)
	s.json(w, map[string]string{"filename": input.Filename})
}

func (s *Server) note(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	value, err := s.Rooms.Get(r.PathValue("name"))
	if err != nil {
		s.operationError(w, err)
		return
	}
	state, err := value.Snapshot()
	if err != nil {
		s.operationError(w, err)
		return
	}
	s.json(w, map[string]interface{}{"filename": state.Filename, "revision": state.Revision, "markdownRevision": state.MarkdownRevision, "initialized": state.Initialized})
}

func (s *Server) page(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/note/" {
		name := strings.TrimPrefix(r.URL.Path, "/note/")
		if !strings.HasSuffix(name, ".md") || strings.HasPrefix(name, "static/") {
			s.asset(w, r)
			return
		}
		if s.current(r) != nil {
			if _, err := s.Workspace.ReadNote(name); err != nil {
				s.operationError(w, err)
				return
			}
		}
	}
	data, err := fs.ReadFile(s.assets, "index.html")
	if err != nil {
		s.operationError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if _, err = w.Write(data); err != nil {
		slog.Debug("page response ended", "error", err)
	}
}

var colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (s *Server) connect(w http.ResponseWriter, r *http.Request) {
	s.socketWG.Add(1)
	defer s.socketWG.Done()
	session := s.require(w, r)
	if session == nil {
		return
	}
	if !sameOrigin(r) {
		s.problem(w, 403, "origin_mismatch", "WebSocket 只允许同源连接")
		return
	}
	value, err := s.Rooms.Get(r.PathValue("name"))
	if err != nil {
		s.operationError(w, err)
		return
	}
	if _, err := value.Snapshot(); err != nil {
		s.operationError(w, err)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		slog.Debug("WebSocket handshake ended", "error", err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(storage.MaxFrame)
	ctx, cancel := context.WithDeadline(r.Context(), session.expires)
	defer cancel()
	joinCtx, joinCancel := context.WithTimeout(ctx, 10*time.Second)
	join, err := readMessage(joinCtx, conn)
	joinCancel()
	if err != nil {
		var malformed *messageError
		if errors.As(err, &malformed) {
			s.writeInitial(ctx, conn, room.Message{Type: "error", Code: "invalid_message", Message: "join 消息格式无效"})
		}
		return
	}
	if join.Type != "join" || join.ClientID == 0 || join.ClientID > 4294967295 || len(join.Name) > 80 || !utf8.ValidString(join.Name) || !colorPattern.MatchString(join.Color) {
		s.writeInitial(ctx, conn, room.Message{Type: "error", Code: "invalid_message", Message: "join 字段无效"})
		return
	}
	if join.BuildID != s.BuildID {
		s.writeInitial(ctx, conn, room.Message{Type: "error", Code: "build_mismatch", Message: "服务已更新，请刷新页面"})
		return
	}
	peer := room.NewPeer(join.ClientID, cancel)
	peer.Name = join.Name
	peer.OwnerID = session.id
	s.mu.Lock()
	session.peers[peer] = struct{}{}
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(session.peers, peer); s.mu.Unlock() }()
	if err := value.Add(peer); err != nil {
		var input *room.InputError
		if errors.As(err, &input) {
			s.writeInitial(ctx, conn, room.Message{Type: "error", Code: input.Code, Message: input.Message})
		} else {
			s.fail(err)
		}
		return
	}
	defer func() {
		if err := value.Remove(peer); err != nil {
			s.fail(err)
		}
	}()
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		defer cancel()
		ping := time.NewTicker(20 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ping.C:
				pingCtx, stop := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Ping(pingCtx)
				stop()
				if err != nil {
					slog.Debug("WebSocket heartbeat ended", "error", err)
					return
				}
			case message := <-peer.Out:
				if s.dead.Load() {
					return
				}
				writeCtx, stop := context.WithTimeout(ctx, 10*time.Second)
				err := writeMessage(writeCtx, conn, message)
				stop()
				if err != nil {
					slog.Debug("WebSocket write ended", "error", err)
					return
				}
				if message.Close {
					if err := conn.Close(websocket.StatusPolicyViolation, message.Code); err != nil {
						slog.Debug("WebSocket close ended", "error", err)
					}
					return
				}
			}
		}
	}()
	for {
		message, err := readMessage(ctx, conn)
		if err != nil {
			var malformed *messageError
			if errors.As(err, &malformed) {
				peer.Send(room.Message{Type: "error", Code: "invalid_message", Message: "消息格式无效", Close: true})
				<-writerDone
			}
			break
		}
		if err := value.Handle(peer, message); err != nil {
			var input *room.InputError
			if errors.As(err, &input) {
				state, stateErr := value.Snapshot()
				if stateErr != nil {
					var stopped *room.InputError
					if !errors.As(stateErr, &stopped) {
						s.fail(stateErr)
						break
					}
					peer.Send(room.Message{Type: "error", Code: input.Code, Message: input.Message, Close: true})
					<-writerDone
					break
				}
				peer.Send(room.Message{Type: "error", Code: input.Code, Message: input.Message, Revision: state.Revision, RequestID: message.RequestID, MessageID: message.MessageID})
			} else {
				s.fail(err)
				break
			}
		}
	}
	cancel()
	<-writerDone
}

type messageError struct{ cause error }

func (e *messageError) Error() string { return e.cause.Error() }

func readMessage(ctx context.Context, conn *websocket.Conn) (room.Message, error) {
	typeID, data, err := conn.Read(ctx)
	if err != nil {
		return room.Message{}, err
	}
	if typeID != websocket.MessageText || !utf8.Valid(data) {
		return room.Message{}, &messageError{errors.New("expected UTF-8 JSON text frame")}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var message room.Message
	if err := decoder.Decode(&message); err != nil {
		return room.Message{}, &messageError{err}
	}
	if err := decoder.Decode(new(interface{})); !errors.Is(err, io.EOF) {
		return room.Message{}, &messageError{errors.New("trailing JSON")}
	}
	return message, nil
}

func writeMessage(ctx context.Context, conn *websocket.Conn, message room.Message) error {
	data, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("encode WebSocket message: %w", err)
	}
	return conn.Write(ctx, websocket.MessageText, data)
}

func (s *Server) writeInitial(ctx context.Context, conn *websocket.Conn, message room.Message) {
	if err := writeMessage(ctx, conn, message); err != nil {
		slog.Debug("WebSocket join response ended", "error", err)
	}
}

func (s *Server) BeginClose() { s.closing.Store(true); s.Rooms.BeginClose() }

func (s *Server) StopPeers() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, value := range s.sessions {
		for p := range value.peers {
			p.Cancel()
		}
	}
}

func (s *Server) WaitPeers(ctx context.Context) error {
	done := make(chan struct{})
	go func() { s.socketWG.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
