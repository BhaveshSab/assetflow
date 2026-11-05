/**
 * Organization Service Layer
 *
 * All Organization Setup CRUD operations now talk to the real NestJS backend:
 *   GET/POST /org/departments, PATCH /org/departments/:id
 *   GET/POST /org/categories,  PATCH /org/categories/:id
 *   GET/PATCH /org/employees
 */
import { apiGet, apiSend } from "@/lib/api";
import {
  customFieldKeys,
  fieldNum,
  fieldStr,
  type ApiRecord,
} from "@/types/api";

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
  const data = await apiGet<{ items: ApiRecord[] }>("/org/departments");
  return (data.items ?? []).map((d) => ({
    id: fieldStr(d, "", "id"),
    name: fieldStr(d, "Unnamed department", "name"),
    head: fieldStr(d, "Unassigned", "head", "name"),
    headEmail: fieldStr(d, "", "head", "email"),
    parent: fieldStr(d, "", "parentDepartment", "name") || null,
    status: friendlyStatus(fieldStr(d, "ACTIVE", "status")),
    employeeCount: fieldNum(d, 0, "_count", "members"),
  }));
}

/** POST /org/departments  { name, headId?, parentDepartmentId?, status? } */
export async function createDepartment(data: DeptFormData): Promise<Department> {
  const headId = await userIdByName(data.head);
  const parentDepartmentId = await departmentIdByName(data.parent);
  const created = await apiSend<ApiRecord>("/org/departments", "POST", {
    name: data.name,
    headId: headId ?? undefined,
    parentDepartmentId: parentDepartmentId ?? undefined,
    status: data.status === "Inactive" ? "INACTIVE" : undefined,
  });
  return {
    id: fieldStr(created, "", "id"),
    name: fieldStr(created, data.name, "name"),
    head: fieldStr(created, data.head || "Unassigned", "head", "name"),
    headEmail: fieldStr(created, "", "head", "email"),
    parent: fieldStr(created, "", "parentDepartment", "name") || null,
    status: friendlyStatus(fieldStr(created, "ACTIVE", "status")),
    employeeCount: fieldNum(created, 0, "_count", "members"),
  };
}

/** PATCH /org/departments/:id */
export async function updateDepartment(
  id: string,
  data: Partial<DeptFormData>,
): Promise<Department> {
  const headId = data.head ? await userIdByName(data.head) : undefined;
  const parentDepartmentId = data.parent ? await departmentIdByName(data.parent) : undefined;
  const updated = await apiSend<ApiRecord>(`/org/departments/${id}`, "PATCH", {
    ...(data.name ? { name: data.name } : {}),
    ...(headId ? { headId } : data.head === "" ? { headId: null } : {}),
    ...(parentDepartmentId ? { parentDepartmentId } : data.parent === "" ? { parentDepartmentId: null } : {}),
    ...(data.status ? { status: data.status === "Inactive" ? "INACTIVE" : "ACTIVE" } : {}),
  });
  return {
    id: fieldStr(updated, id, "id"),
    name: fieldStr(updated, data.name ?? "", "name"),
    head: fieldStr(updated, "Unassigned", "head", "name"),
    headEmail: fieldStr(updated, "", "head", "email"),
    parent: fieldStr(updated, "", "parentDepartment", "name") || null,
    status: friendlyStatus(fieldStr(updated, "ACTIVE", "status")),
    employeeCount: fieldNum(updated, 0, "_count", "members"),
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
  const data = await apiGet<{ items: ApiRecord[] }>("/org/categories");
  return (data.items ?? []).map((c) => ({
    id: fieldStr(c, "", "id"),
    name: fieldStr(c, "Unnamed category", "name"),
    description: "",
    customFields: customFieldKeys(c.customFields),
    assetCount: fieldNum(c, 0, "_count", "assets"),
    status: friendlyStatus(fieldStr(c, "ACTIVE", "status")),
  }));
}

/** POST /org/categories  { name, customFields?, status? } */
export async function createCategory(data: CategoryFormData): Promise<AssetCategory> {
  const created = await apiSend<ApiRecord>("/org/categories", "POST", {
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
    id: fieldStr(created, "", "id"),
    name: fieldStr(created, data.name, "name"),
    description: "",
    customFields: customFieldKeys(created.customFields),
    assetCount: fieldNum(created, 0, "_count", "assets"),
    status: friendlyStatus(fieldStr(created, "ACTIVE", "status")),
  };
}

/** PATCH /org/categories/:id */
export async function updateCategory(
  id: string,
  data: Partial<CategoryFormData>,
): Promise<AssetCategory> {
  const updated = await apiSend<ApiRecord>(`/org/categories/${id}`, "PATCH", {
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
    id: fieldStr(updated, id, "id"),
    name: fieldStr(updated, data.name ?? "", "name"),
    description: "",
    customFields: customFieldKeys(updated.customFields),
    assetCount: fieldNum(updated, 0, "_count", "assets"),
    status: friendlyStatus(fieldStr(updated, "ACTIVE", "status")),
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
