import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { getSession } from "@/lib/auth";
interface Attachment {
  id: string;
  filename: string;
  size: number;
}
export default function AssetAttachments({ assetId }: { assetId: string }) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const manager = ["ADMIN", "ASSET_MANAGER"].includes(
    getSession()?.user.role ?? "",
  );
  const path = `/assets/${encodeURIComponent(assetId)}/attachments`;
  const load = useCallback(async () => {
    setItems(await apiGet<Attachment[]>(path));
  }, [path]);
  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, [load]);
  const upload = async (file: File) => {
    setBusy(true);
    setError("");
    try {
      if (!file.size || file.size > 5 * 1024 * 1024)
        throw new Error("Choose a file between 1 byte and 5 MiB.");
      const bytes = await file.arrayBuffer();
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const checksum = btoa(String.fromCharCode(...hash));
      const signed = await apiSend<{
        id: string;
        uploadUrl: string;
        headers: Record<string, string>;
      }>(path, "POST", {
        filename: file.name,
        contentType: file.type,
        size: file.size,
        checksum,
      });
      const response = await fetch(signed.uploadUrl, {
        method: "PUT",
        headers: signed.headers,
        body: file,
        credentials: "omit",
      });
      if (!response.ok)
        throw new Error(
          "S3 upload failed. Check the bucket CORS policy and upload configuration.",
        );
      await apiSend(`${path}/${signed.id}/complete`, "POST");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = async (id: string) => {
    try {
      const result = await apiSend<{ url: string }>(
        `${path}/${id}/download`,
        "POST",
      );
      window.location.assign(result.url);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (id: string) => {
    if (!window.confirm("Remove this attachment?")) return;
    try {
      await apiSend(`${path}/${id}`, "DELETE");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="space-y-3" aria-label="Private attachments">
      <h3 className="font-semibold">Private attachments</h3>
      <p className="text-sm text-ink-muted">
        Verified uploads. Downloads require sign-in and expire after 60 seconds.
      </p>
      {manager && (
        <label className="block">
          Upload PDF, PNG, JPEG or text (maximum 5 MiB)
          <input
            aria-label="Upload private attachment"
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.txt"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
        </label>
      )}
      {busy && <p role="status">Uploading and verifying…</p>}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {!items.length && (
        <p className="text-ink-muted">No private attachments.</p>
      )}
      <ul>
        {items.map((item) => (
          <li key={item.id} className="flex gap-3 py-2">
            <button
              className="text-info underline"
              onClick={() => {
                void download(item.id);
              }}
            >
              {item.filename}
            </button>
            <span>{Math.ceil(item.size / 1024)} KiB</span>
            {manager && (
              <button
                onClick={() => {
                  void remove(item.id);
                }}
                aria-label={`Remove ${item.filename}`}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
