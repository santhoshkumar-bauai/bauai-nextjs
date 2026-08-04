import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";

type GeocodeResponse = {
  status?: string;
  error_message?: string;
  results?: Array<{
    formatted_address?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
  }>;
};

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.emailVerified) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.GOOGLE_MAPS_GEOCODE_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Google Geocoding is not configured." }, { status: 503 });

  const { searchParams } = new URL(request.url);
  const placeId = searchParams.get("placeId")?.trim().slice(0, 220) || "";
  const language = searchParams.get("locale") === "de" ? "de" : "en";
  if (!placeId) return NextResponse.json({ error: "A place ID is required." }, { status: 400 });

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("language", language);
  url.searchParams.set("key", apiKey);
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json() as GeocodeResponse;
  const result = data.results?.[0];
  const location = result?.geometry?.location;

  if (!response.ok || data.status !== "OK" || !result?.formatted_address ||
      typeof location?.lat !== "number" || typeof location.lng !== "number") {
    return NextResponse.json({ error: data.error_message || "Unable to resolve this location." }, { status: 502 });
  }

  return NextResponse.json({
    placeId,
    label: result.formatted_address,
    latitude: location.lat,
    longitude: location.lng,
  });
}
