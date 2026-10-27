package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"io"
	"os"
	"strings"
	"testing"
)

func TestLeaseErrorExitCodeTreatsSignalCancellationAsClean(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := leaseErrorExitCode(ctx, errors.New("lease ping failed")); got != 0 {
		t.Fatalf("canceled exit code=%d", got)
	}
	if got := leaseErrorExitCode(context.Background(), errors.New("lease lost")); got != 1 {
		t.Fatalf("lease failure exit code=%d", got)
	}
}

func TestOnceExitCodeReflectsCycleFailures(t *testing.T) {
	if got := onceExitCode(cycleResult{}); got != 0 {
		t.Fatalf("success code=%d", got)
	}
	if got := onceExitCode(cycleResult{failures: 1}); got != 1 {
		t.Fatalf("failure code=%d", got)
	}
}

func TestOnceExitCodeTreatsSignalCancellationAsClean(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := onceExitCodeForContext(ctx, cycleResult{failures: 1}); got != 0 {
		t.Fatalf("canceled one-shot exit code=%d", got)
	}
}

func TestWaitForNextCyclePrefersCanceledContextAtZeroDelay(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for range 100 {
		if waitForNextCycle(ctx, 0) {
			t.Fatal("canceled context started another cycle")
		}
	}
}

// runMain calls the real entry point with args, returning its exit code and
// everything it wrote to stdout. Callers set the environment first.
func runMain(t *testing.T, args ...string) (int, string) {
	t.Helper()
	oldFlags, oldArgs, oldStdout := flag.CommandLine, os.Args, os.Stdout
	t.Cleanup(func() { flag.CommandLine, os.Args, os.Stdout = oldFlags, oldArgs, oldStdout })
	flag.CommandLine = flag.NewFlagSet("ingester", flag.ContinueOnError)
	os.Args = append([]string{"ingester"}, args...)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	copied := make(chan struct{})
	go func() { _, _ = io.Copy(&logs, reader); close(copied) }()
	os.Stdout = writer
	code := run()
	os.Stdout = oldStdout
	writer.Close()
	<-copied
	return code, logs.String()
}

// The check needs only the pooled DSN it reads the ledger over; the lease DSN
// belongs to the worker it never starts.
func TestCheckSchemaModeNeedsOnlyThePooledDSN(t *testing.T) {
	t.Setenv("INGESTER_LEASE_DSN", "")
	t.Setenv("POOLED_DSN", "")
	if code, out := runMain(t, "-check-schema"); code != 1 || out != "database schema not checked: POOLED_DSN is required\n" {
		t.Fatalf("exit %d output %q", code, out)
	}
	// Unreachable on purpose: reaching the connection proves the missing lease
	// DSN was not required, and the failure line keeps no DSN text. The
	// sentinel is the user and database name, which pgx's connect error quotes.
	t.Setenv("POOLED_DSN", "postgres://must_not_log_user@127.0.0.1:1/must_not_log_db?sslmode=disable&connect_timeout=2")
	code, out := runMain(t, "-check-schema")
	if code != 1 || strings.Count(out, "\n") != 1 || !strings.HasPrefix(out, "database schema not ready: category=") ||
		strings.Contains(out, "must_not_log") {
		t.Fatalf("exit %d output %q", code, out)
	}
}
