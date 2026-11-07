// This executable is used only by failure-injection tests. Production never
// selects it unless the test explicitly passes its path through --pandoc.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

func main() {
	for _, argument := range os.Args[1:] {
		if argument == "--to=docx" {
			marker := filepath.Join(os.Getenv("LANNOTO_TEST_MARKERS"), strconv.Itoa(os.Getpid()))
			if err := os.WriteFile(marker, []byte("started"), 0600); err != nil {
				panic(err)
			}
			if os.Getenv("LANNOTO_TEST_CONVERTER") == "failure" {
				fmt.Fprintln(os.Stderr, "intentional conversion failure for integration test")
				os.Exit(17)
			}
			time.Sleep(90 * time.Second)
			panic("test converter should have been cancelled before 90 seconds")
		}
	}
	command := exec.Command(os.Getenv("LANNOTO_TEST_PANDOC"), os.Args[1:]...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			os.Exit(exit.ExitCode())
		}
		panic(err)
	}
}
