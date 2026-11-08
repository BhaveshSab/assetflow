import { Dialog } from "@/components/ui/dialog";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
interface Job {
  id: string;
  status: string;
  total: number;
  imported: number;
  lastError: string | null;
}
interface Preview {
  id: string | null;
  status: string;
  total: number;
  errors: { row: number; field: string; message: string }[];
  preview: { name: string; categoryId: string }[];
}
export default function AssetImport({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [csv, setCsv] = useState(
    "name,categoryId,serialNumber,location,condition,isBookable\n",
  );
  const [preview, setPreview] = useState<Preview>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setJobs(await apiGet<Job[]>("/asset-imports"));
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await load();
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped)
        timer = setTimeout(() => {
          void poll();
        }, 5000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load]);
  const validate = async () => {
    setBusy(true);
    setError("");
    setPreview(undefined);
    try {
      setPreview(
        await apiSend<Preview>("/asset-imports/preview", "POST", { csv }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const transition = async (id: string, action: string) => {
    setBusy(true);
    setError("");
    try {
      await apiSend(`/asset-imports/${id}/${action}`, "POST");
      if (action === "confirm") setPreview(undefined);
      await load();
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={"Bulk asset import"}
      panelClassName="max-w-3xl"
    >
      <section className="space-y-5 p-4">
        <button className="float-right" onClick={onClose}>
          Close import
        </button>
        <h2 className="font-semibold text-xl">Bulk asset import</h2>
        <p>
          Maximum 200 rows / 60,000 bytes. Use active category IDs from
          Organization Setup. Validate first, then explicitly confirm. Every
          batch commits all rows or none.
        </p>
        <label>
          CSV file
          <input
            aria-label="CSV file"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 60000) {
                setError("CSV exceeds 60,000 bytes");
                return;
              }
              void f.text().then((text) => {
                setCsv(text);
                setPreview(undefined);
              });
            }}
          />
        </label>
        <label className="block">
          CSV contents
          <textarea
            aria-label="CSV contents"
            className="block bg-canvas border border-line w-full p-2 font-mono"
            rows={7}
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setPreview(undefined);
            }}
          />
        </label>
        <button
          disabled={busy}
          className="bg-info text-white px-4 py-2 rounded"
          onClick={() => {
            void validate();
          }}
        >
          Validate and preview
        </button>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {preview && (
          <section aria-label="Import preview">
            <p>
              {preview.total} rows · {preview.status}
            </p>
            <ul>
              {preview.errors.map((e, i) => (
                <li key={i} className="text-danger">
                  Row {e.row}, {e.field}: {e.message}
                </li>
              ))}
            </ul>
            <ul>
              {preview.preview.map((r, i) => (
                <li key={i}>
                  {r.name} · {r.categoryId}
                </li>
              ))}
            </ul>
            {preview.id && !preview.errors.length && (
              <button
                disabled={busy}
                className="bg-info text-white p-2 rounded"
                onClick={() => {
                  void transition(preview.id!, "confirm");
                }}
              >
                Confirm import of {preview.total} assets
              </button>
            )}
          </section>
        )}
        <h3 className="font-semibold">
          Recent imports (refresh every 5 seconds)
        </h3>
        <button
          onClick={() => {
            onImported();
            void load().catch((e) => setError((e as Error).message));
          }}
        >
          Refresh assets and status
        </button>
        <ul>
          {jobs.map((job) => (
            <li key={job.id} className="py-2 border-b border-line">
              <span>
                {job.status}: {job.imported}/{job.total} imported{" "}
                {job.lastError ? `· ${job.lastError}` : ""}
              </span>
              {job.status === "FAILED" && (
                <button
                  disabled={busy}
                  className="ml-3 underline"
                  onClick={() => {
                    void transition(job.id, "retry");
                  }}
                >
                  Retry
                </button>
              )}
              {["DRAFT", "PENDING", "QUEUED"].includes(job.status) && (
                <button
                  disabled={busy}
                  className="ml-3 underline"
                  onClick={() => {
                    void transition(job.id, "cancel");
                  }}
                >
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </Dialog>
  );
}
