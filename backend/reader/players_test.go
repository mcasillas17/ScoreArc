package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

func TestPlayerHandlerContract(t *testing.T) {
	_, raw := loadReaderContract(t)
	bytesProfile, err := json.Marshal(vector(t, raw, "player", "reader", "profile"))
	if err != nil {
		t.Fatal(err)
	}
	var profile PlayerProfile
	if err := json.Unmarshal(bytesProfile, &profile); err != nil {
		t.Fatal(err)
	}
	document := loadOpenAPI(t)
	for _, tc := range []struct {
		name    string
		profile *PlayerProfile
		err     error
		status  int
	}{
		{name: "success", profile: &profile, status: 200},
		{name: "unknown", status: 404},
		{name: "storage failure", err: errors.New("private database connection details"), status: 500},
		{name: "oversized", profile: &PlayerProfile{ID: testPlayerID, Name: strings.Repeat("x", maxContractResponseBytes)}, status: 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeReaderStore{player: tc.profile, playerErr: tc.err}
			tracked := &trackingSnapshotStore{fakeReaderStore: fake}
			app := newTestApp(t, fake, &fakeNewsReader{})
			app.store = tracked
			res := responseAfterSnapshotClosed(t, app.router(), playerPath, tracked)
			if res.Code != tc.status || tracked.begins != 1 || tracked.closes != 1 || !tracked.deadline {
				t.Fatalf("status=%d begin=%d close=%d body=%s", res.Code, tracked.begins, tracked.closes, res.Body.String())
			}
			if tc.status == 200 {
				var wire any
				if err := json.Unmarshal(res.Body.Bytes(), &wire); err != nil {
					t.Fatal(err)
				}
				assertWire(t, "player DTO", wire, vector(t, raw, "player", "reader", "profile"))
				validateSchema(t, document, "PlayerProfile", wire)
			} else if res.Header().Get("Cache-Control") != "no-store" || strings.Contains(res.Body.String(), "private") {
				t.Fatal("failure leaked or cached")
			}
		})
	}
	// Begin failure is handled before data access and never exposes dependency text.
	fake := &fakeReaderStore{}
	tracked := &trackingSnapshotStore{fakeReaderStore: fake, beginErr: errors.New("private connection")}
	app := newTestApp(t, fake, &fakeNewsReader{})
	app.store = tracked
	res := responseAfterSnapshotClosed(t, app.router(), playerPath, tracked)
	if res.Code != 500 || fake.calls != 0 || tracked.closes != 0 {
		t.Fatalf("snapshot begin failed open: %d", res.Code)
	}
	for _, id := range []string{"01890000-0000-7000-8000-abcdefabcdef", "01890000-0000-7000-8000-ABCDEFABCDEF", "01890000000070008000000000000444", "{01890000-0000-7000-8000-000000000444}", "urn:uuid:" + testPlayerID} {
		res := performRequest(newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{}).router(), http.MethodGet, strings.Replace(playerPath, testPlayerID, id, 1))
		want := 400
		if id == "01890000-0000-7000-8000-abcdefabcdef" {
			want = 404
		}
		if res.Code != want {
			t.Fatalf("id %s: status %d", id, res.Code)
		}
	}
	// No raw dependency text reaches the public handler's structured logs either.
	var logs bytes.Buffer
	app = newTestApp(t, &fakeReaderStore{playerErr: errors.New("secret-dsn")}, &fakeNewsReader{})
	app.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	performRequest(app.router(), http.MethodGet, playerPath)
	if strings.Contains(logs.String(), "secret-dsn") {
		t.Fatal("dependency secret logged")
	}
}
