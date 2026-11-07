package room

import (
	"errors"
	"os"
	"path"
	"strings"

	"lannoto/internal/storage"
)

func (m *Manager) CreateFolder(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return invalid("closing", "服务正在关闭")
	}
	return m.workspace.CreateFolder(name)
}

func (m *Manager) Rename(from, base, owner string, clientID uint64) (string, error) {
	if err := storage.ValidName(base, false); err != nil {
		return "", err
	}
	// Do not clean user paths before the storage layer validates them.
	to := from[:strings.LastIndex(from, "/")+1] + base
	return m.relocate(from, to, owner, clientID)
}

func (m *Manager) Move(from, directory, owner string, clientID uint64) (string, error) {
	to := path.Base(from)
	if directory != "" {
		to = directory + "/" + to
	}
	return m.relocate(from, to, owner, clientID)
}

func (m *Manager) relocate(from, destination, owner string, clientID uint64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return "", invalid("closing", "服务正在关闭")
	}
	affected := make(map[string]*Room)
	for name, room := range m.rooms {
		if name == from || strings.HasPrefix(name, from+"/") {
			room.mu.Lock()
			defer room.mu.Unlock()
			affected[name] = room
		}
	}
	for _, room := range affected {
		for _, peer := range room.peers {
			if peer.OwnerID != owner || peer.ClientID != clientID {
				return "", invalid("note_in_use", "其他页面正在打开此笔记，请关闭这些页面后重试")
			}
		}
		if room.stopped == nil {
			if err := room.check(); err != nil {
				return "", err
			}
			if room.state.Initialized {
				if err := room.projectCurrent(); err != nil {
					return "", err
				}
			}
		}
	}
	to, err := m.workspace.Relocate(from, destination)
	if err != nil {
		if errors.Is(err, storage.ErrOwnSubtree) {
			return "", invalid("invalid_move", "不能将文件夹移动到自己的子目录")
		}
		if !errors.Is(err, storage.ErrIO) && errors.Is(err, storage.ErrDifferentVolume) {
			return "", invalid("invalid_move", "目标文件夹在另一磁盘上，无法移动")
		}
		// A locked file is an operation conflict. A failure to persist the
		// rename journal still goes through the server's fatal error handling.
		if !errors.Is(err, storage.ErrIO) && errors.Is(err, os.ErrPermission) {
			return "", invalid("rename_locked", "文件或文件夹正在被其他程序占用，请稍后重试")
		}
		return "", err
	}
	if from != to {
		for name, room := range affected {
			room.stop("note_renamed", "笔记路径已更改，请打开新路径")
			delete(m.rooms, name)
		}
		// External edits may have left rooms for a former destination.
		for name, room := range m.rooms {
			if name == to || strings.HasPrefix(name, to+"/") {
				room.mu.Lock()
				room.stop("note_renamed", "笔记路径已更改，请打开新路径")
				room.mu.Unlock()
				delete(m.rooms, name)
			}
		}
	}
	return to, nil
}
