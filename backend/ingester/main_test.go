package main

import (
	"context"
	"errors"
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
