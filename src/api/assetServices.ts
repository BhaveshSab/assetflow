import { apiGet, unwrapList } from "@/lib/api";
import { fieldStr, type ApiRecord } from "@/types/api";

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
  const data = await apiGet<{ items?: ApiRecord[] } | ApiRecord[]>("/assets");
  const items = unwrapList(data);
  return items.map((a: ApiRecord) => ({
    id: fieldStr(a, "", "id"),
    name: fieldStr(a, "Unnamed asset", "name"),
    assetTag: fieldStr(a, "—", "assetTag"),
    category: fieldStr(a, "—", "category", "name"),
    location: fieldStr(a, "—", "location"),
    // `fieldStr(a)` with no field name read nothing, so every row fell back to
    // the table's "Unknown" — the status column never showed a real value.
    status:
      STATUS_LABEL[fieldStr(a, "", "status").toUpperCase()] ??
      fieldStr(a, "Unknown", "status"),
  }));
}
