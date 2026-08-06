/**
 * Organization Service Layer
 *
 * All Organization Setup CRUD operations now talk to the real NestJS backend:
 *   GET/POST /org/departments, PATCH /org/departments/:id
 *   GET/POST /org/categories,  PATCH /org/categories/:id
 *   GET/PATCH /org/employees
 */
import { apiGet, apiSend } from "@/lib/api";

// =============================================
// TYPES
// =============================================

export interface Department {
  id: string;
  name: string;
  head: string;
  headEmail: string;
  parent: string | null;
  status: string;
  employeeCount: number;
}

export interface AssetCategory {
  id: string;
  name: string;
  description: string;
  customFields: string[];
  assetCount: number;
  status: string;
}

export interface DeptFormData {
  name: string;
  head: string;
  parent: string;
  status: string;
}

export interface CategoryFormData {
  name: string;
  description: string;
  customFields: string;
  status: string;
}

// =============================================
// HELPERS
// =============================================

/** Resolve a department name → id (for parentDepartmentId in create/update). */
async function departmentIdByName(name: string): Promise<string | undefined> {
  if (!name) return undefined;
  const data = await apiGet<{ items: Array<{ id: string; name: string }> }>(
    `/org/departments?q=${encodeURIComponent(name)}`,
  );
  return data.items.find((d) => d.name.toLowerCase() === name.toLowerCase())?.id;
}

/** Resolve an employee name → id (for headId in create/update). */
async function userIdByName(name: string): Promise<string | undefined> {
  if (!name) return undefined;
  const data = await apiGet<{ items: Array<{ id: string; name: string }> }>(
    `/org/employees?q=${encodeURIComponent(name)}`,
  );
  return data.items.find((e) => e.name.toLowerCase() === name.toLowerCase())?.id;
}

const friendlyStatus = (s: string) => (s === "INACTIVE" ? "Inactive" : "Active");

// =============================================
// DEPARTMENT API
// =============================================

/** GET /org/departments */
export async function fetchDepartments(): Promise<Department[]> {
  const data = await apiGet<{ items: Array<Record<string, any>> }>("/org/departments");
  return (data.items ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    head: d.head?.name ?? "Unassigned",
    headEmail: d.head?.email ?? "",
    parent: d.parentDepartment?.name ?? null,
    status: friendlyStatus(d.status),
    employeeCount: d._count?.members ?? 0,
  }));
}

/** POST /org/departments  { name, headId?, parentDepartmentId?, status? } */
export async function createDepartment(data: DeptFormData): Promise<Department> {
  const headId = await userIdByName(data.head);
  const parentDepartmentId = await departmentIdByName(data.parent);
  const created = await apiSend<Record<string, any>>("/org/departments", "POST", {
    name: data.name,
    headId: headId ?? undefined,
    parentDepartmentId: parentDepartmentId ?? undefined,
    status: data.status === "Inactive" ? "INACTIVE" : undefined,
  });
  return {
    id: created.id,
    name: created.name,
    head: created.head?.name ?? (data.head || "Unassigned"),
    headEmail: created.head?.email ?? "",
    parent: created.parentDepartment?.name ?? null,
    status: friendlyStatus(created.status),
    employeeCount: created._count?.members ?? 0,
  };
}

/** PATCH /org/departments/:id */
export async function updateDepartment(
  id: string,
  data: Partial<DeptFormData>,
): Promise<Department> {
  const headId = data.head ? await userIdByName(data.head) : undefined;
  const parentDepartmentId = data.parent ? await departmentIdByName(data.parent) : undefined;
  const updated = await apiSend<Record<string, any>>(`/org/departments/${id}`, "PATCH", {
    ...(data.name ? { name: data.name } : {}),
    ...(headId ? { headId } : data.head === "" ? { headId: null } : {}),
    ...(parentDepartmentId ? { parentDepartmentId } : data.parent === "" ? { parentDepartmentId: null } : {}),
    ...(data.status ? { status: data.status === "Inactive" ? "INACTIVE" : "ACTIVE" } : {}),
  });
  return {
    id: updated.id,
    name: updated.name,
    head: updated.head?.name ?? "Unassigned",
    headEmail: updated.head?.email ?? "",
    parent: updated.parentDepartment?.name ?? null,
    status: friendlyStatus(updated.status),
    employeeCount: updated._count?.members ?? 0,
  };
}

/** PATCH /org/departments/:id { status } */
export async function toggleDepartmentStatus(
  id: string,
  currentStatus: string,
): Promise<string> {
  const next = currentStatus === "Active" ? "INACTIVE" : "ACTIVE";
  const updated = await apiSend<{ status: string }>(`/org/departments/${id}`, "PATCH", {
    status: next,
  });
  return friendlyStatus(updated.status);
}

// =============================================
// ASSET CATEGORY API
// =============================================

/** GET /org/categories */
export async function fetchCategories(): Promise<AssetCategory[]> {
  const data = await apiGet<{ items: Array<Record<string, any>> }>("/org/categories");
  return (data.items ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    description: "",
    customFields: Array.isArray(c.customFields)
      ? c.customFields.map((f: any) => f?.key ?? String(f))
      : [],
    assetCount: c._count?.assets ?? 0,
    status: friendlyStatus(c.status),
  }));
}

/** POST /org/categories  { name, customFields?, status? } */
export async function createCategory(data: CategoryFormData): Promise<AssetCategory> {
  const created = await apiSend<Record<string, any>>("/org/categories", "POST", {
    name: data.name,
    customFields: data.customFields
      ? data.customFields
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
          .map((key) => ({ key, type: "string" }))
      : undefined,
    status: data.status === "Inactive" ? "INACTIVE" : undefined,
  });
  return {
    id: created.id,
    name: created.name,
    description: "",
    customFields: Array.isArray(created.customFields)
      ? created.customFields.map((f: any) => f?.key ?? String(f))
      : [],
    assetCount: created._count?.assets ?? 0,
    status: friendlyStatus(created.status),
  };
}

/** PATCH /org/categories/:id */
export async function updateCategory(
  id: string,
  data: Partial<CategoryFormData>,
): Promise<AssetCategory> {
  const updated = await apiSend<Record<string, any>>(`/org/categories/${id}`, "PATCH", {
    ...(data.name ? { name: data.name } : {}),
    ...(data.customFields !== undefined
      ? {
          customFields: data.customFields
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean)
            .map((key) => ({ key, type: "string" })),
        }
      : {}),
    ...(data.status ? { status: data.status === "Inactive" ? "INACTIVE" : "ACTIVE" } : {}),
  });
  return {
    id: updated.id,
    name: updated.name,
    description: "",
    customFields: Array.isArray(updated.customFields)
      ? updated.customFields.map((f: any) => f?.key ?? String(f))
      : [],
    assetCount: updated._count?.assets ?? 0,
    status: friendlyStatus(updated.status),
  };
}

/** PATCH /org/categories/:id { status } */
export async function toggleCategoryStatus(
  id: string,
  currentStatus: string,
): Promise<string> {
  const next = currentStatus === "Active" ? "INACTIVE" : "ACTIVE";
  const updated = await apiSend<{ status: string }>(`/org/categories/${id}`, "PATCH", {
    status: next,
  });
  return friendlyStatus(updated.status);
}
