/** QR carries an identifier only. Never navigate arbitrary scanned URLs. */
export function readAssetTag(value: string): string {
  const tag = value.trim().replace(/^assetflow:/, "");
  if (!/^AF-[0-9]{4,12}$/.test(tag))
    throw new Error("Scan an AssetFlow label or enter a tag such as AF-0001.");
  return tag;
}
