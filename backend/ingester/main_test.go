package main

import (
	"context"
	"testing"
)

func TestOnceExitCodeReflectsCycleFailures(t *testing.T) {
	if got := onceExitCode(cycleResult{}); got != 0 {
		t.Fatalf("success code=%d", got)
	}
	if got := onceExitCode(cycleResult{failures: 1}); got != 1 {
		t.Fatalf("failure code=%d", got)
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
