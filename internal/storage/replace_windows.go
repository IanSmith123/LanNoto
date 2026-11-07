package storage

import (
	"errors"
	"fmt"
	"strings"
	"unsafe"

	"github.com/natefinch/atomic"
	"golang.org/x/sys/windows"
)

// Query only: never shut down, restart, or terminate any process.
var restartManager = windows.NewLazySystemDLL("rstrtmgr.dll")
var rmStart = restartManager.NewProc("RmStartSession")
var rmRegister = restartManager.NewProc("RmRegisterResources")
var rmList = restartManager.NewProc("RmGetList")
var rmEnd = restartManager.NewProc("RmEndSession")

type rmProcess struct {
	PID                   uint32
	Started               windows.Filetime
	Name                  [256]uint16
	Service               [64]uint16
	Kind, Status, Session uint32
	Restartable           int32
}

func fileUsers(path string) (description string, result error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	var session uint32
	var key [33]uint16
	status, _, _ := rmStart.Call(uintptr(unsafe.Pointer(&session)), 0, uintptr(unsafe.Pointer(&key[0])))
	if status != 0 {
		return "", windows.Errno(status)
	}
	defer func() {
		code, _, _ := rmEnd.Call(uintptr(session))
		if code != 0 {
			result = errors.Join(result, windows.Errno(code))
		}
	}()
	status, _, _ = rmRegister.Call(uintptr(session), 1, uintptr(unsafe.Pointer(&name)), 0, 0, 0, 0)
	if status != 0 {
		return "", windows.Errno(status)
	}
	users := make([]rmProcess, 256)
	count := uint32(len(users))
	var needed, reasons uint32
	status, _, _ = rmList.Call(uintptr(session), uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&users[0])), uintptr(unsafe.Pointer(&reasons)))
	if status != 0 {
		return "", windows.Errno(status)
	}
	if count > uint32(len(users)) {
		return "", fmt.Errorf("invalid resource user count %d", count)
	}
	details := make([]string, 0, count)
	for _, user := range users[:count] {
		details = append(details, fmt.Sprintf("pid=%d app=%q service=%q", user.PID, windows.UTF16ToString(user.Name[:]), windows.UTF16ToString(user.Service[:])))
	}
	if len(details) == 0 {
		return "no users reported (transient or kernel locks may not be listed)", nil
	}
	return strings.Join(details, "; "), nil
}

func replaceFile(source, destination string) error {
	err := atomic.ReplaceFile(source, destination)
	if err == nil {
		return nil
	}
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) && !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		return err
	}
	users, queryErr := fileUsers(destination)
	if queryErr != nil {
		return fmt.Errorf("%w; resource users query: %v", err, queryErr)
	}
	sourceUsers, sourceErr := fileUsers(source)
	if sourceErr != nil {
		return fmt.Errorf("%w; destination users: %s; temporary file users query: %v", err, users, sourceErr)
	}
	return fmt.Errorf("%w; destination users: %s; temporary file users: %s", err, users, sourceUsers)
}
