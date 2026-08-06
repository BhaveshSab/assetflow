import { BASE_URL } from "@/lib/api";

/**
 * Asset Services API — live backend calls.
 * All other features (allocations, bookings, maintenance, audits, analytics,
 * org setup) fetch directly from their own components / services via @/lib/api.
 */

export interface Asset {
  id: string;
  name: string;
  assetTag: string;
  category: string;
  location: string;
  status: string;
}

/** Backend uppercase status → friendly display status. */
const STATUS_LABEL: Record<string, string> = {
  AVAILABLE: "Available",
  ALLOCATED: "Allocated",
  RESERVED: "Reserved",
  UNDER_MAINTENANCE: "Under Maintenance",
  LOST: "Lost",
  RETIRED: "Retired",
  DISPOSED: "Disposed",
};

/**
 * Fetches the full asset list from the backend.
 * GET /assets → { items: [...], total }.
 */
export async function getAssets(): Promise<Asset[]> {
  const res = await fetch(`${BASE_URL}/assets`, {
    headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch assets (${res.status})`);
  const data = await res.json();
  const items = Array.isArray(data) ? data : (data.items ?? []);
  return items.map((a: Record<string, any>) => ({
    id: a.id,
    name: a.name,
    assetTag: a.assetTag,
    category: a.category?.name ?? "—",
    location: a.location ?? "—",
    status: STATUS_LABEL[a.status] ?? a.status,
  }));
}
