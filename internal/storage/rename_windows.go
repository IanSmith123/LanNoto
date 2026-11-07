package storage

import (
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func renameExclusive(sourceDir, targetDir *os.File, from, to string) error {
	name, err := windows.NewNTUnicodeString(from)
	if err != nil {
		return err
	}
	attrs := windows.OBJECT_ATTRIBUTES{RootDirectory: windows.Handle(sourceDir.Fd()), ObjectName: name}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var source windows.Handle
	var status windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(&source, windows.DELETE, &attrs, &status, nil, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		windows.FILE_OPEN, windows.FILE_OPEN_REPARSE_POINT, 0, 0)
	if err != nil {
		return renameErrno(err)
	}
	defer windows.CloseHandle(source)

	target, err := windows.UTF16FromString(to)
	if err != nil {
		return err
	}
	// FILE_RENAME_INFORMATION with ReplaceIfExists false.
	info := struct {
		ReplaceIfExists uint32
		RootDirectory   windows.Handle
		FileNameLength  uint32
		FileName        [256]uint16
	}{RootDirectory: windows.Handle(targetDir.Fd())}
	if len(target) > len(info.FileName) {
		return windows.ERROR_FILENAME_EXCED_RANGE
	}
	info.FileNameLength = uint32((len(target) - 1) * 2)
	copy(info.FileName[:], target)
	err = windows.NtSetInformationFile(source, &status, (*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), windows.FileRenameInformation)
	return renameErrno(err)
}

func renameErrno(err error) error {
	if status, ok := err.(windows.NTStatus); ok {
		err = status.Errno()
	}
	if err == windows.ERROR_SHARING_VIOLATION {
		return syscall.EACCES
	}
	if err == windows.ERROR_NOT_SAME_DEVICE {
		return ErrDifferentVolume
	}
	return err
}
