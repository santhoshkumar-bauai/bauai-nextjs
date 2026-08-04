import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";

type GoogleAutocompleteResponse = {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }>;
  error?: { message?: string };
};

type GoogleGeocodeResponse = {
  status?: string;
  results?: Array<{
    place_id?: string;
    formatted_address?: string;
    address_components?: Array<{ long_name?: string; types?: string[] }>;
  }>;
};

async function geocodeFallback(input: string, language: string) {
  const apiKey = process.env.GOOGLE_MAPS_GEOCODE_API_KEY;
  if (!apiKey) return [];
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", input);
  url.searchParams.set("language", language);
  url.searchParams.set("key", apiKey);
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json() as GoogleGeocodeResponse;
  if (!response.ok || data.status !== "OK") return [];
  return (data.results || []).flatMap((result) => {
    if (!result.place_id || !result.formatted_address) return [];
    const locality = result.address_components?.find((part) =>
      part.types?.some((type) => ["locality", "administrative_area_level_1", "administrative_area_level_2", "country"].includes(type)),
    )?.long_name;
    return [{
      placeId: result.place_id,
      label: result.formatted_address,
      primary: locality || result.formatted_address.split(",")[0],
      secondary: result.formatted_address,
    }];
  }).slice(0, 6);
}

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.emailVerified) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const input = searchParams.get("q")?.trim().slice(0, 120) || "";
  const languageCode = searchParams.get("locale") === "de" ? "de" : "en";
  if (input.length < 3) return NextResponse.json({ items: [] });

  const placesEnabled = process.env.GOOGLE_PLACES_ENABLED === "true";
  if (!placesEnabled) {
    const items = await geocodeFallback(input, languageCode);
    return NextResponse.json({ items, source: "geocoding" });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Google Places is not configured." }, { status: 503 });

  const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat",
    },
    body: JSON.stringify({
      input,
      languageCode,
      includedPrimaryTypes: ["locality", "administrative_area_level_1", "administrative_area_level_2", "country"],
    }),
    cache: "no-store",
  });
  const data = await response.json() as GoogleAutocompleteResponse;
  if (!response.ok) {
    const fallbackItems = await geocodeFallback(input, languageCode);
    return NextResponse.json({
      items: fallbackItems,
      source: "geocoding",
      placesUnavailable: true,
    });
  }

  const items = (data.suggestions || []).flatMap((suggestion) => {
    const prediction = suggestion.placePrediction;
    if (!prediction?.placeId || !prediction.text?.text) return [];
    return [{
      placeId: prediction.placeId,
      label: prediction.text.text,
      primary: prediction.structuredFormat?.mainText?.text || prediction.text.text,
      secondary: prediction.structuredFormat?.secondaryText?.text || "",
    }];
  }).slice(0, 6);
  if (!items.length) {
    const fallbackItems = await geocodeFallback(input, languageCode);
    return NextResponse.json({ items: fallbackItems, source: "geocoding" });
  }

  return NextResponse.json({
    items,
    source: "places",
  });
}
