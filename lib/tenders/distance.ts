/**
 * Great-circle distance between the company and a tender, for the "X km away"
 * hint on tender cards. Straight-line, not driving distance — the list must
 * stay free of routing/Maps calls, and for "is this near me?" a crow-flies
 * figure is what bidders actually reason with.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Kilometres between two points, or null if either is unusable. */
export function distanceKm(from: LatLng | null, to: LatLng | null): number | null {
  if (!from || !to) return null;
  if (
    !Number.isFinite(from.lat) ||
    !Number.isFinite(from.lng) ||
    !Number.isFinite(to.lat) ||
    !Number.isFinite(to.lng)
  ) {
    return null;
  }

  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;
  const km = 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));

  // Postal-centroid precision makes sub-kilometre digits meaningless.
  return Math.round(km);
}
