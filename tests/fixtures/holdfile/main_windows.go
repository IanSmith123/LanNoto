package main

import (
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/sys/windows"
)

func run() (result error) {
	if len(os.Args) != 2 {
		return errors.New("expected one test file path")
	}
	name, err := windows.UTF16PtrFromString(os.Args[1])
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, windows.CloseHandle(handle)) }()
	if _, err := fmt.Fprintln(os.Stdout, "locked"); err != nil {
		return err
	}
	_, err = io.Copy(io.Discard, os.Stdin)
	return err
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
