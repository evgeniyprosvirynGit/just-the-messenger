package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestValidPublicMessageDisplaySeconds(t *testing.T) {
	tests := []struct {
		seconds int
		valid   bool
	}{
		{seconds: 6, valid: true},
		{seconds: 12, valid: true},
		{seconds: 24, valid: true},
		{seconds: 0},
		{seconds: 5},
		{seconds: 30},
	}

	for _, test := range tests {
		t.Run(strconv.Itoa(test.seconds), func(t *testing.T) {
			if actual := validPublicMessageDisplaySeconds(test.seconds); actual != test.valid {
				t.Fatalf("validPublicMessageDisplaySeconds(%d) = %t, want %t", test.seconds, actual, test.valid)
			}
		})
	}
}

func TestPublicMessageRetentionCoversMaximumDisplayDuration(t *testing.T) {
	const maximumViewerDisplaySeconds = 24
	if publicMessageRetentionSeconds < maximumViewerDisplaySeconds {
		t.Fatalf("server retention %d seconds is shorter than maximum viewer display %d seconds", publicMessageRetentionSeconds, maximumViewerDisplaySeconds)
	}
}

func TestAccountSettingsRequireSession(t *testing.T) {
	app := &application{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		t.Run(method, func(t *testing.T) {
			request := httptest.NewRequest(method, "/api/account/settings", strings.NewReader(`{"publicMessageDisplaySeconds":24}`))
			response := httptest.NewRecorder()
			app.routes().ServeHTTP(response, request)

			if response.Code != http.StatusUnauthorized {
				t.Fatalf("account settings without a session returned %d, want %d", response.Code, http.StatusUnauthorized)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("account settings response Cache-Control = %q, want no-store", response.Header().Get("Cache-Control"))
			}
		})
	}
}
