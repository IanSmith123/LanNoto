package server

import "net/http"

func (s *Server) tree(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	entries, err := s.Workspace.Tree()
	if err != nil {
		s.operationError(w, err)
		return
	}
	s.json(w, entries)
}

func (s *Server) createFolder(w http.ResponseWriter, r *http.Request) {
	if s.require(w, r) == nil {
		return
	}
	var input struct {
		Path string `json:"path"`
	}
	if err := readJSON(w, r, &input, 16<<10); err != nil {
		s.problem(w, 400, "invalid_request", "文件夹请求无效")
		return
	}
	if err := s.Rooms.CreateFolder(input.Path); err != nil {
		s.operationError(w, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
	s.json(w, map[string]string{"path": input.Path})
}

func (s *Server) renameEntry(w http.ResponseWriter, r *http.Request) {
	session := s.require(w, r)
	if session == nil {
		return
	}
	var input struct {
		Path     string `json:"path"`
		Name     string `json:"name"`
		ClientID uint64 `json:"clientId"`
	}
	if err := readJSON(w, r, &input, 16<<10); err != nil || input.ClientID > 4294967295 {
		s.problem(w, 400, "invalid_request", "重命名请求无效")
		return
	}
	name, err := s.Rooms.Rename(input.Path, input.Name, session.id, input.ClientID)
	if err != nil {
		s.operationError(w, err)
		return
	}
	s.json(w, map[string]string{"path": name})
}

func (s *Server) moveEntry(w http.ResponseWriter, r *http.Request) {
	session := s.require(w, r)
	if session == nil {
		return
	}
	var input struct {
		Path      string  `json:"path"`
		Directory *string `json:"directory"`
		ClientID  uint64  `json:"clientId"`
	}
	if err := readJSON(w, r, &input, 16<<10); err != nil || input.Directory == nil || input.ClientID > 4294967295 {
		s.problem(w, 400, "invalid_request", "移动请求无效")
		return
	}
	name, err := s.Rooms.Move(input.Path, *input.Directory, session.id, input.ClientID)
	if err != nil {
		s.operationError(w, err)
		return
	}
	s.json(w, map[string]string{"path": name})
}
