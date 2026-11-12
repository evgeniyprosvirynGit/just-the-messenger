package main

import "testing"

func TestNewGoogleAuthClientIsDisabledWithoutCredentials(t *testing.T) {
	client, err := newGoogleAuthClient(googleAuthSettings{})
	if err != nil {
		t.Fatalf("newGoogleAuthClient() error = %v", err)
	}
	if client.isEnabled() {
		t.Fatal("Google sign-in should be disabled without credentials")
	}
}

func TestNewGoogleAuthClientRequiresCompleteCredentials(t *testing.T) {
	_, err := newGoogleAuthClient(googleAuthSettings{ClientID: "client-id"})
	if err == nil {
		t.Fatal("newGoogleAuthClient() should reject partial credentials")
	}
}

func TestNewGoogleAuthClientAcceptsHTTPSGoogleAndLoopbackRedirect(t *testing.T) {
	client, err := newGoogleAuthClient(googleAuthSettings{
		ClientID:     "client-id",
		ClientSecret: "client-secret",
		RedirectURL:  "http://localhost:8090/api/auth/google/callback",
		IssuerURL:    googleIssuerURL,
	})
	if err != nil {
		t.Fatalf("newGoogleAuthClient() error = %v", err)
	}
	if !client.isEnabled() {
		t.Fatal("Google sign-in should be enabled with complete credentials")
	}
}

func TestNewGoogleAuthClientRejectsNonGoogleIssuerOutsideTestMode(t *testing.T) {
	_, err := newGoogleAuthClient(googleAuthSettings{
		ClientID:     "client-id",
		ClientSecret: "client-secret",
		RedirectURL:  "https://meridian.example/api/auth/google/callback",
		IssuerURL:    "https://identity.example",
	})
	if err == nil {
		t.Fatal("newGoogleAuthClient() should reject an untrusted issuer")
	}
}

func TestValidateGoogleRedirectURLRejectsExternalHTTPAndOpenPaths(t *testing.T) {
	invalidURLs := []string{
		"http://meridian.example/api/auth/google/callback",
		"https://meridian.example/other-path",
		"https://meridian.example/api/auth/google/callback?next=https://example.org",
	}
	for _, redirectURL := range invalidURLs {
		t.Run(redirectURL, func(t *testing.T) {
			if err := validateGoogleRedirectURL(redirectURL, false); err == nil {
				t.Fatal("validateGoogleRedirectURL() unexpectedly accepted URL")
			}
		})
	}
}

func TestGoogleOAuthStateHashIsFixedLengthAndDeterministic(t *testing.T) {
	first := googleOAuthStateHash("one-time-state")
	second := googleOAuthStateHash("one-time-state")
	if len(first) != 32 {
		t.Fatalf("state hash length = %d, want 32", len(first))
	}
	for i := range first {
		if first[i] != second[i] {
			t.Fatal("same state produced different hashes")
		}
	}
}
