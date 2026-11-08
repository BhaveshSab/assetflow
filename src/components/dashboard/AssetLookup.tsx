import { useState } from "react";
import { apiGet } from "@/lib/api";
import AssignedAudits from "./AssignedAudits";
import AssetScanner from "./AssetScanner";
import AssetAttachments from "./AssetAttachments";
interface Asset {
  id: string;
  name: string;
  assetTag: string;
  status: string;
  location: string | null;
}
export default function AssetLookup() {
  const [asset, setAsset] = useState<Asset>();
  const [error, setError] = useState("");
  const lookup = async (tag: string) => {
    setError("");
    setAsset(undefined);
    try {
      setAsset(
        await apiGet<Asset>(
          `/assets/lookup/by-tag?tag=${encodeURIComponent(tag)}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="space-y-5">
      <h2 className="text-xl font-semibold">Asset lookup</h2>
      <AssetScanner
        onTag={(tag) => {
          void lookup(tag);
        }}
      />
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {asset && (
        <article className="space-y-4">
          <h3 className="font-semibold">
            {asset.name} · {asset.assetTag}
          </h3>
          <p>
            {asset.status} · {asset.location || "No location"}
          </p>
          <AssetAttachments key={asset.id} assetId={asset.id} />
        </article>
      )}
      <AssignedAudits />
    </section>
  );
}
