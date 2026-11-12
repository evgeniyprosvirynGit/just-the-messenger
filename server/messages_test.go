package main

import (
	"strings"
	"testing"
)

func TestValidateMessageAcceptsValidPayload(t *testing.T) {
	request := createMessageRequest{Body: "hello world", Latitude: 41.7, Longitude: 44.8}
	if err := validateMessage(request); err != nil {
		t.Fatalf("expected valid message, got %v", err)
	}
}

func TestValidateMessageRejectsInvalidPayloads(t *testing.T) {
	tests := []struct {
		name    string
		request createMessageRequest
	}{
		{name: "empty body", request: createMessageRequest{Latitude: 0, Longitude: 0}},
		{name: "too long", request: createMessageRequest{Body: strings.Repeat("x", maxMessageLength+1), Latitude: 0, Longitude: 0}},
		{name: "invalid latitude", request: createMessageRequest{Body: "hello", Latitude: 91, Longitude: 0}},
		{name: "invalid longitude", request: createMessageRequest{Body: "hello", Latitude: 0, Longitude: 181}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := validateMessage(test.request); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestRegionForUsesSameTwoCharacterGeohashCells(t *testing.T) {
	if got, want := regionFor(41.7151, 44.8271), "sz"; got != want {
		t.Fatalf("regionFor() = %q, want %q", got, want)
	}
}
