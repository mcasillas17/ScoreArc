package main

import "testing"

func TestOnceExitCodeReflectsCycleFailures(t *testing.T) {
	if got := onceExitCode(cycleResult{}); got != 0 {
		t.Fatalf("success code=%d", got)
	}
	if got := onceExitCode(cycleResult{failures: 1}); got != 1 {
		t.Fatalf("failure code=%d", got)
	}
}
