package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNormalizeGuestNickname(t *testing.T) {
	tests := []struct {
		name          string
		input         string
		wantName      string
		wantHandle    string
		wantHandleKey string
		wantError     bool
	}{
		{name: "collapses whitespace and normalizes compatibility characters", input: "  Ａlice\tRivera  ", wantName: "Alice Rivera", wantHandle: "@alice-rivera", wantHandleKey: "alice rivera"},
		{name: "supports unicode letters", input: "e\u0301clair", wantName: "éclair", wantHandle: "@éclair", wantHandleKey: "éclair"},
		{name: "case folds identity key", input: "MILA", wantName: "MILA", wantHandle: "@mila", wantHandleKey: "mila"},
		{name: "allows supported separators", input: "River's-road_2", wantName: "River's-road_2", wantHandle: "@river's-road_2", wantHandleKey: "river's-road_2"},
		{name: "rejects too short", input: "A", wantError: true},
		{name: "rejects too long", input: strings.Repeat("a", maxNicknameLength+1), wantError: true},
		{name: "rejects reserved name", input: "ADMIN", wantError: true},
		{name: "rejects unsupported punctuation", input: "A.li", wantError: true},
		{name: "rejects leading punctuation", input: "_alex", wantError: true},
		{name: "rejects whitespace-only suffix after normalization", input: " A ", wantError: true},
		{name: "rejects emoji", input: "🙂Alex", wantError: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gotName, gotHandle, gotHandleKey, err := normalizeGuestNickname(test.input)
			if test.wantError {
				if err == nil {
					t.Fatalf("normalizeGuestNickname(%q) unexpectedly succeeded", test.input)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeGuestNickname(%q): %v", test.input, err)
			}
			if gotName != test.wantName || gotHandle != test.wantHandle || gotHandleKey != test.wantHandleKey {
				t.Fatalf("normalizeGuestNickname(%q) = (%q, %q, %q), want (%q, %q, %q)",
					test.input, gotName, gotHandle, gotHandleKey, test.wantName, test.wantHandle, test.wantHandleKey)
			}
		})
	}
}

func TestGuestIdentityForNameKeepsUniquenessKeyAndStableAvatar(t *testing.T) {
	first := guestIdentityForName("Mila Rivera", "@mila-rivera", "mila rivera")
	second := guestIdentityForName("Mila Rivera", "@mila-rivera", "mila rivera")
	if first.handleKey != "mila rivera" {
		t.Fatalf("identity key = %q, want normalized key", first.handleKey)
	}
	if first.AvatarColor == "" || first.AvatarColor != second.AvatarColor {
		t.Fatalf("avatar color is not stable: first=%q second=%q", first.AvatarColor, second.AvatarColor)
	}
	if first.Initials != "MR" || second.Initials != "MR" {
		t.Fatalf("unexpected initials: %q and %q", first.Initials, second.Initials)
	}
}

func TestGuestSessionCookieSecurityAttributes(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "http://meridian.test/api/guest-session", nil)
	request.Header.Set("X-Forwarded-Proto", "https")
	setGuestSessionCookie(recorder, request, "opaque-session-token")

	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookie count = %d, want 1", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != guestSessionCookieName || cookie.Value != "opaque-session-token" {
		t.Fatalf("unexpected session cookie: %#v", cookie)
	}
	if cookie.Path != "/" || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookie security attributes are incomplete: %#v", cookie)
	}
}
