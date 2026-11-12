const GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";

export function encodeGeohash(latitude: number, longitude: number, precision = 2): string {
  let latitudeRange: [number, number] = [-90, 90];
  let longitudeRange: [number, number] = [-180, 180];
  let isLongitude = true;
  let bit = 0;
  let character = 0;
  let hash = "";

  while (hash.length < precision) {
    const range = isLongitude ? longitudeRange : latitudeRange;
    const coordinate = isLongitude ? longitude : latitude;
    const midpoint = (range[0] + range[1]) / 2;

    if (coordinate >= midpoint) {
      character |= 1 << (4 - bit);
      range[0] = midpoint;
    } else {
      range[1] = midpoint;
    }

    isLongitude = !isLongitude;
    bit += 1;

    if (bit === 5) {
      hash += GEOHASH_ALPHABET[character];
      bit = 0;
      character = 0;
    }
  }

  return hash;
}

export function geohashCellsForView(
  west: number,
  south: number,
  east: number,
  north: number,
): string[] {
  const cells = new Set<string>();
  const westDegrees = (west * 180) / Math.PI;
  const eastDegrees = (east * 180) / Math.PI;
  const southDegrees = Math.max(-85, (south * 180) / Math.PI);
  const northDegrees = Math.min(85, (north * 180) / Math.PI);
  const wrapsDateLine = westDegrees > eastDegrees;
  const longitudeWidth = wrapsDateLine
    ? 360 - westDegrees + eastDegrees
    : eastDegrees - westDegrees;
  const longitudeStep = Math.max(2.5, Math.min(8, longitudeWidth / 18));
  const latitudeStep = Math.max(2.5, Math.min(6, (northDegrees - southDegrees) / 14));

  for (let latitude = southDegrees; latitude <= northDegrees; latitude += latitudeStep) {
    for (let distance = 0; distance <= longitudeWidth; distance += longitudeStep) {
      const longitude = wrapsDateLine
        ? ((westDegrees + distance + 180) % 360) - 180
        : westDegrees + distance;
      cells.add(encodeGeohash(latitude, longitude, 2));
      if (cells.size >= 64) return [...cells];
    }
  }

  cells.add(encodeGeohash((southDegrees + northDegrees) / 2, westDegrees, 2));
  cells.add(encodeGeohash((southDegrees + northDegrees) / 2, eastDegrees, 2));
  return [...cells];
}
