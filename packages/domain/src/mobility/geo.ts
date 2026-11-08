const EARTH_RADIUS_METERS = 6_371_008.8;

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two coordinates, in meters. */
export function haversineMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const dLat = radians(to.latitude - from.latitude);
  const dLng = radians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}
