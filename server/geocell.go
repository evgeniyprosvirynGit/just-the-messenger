package main

const geohashAlphabet = "0123456789bcdefghjkmnpqrstuvwxyz"

func regionFor(latitude, longitude float64) string {
	latitudeRange := [2]float64{-90, 90}
	longitudeRange := [2]float64{-180, 180}
	isLongitude := true
	bit := 0
	character := 0
	result := make([]byte, 0, 2)

	for len(result) < 2 {
		if isLongitude {
			midpoint := (longitudeRange[0] + longitudeRange[1]) / 2
			if longitude >= midpoint {
				character |= 1 << (4 - bit)
				longitudeRange[0] = midpoint
			} else {
				longitudeRange[1] = midpoint
			}
		} else {
			midpoint := (latitudeRange[0] + latitudeRange[1]) / 2
			if latitude >= midpoint {
				character |= 1 << (4 - bit)
				latitudeRange[0] = midpoint
			} else {
				latitudeRange[1] = midpoint
			}
		}
		isLongitude = !isLongitude
		bit++
		if bit == 5 {
			result = append(result, geohashAlphabet[character])
			bit = 0
			character = 0
		}
	}
	return string(result)
}
