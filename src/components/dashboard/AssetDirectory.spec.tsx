import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AssetDirectory from "./AssetDirectory";

vi.mock("@/api/assetServices", () => ({
  getAssets: vi.fn().mockResolvedValue([
    {
      id: "1",
      name: "Laptop A",
      assetTag: "AF-0001",
      category: "Electronics",
      location: "HQ-1F",
      status: "Available",
    },
    {
      id: "2",
      name: "Laptop B",
      assetTag: "AF-0002",
      category: "Electronics",
      location: "HQ-1F",
      status: "Allocated",
    },
    {
      id: "3",
      name: "Chair C",
      assetTag: "AF-0003",
      category: "Furniture",
      location: "HQ-2F",
      status: "Allocated",
    },
  ]),
}));

const rowNames = () =>
  Array.from(document.querySelectorAll("tbody tr"))
    .map((row) => row.textContent ?? "")
    .filter((text) => /AF-000/.test(text));

describe("AssetDirectory filters", () => {
  it("narrows the table with the status and category selects", async () => {
    render(<AssetDirectory />);

    await screen.findByText("Laptop A");
    expect(rowNames()).toHaveLength(3);

    fireEvent.change(screen.getByLabelText(/filter by status/i), {
      target: { value: "Allocated" },
    });
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    expect(rowNames().join(" ")).not.toContain("Laptop A");

    // A second filter on top of the first must narrow further, not reset.
    fireEvent.change(screen.getByLabelText(/filter by category/i), {
      target: { value: "Furniture" },
    });
    await waitFor(() => expect(rowNames()).toHaveLength(1));
    expect(rowNames()[0]).toContain("Chair C");

    fireEvent.change(screen.getByLabelText(/filter by status/i), {
      target: { value: "all" },
    });
    await waitFor(() => expect(rowNames()).toHaveLength(1));

    fireEvent.change(screen.getByLabelText(/filter by category/i), {
      target: { value: "all" },
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
  });
});
