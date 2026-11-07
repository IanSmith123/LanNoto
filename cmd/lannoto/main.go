package main

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"lannoto/internal/room"
	"lannoto/internal/server"
	"lannoto/internal/storage"
	"lannoto/internal/webassets"
)

func run(openFrontend func() (fs.FS, string, error)) (result error) {
	password := flag.String("password", "", "shared service password (generated when empty)")
	host := flag.String("host", "0.0.0.0", "listen address")
	port := flag.Int("port", 8080, "listen port")
	pandoc := flag.String("pandoc", "pandoc", "Pandoc executable path")
	flag.Parse()
	if flag.NArg() != 0 || *port < 1 || *port > 65535 || strings.TrimSpace(*host) == "" {
		return errors.New("invalid arguments, host or port")
	}
	generated := *password == ""
	if generated {
		*password = rand.Text()
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	workspace, err := storage.Open(cwd)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, workspace.Close()) }()
	rooms, err := room.Open(workspace)
	if err != nil {
		return err
	}
	assets, buildID, err := openFrontend()
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(*host, strconv.Itoa(*port)))
	if err != nil {
		return err
	}
	application := server.New(workspace, rooms, assets, buildID, *password, *pandoc)
	httpServer := &http.Server{Handler: application.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	serveDone := make(chan error, 1)
	go func() { serveDone <- httpServer.Serve(listener) }()
	if generated {
		slog.Info("LanNoto started", "address", listener.Addr().String(), "generated_password", *password)
	} else {
		slog.Info("LanNoto started", "address", listener.Addr().String())
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	historyTick := time.NewTicker(2 * time.Second)
	defer historyTick.Stop()
running:
	for {
		select {
		case err := <-application.Fatal:
			application.StopPeers()
			return errors.Join(err, httpServer.Close())
		case err := <-serveDone:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		case <-signals:
			application.BeginClose()
			break running
		case now := <-historyTick.C:
			if err := rooms.CheckpointDue(now); err != nil {
				application.StopPeers()
				return errors.Join(err, httpServer.Close())
			}
		}
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-application.Fatal:
			application.StopPeers()
			return errors.Join(err, httpServer.Close())
		case <-tick.C:
			if len(rooms.Pending()) == 0 {
				application.StopPeers()
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				return errors.Join(httpServer.Shutdown(ctx), application.WaitPeers(ctx))
			}
		case <-deadline.C:
			pending := rooms.Pending()
			application.StopPeers()
			return errors.Join(fmt.Errorf("shutdown incomplete: %s", strings.Join(pending, ", ")), httpServer.Close())
		}
	}
}

func finish(err error) {
	if err != nil {
		slog.Error("LanNoto stopped", "error", err)
		os.Exit(1)
	}
}

func main() { finish(run(webassets.Open)) }
