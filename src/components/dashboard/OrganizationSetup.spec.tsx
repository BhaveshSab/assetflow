import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import OrganizationSetup from "./OrganizationSetup";

// A head whose email is missing must still be shown — the row used to fall
// back to "Unassigned" whenever the email was absent.
vi.mock("@/services/organizationService", () => ({
  fetchDepartments: vi.fn().mockResolvedValue([
    {
      id: "d1",
      name: "QA Dept",
      head: "Ava Admin",
      headEmail: "",
      parent: null,
      status: "Active",
      employeeCount: 0,
    },
    {
      id: "d2",
      name: "Empty Dept",
      head: "Unassigned",
      headEmail: "",
      parent: null,
      status: "Active",
      employeeCount: 2,
    },
  ]),
  fetchCategories: vi.fn().mockResolvedValue([]),
  createDepartment: vi.fn(),
  updateDepartment: vi.fn(),
  toggleDepartmentStatus: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  toggleCategoryStatus: vi.fn(),
}));

describe("OrganizationSetup departments", () => {
  it("shows a department's head even when no email is returned", async () => {
    render(<OrganizationSetup />);

    await screen.findByText("QA Dept");
    await waitFor(() => expect(screen.getByText("Ava Admin")).toBeTruthy());

    const emptyRow = screen.getByText("Empty Dept").closest("tr");
    expect(emptyRow?.textContent).toContain("Unassigned");
  });
});
