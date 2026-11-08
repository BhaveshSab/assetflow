import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, apiSend } from "@/lib/api";
import AssignedAudits from "./AssignedAudits";
import AssetScanner from "./AssetScanner";
import AssetAttachments from "./AssetAttachments";
import AssetImport from "./AssetImport";
import AuditCycleModal from "./AuditCycleModal";
vi.mock("@/lib/api", () => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getSession: () => ({ user: { role: "ADMIN" } }),
}));
vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class {
    start() {
      return Promise.reject(new Error("denied"));
    }
  },
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe("Asset extension workflows", () => {
  it("validates a manual QR tag and provides a camera-denied fallback", async () => {
    const onTag = vi.fn();
    render(<AssetScanner onTag={onTag} />);
    fireEvent.change(screen.getByLabelText("Asset tag"), {
      target: { value: "https://evil.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up tag" }));
    expect(onTag).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Asset tag"), {
      target: { value: "assetflow:AF-0001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up tag" }));
    expect(onTag).toHaveBeenCalledWith("AF-0001");
    fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    expect(await screen.findByText(/Camera unavailable/)).toBeInTheDocument();
  });
  it("hashes and uploads directly to storage without sending the API bearer token, then completes verification", async () => {
    vi.mocked(apiGet).mockResolvedValue([]);
    vi.mocked(apiSend)
      .mockResolvedValueOnce({
        id: "attachment",
        uploadUrl: "https://s3.test/upload",
        headers: {
          "Content-Type": "application/pdf",
          "x-amz-checksum-sha256": "hash",
        },
      })
      .mockResolvedValueOnce({ status: "READY" });
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", {
      subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) },
    });
    render(<AssetAttachments assetId="asset" />);
    const file = new File(["%PDF-hello"], "manual.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("%PDF-hello").buffer,
    });
    fireEvent.change(screen.getByLabelText("Upload private attachment"), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith(
        "/assets/asset/attachments/attachment/complete",
        "POST",
      ),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://s3.test/upload",
      expect.objectContaining({
        method: "PUT",
        body: file,
        credentials: "omit",
      }),
    );
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it("requires a valid preview and explicit confirmation before creating an import", async () => {
    vi.mocked(apiGet).mockResolvedValue([]);
    vi.mocked(apiSend)
      .mockResolvedValueOnce({
        id: "preview",
        status: "DRAFT",
        total: 1,
        errors: [],
        preview: [{ name: "Laptop", categoryId: "category" }],
      })
      .mockResolvedValueOnce({ status: "PENDING" });
    render(<AssetImport onClose={vi.fn()} onImported={vi.fn()} />);
    expect(screen.queryByText(/Confirm import/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("CSV contents"), {
      target: { value: "name,categoryId\nLaptop,category" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Validate and preview" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm import of 1 assets" }),
    );
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith(
        "/asset-imports/preview/confirm",
        "POST",
      ),
    );
  });
  it("shows copyable active category IDs without requiring a developer console", async () => {
    vi.mocked(apiGet).mockImplementation(async (path) =>
      path.startsWith("/org/categories")
        ? { items: [{ id: "category-id", name: "Electronics" }] }
        : [],
    );
    render(<AssetImport onClose={vi.fn()} onImported={vi.fn()} />);
    expect(await screen.findByLabelText("Electronics category ID")).toHaveValue(
      "category-id",
    );
  });
  it("lets assigned employees open their own audit workflow from the scan screen", async () => {
    vi.mocked(apiGet).mockImplementation(async (path) =>
      path === "/audits/assigned"
        ? [{ id: "cycle", name: "Quarterly audit" }]
        : { items: [] },
    );
    render(<AssignedAudits />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Quarterly audit" }),
    );
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        expect.stringContaining("/audits/cycle/items"),
      ),
    );
  });
  it("resolves an audit scan without automatically marking the asset", async () => {
    vi.mocked(apiGet).mockResolvedValue({ items: [] });
    vi.mocked(apiSend).mockResolvedValue({
      id: "item",
      result: "PENDING",
      asset: { id: "asset", assetTag: "AF-0001", name: "Laptop" },
    });
    render(
      <AuditCycleModal
        cycleId="cycle"
        title="Audit"
        mode="items"
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Asset tag"), {
      target: { value: "AF-0001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up tag" }));
    await screen.findByText(/Confirm the physical finding/);
    expect(apiSend).toHaveBeenCalledTimes(1);
    expect(apiSend).toHaveBeenCalledWith("/audits/cycle/scan", "POST", {
      tag: "AF-0001",
    });
    fireEvent.click(screen.getByRole("button", { name: "VERIFIED" }));
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith(
        "/audits/cycle/items/item",
        "PATCH",
        { result: "VERIFIED" },
      ),
    );
  });
});
