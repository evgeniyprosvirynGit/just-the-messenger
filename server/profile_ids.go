package main

import (
	"errors"
	"strings"
)

const (
	maxProfileIDCount = 100
	profileIDLength   = 36
	maxProfileIDsSize = maxProfileIDCount*profileIDLength + maxProfileIDCount - 1
)

func normalizeProfileID(raw string) (string, bool) {
	profileID := strings.ToLower(strings.TrimSpace(raw))
	if len(profileID) != profileIDLength {
		return "", false
	}
	for index := 0; index < len(profileID); index++ {
		character := profileID[index]
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return "", false
			}
			continue
		}
		if (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') {
			continue
		}
		return "", false
	}
	return profileID, true
}

func parseProfileIDs(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return []string{}, nil
	}

	parts := strings.Split(raw, ",")
	if len(parts) > maxProfileIDCount || len(raw) > maxProfileIDsSize {
		return nil, errors.New("too many profile IDs")
	}

	profileIDs := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		profileID, valid := normalizeProfileID(part)
		if !valid {
			return nil, errors.New("invalid profile ID")
		}
		if _, duplicate := seen[profileID]; duplicate {
			continue
		}
		seen[profileID] = struct{}{}
		profileIDs = append(profileIDs, profileID)
	}
	return profileIDs, nil
}
