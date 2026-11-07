package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

type panicFrontend struct{}

func (panicFrontend) Open(string) (fs.File, error) { panic("injected handler panic") }

func TestHandlerPanicExitsActualServiceProcess(t *testing.T) {
	if os.Getenv("LANNOTO_TEST_PANIC_PROCESS") == "1" {
		flag.CommandLine = flag.NewFlagSet("lannoto", flag.ExitOnError)
		os.Args = []string{"lannoto", "--host", "127.0.0.1", "--port", os.Getenv("LANNOTO_TEST_PORT"), "--password", "panic-test-password"}
		// Execute the same startup, HTTP ownership loop and exit path as main.
		// Only the frontend FS is substituted to inject a handler-time panic.
		finish(run(func() (fs.FS, string, error) { return panicFrontend{}, "00000000-0000-0000-0000-000000000000", nil }))
		return
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := strings.Split(listener.Addr().String(), ":")[1]
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestHandlerPanicExitsActualServiceProcess$")
	command.Env = append(os.Environ(), "LANNOTO_TEST_PANIC_PROCESS=1", "LANNOTO_TEST_PORT="+port)
	command.Dir = t.TempDir()
	var logs bytes.Buffer
	command.Stdout, command.Stderr = &logs, &logs
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	client := &http.Client{Timeout: 300 * time.Millisecond}
	origin := "http://127.0.0.1:" + port
	ready := false
	for ctx.Err() == nil {
		response, err := client.Get(origin + "/api/config")
		if err == nil {
			if closeErr := response.Body.Close(); closeErr != nil {
				t.Fatal(closeErr)
			}
			if response.StatusCode == 200 {
				ready = true
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !ready {
		t.Fatal("test service did not become ready")
	}
	// Closing the server after the panic may race the 500 response. Either a
	// 500 or connection close is valid, but continuing to serve is not.
	if response, err := client.Get(origin + "/note/"); err == nil {
		if closeErr := response.Body.Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
		if response.StatusCode != 500 {
			t.Fatalf("unexpected panic response: %d", response.StatusCode)
		}
	}
	err = command.Wait()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 || ctx.Err() != nil {
		t.Fatalf("service failed to exit with code 1: %v, context %v, logs %s", err, ctx.Err(), logs.String())
	}
	if !strings.Contains(logs.String(), "injected handler panic") || !strings.Contains(logs.String(), "HTTP handler panic") {
		t.Fatalf("missing panic error chain: %s", logs.String())
	}
	if strings.Contains(logs.String(), "panic-test-password") {
		t.Fatal("explicit password leaked to fatal log")
	}
	if response, err := client.Get(origin + "/api/config"); err == nil {
		response.Body.Close()
		t.Fatal("service still responds after fatal process exit")
	}
}
