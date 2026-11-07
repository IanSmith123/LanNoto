package server

import (
	"net/http"
	"unicode/utf8"
)

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	value, err := s.Rooms.Get(r.PathValue("name"))
	if err != nil {
		s.operationError(w, err)
		return
	}
	page, err := value.History(r.URL.Query().Get("before"))
	if err != nil {
		s.operationError(w, err)
		return
	}
	s.json(w, page)
}
func (s *Server) historyEntry(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	value, err := s.Rooms.Get(r.PathValue("name"))
	if err != nil {
		s.operationError(w, err)
		return
	}
	entry, err := value.HistoryEntry(r.PathValue("id"))
	if err != nil {
		s.operationError(w, err)
		return
	}
	s.json(w, entry)
}
func (s *Server) checkpoint(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	var input struct {
		Revision uint64 `json:"revision"`
		Author   string `json:"author"`
	}
	if err := readJSON(w, r, &input, 2048); err != nil || input.Revision > 9007199254740991 || len(input.Author) > 80 || !utf8.ValidString(input.Author) {
		s.problem(w, 400, "invalid_history", "历史记录请求无效")
		return
	}
	value, err := s.Rooms.Get(r.PathValue("name"))
	if err != nil {
		s.operationError(w, err)
		return
	}
	version, err := value.Checkpoint(input.Revision, input.Author)
	if err != nil {
		s.operationError(w, err)
		return
	}
	s.json(w, version)
}
func (s *Server) restore(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	var input struct {
		Revision uint64 `json:"revision"`
		Author   string `json:"author"`
	}
	if err := readJSON(w, r, &input, 2048); err != nil || input.Revision > 9007199254740991 || len(input.Author) > 80 || !utf8.ValidString(input.Author) {
		s.problem(w, 400, "invalid_history", "历史恢复请求无效")
		return
	}
	value, err := s.Rooms.Get(r.PathValue("name"))
	if err != nil {
		s.operationError(w, err)
		return
	}
	snapshot, err := value.Restore(r.PathValue("id"), input.Revision, input.Author)
	if err != nil {
		s.operationError(w, err)
		return
	}
	s.json(w, snapshot)
}
