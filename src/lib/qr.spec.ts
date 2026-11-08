import { describe, expect, it } from "vitest";
import { readAssetTag } from "./qr";
describe("QR identifiers", () => {
  it("accepts generated labels and manual tags", () => {
    expect(readAssetTag("assetflow:AF-0001")).toBe("AF-0001");
    expect(readAssetTag(" AF-12345 ")).toBe("AF-12345");
  });
  it.each([
    "https://evil.test",
    "javascript:alert(1)",
    "assetflow:ADMIN",
    "AF-1",
    "AF-0001?token=secret",
  ])("rejects navigation/credentials and invalid labels: %s", (value) =>
    expect(() => readAssetTag(value)).toThrow(),
  );
});
