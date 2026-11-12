package main

import (
	"strings"
	"testing"
	"time"
)

func TestNormalizeProfileID(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
		ok   bool
	}{
		{name: "lowercases UUID", raw: "550E8400-E29B-41D4-A716-446655440000", want: "550e8400-e29b-41d4-a716-446655440000", ok: true},
		{name: "trims whitespace", raw: " 550e8400-e29b-41d4-a716-446655440000 ", want: "550e8400-e29b-41d4-a716-446655440000", ok: true},
		{name: "rejects malformed UUID", raw: "550e8400e29b41d4a716446655440000", ok: false},
		{name: "rejects non-hex characters", raw: "550e8400-e29b-41d4-a716-44665544000z", ok: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := normalizeProfileID(test.raw)
			if got != test.want || ok != test.ok {
				t.Fatalf("normalizeProfileID(%q) = (%q, %t), want (%q, %t)", test.raw, got, ok, test.want, test.ok)
			}
		})
	}
}

func TestParseProfileIDsDeduplicatesAndBoundsInput(t *testing.T) {
	profileID := "550e8400-e29b-41d4-a716-446655440000"
	got, err := parseProfileIDs(profileID + "," + strings.ToUpper(profileID))
	if err != nil {
		t.Fatalf("parseProfileIDs returned an error: %v", err)
	}
	if len(got) != 1 || got[0] != profileID {
		t.Fatalf("parseProfileIDs returned %#v, want one normalized profile ID", got)
	}

	tooMany := strings.Repeat(profileID+",", maxProfileIDCount)
	if _, err := parseProfileIDs(tooMany); err == nil {
		t.Fatal("parseProfileIDs accepted more than the configured maximum")
	}
}

func TestFriendRequestPageSizeIsBounded(t *testing.T) {
	if got, err := parseFriendRequestPageSize(""); err != nil || got != defaultFriendPageSize {
		t.Fatalf("default page size = (%d, %v), want (%d, nil)", got, err, defaultFriendPageSize)
	}
	if got, err := parseFriendRequestPageSize("50"); err != nil || got != maxFriendPageSize {
		t.Fatalf("maximum page size = (%d, %v), want (%d, nil)", got, err, maxFriendPageSize)
	}
	for _, raw := range []string{"0", "51", "-1", "many"} {
		if _, err := parseFriendRequestPageSize(raw); err == nil {
			t.Errorf("parseFriendRequestPageSize(%q) accepted an invalid limit", raw)
		}
	}
}

func TestFriendRequestCursorRoundTripAndRejectsInvalidValues(t *testing.T) {
	want := friendRequestCursor{
		Timestamp: time.Date(2026, time.November, 12, 10, 30, 0, 123, time.UTC),
		ID:        "550e8400-e29b-41d4-a716-446655440000",
	}
	got, err := decodeFriendRequestCursor(encodeFriendRequestCursor(want))
	if err != nil {
		t.Fatalf("decodeFriendRequestCursor returned an error: %v", err)
	}
	if !got.Timestamp.Equal(want.Timestamp) || got.ID != want.ID {
		t.Fatalf("cursor round trip = %#v, want %#v", got, want)
	}
	for _, raw := range []string{"invalid", strings.Repeat("a", 257)} {
		if _, err := decodeFriendRequestCursor(raw); err == nil {
			t.Errorf("decodeFriendRequestCursor(%q) accepted invalid input", raw)
		}
	}
}

func TestFriendRequestListQueryUsesOnlySupportedViews(t *testing.T) {
	for _, view := range []string{"incoming", "outgoing", "friends"} {
		where, sortColumn, state := friendRequestListQuery(view)
		if where == "" || sortColumn == "" || state == "" {
			t.Errorf("friendRequestListQuery(%q) returned an incomplete query", view)
		}
	}
	if where, sortColumn, state := friendRequestListQuery("untrusted SQL"); where != "" || sortColumn != "" || state != "" {
		t.Fatalf("friendRequestListQuery accepted unsupported view: %q, %q, %q", where, sortColumn, state)
	}
}
