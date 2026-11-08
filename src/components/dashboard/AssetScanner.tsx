import { useEffect, useId, useRef, useState } from "react";
import type { Html5Qrcode } from "html5-qrcode";
import { readAssetTag } from "@/lib/qr";

export default function AssetScanner({
  onTag,
}: {
  onTag: (tag: string) => void;
}) {
  const id = `qr-${useId().replace(/:/g, "")}`;
  const camera = useRef<Html5Qrcode>();
  const mounted = useRef(true);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const onTagRef = useRef(onTag);
  useEffect(() => {
    onTagRef.current = onTag;
  }, [onTag]);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (camera.current?.isScanning)
        void camera.current.stop().catch(() => undefined);
    };
  }, []);
  const resolve = (text: string) => {
    try {
      const tag = readAssetTag(text);
      setValue(tag);
      setError("");
      onTagRef.current(tag);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const stop = async () => {
    if (camera.current?.isScanning) await camera.current.stop();
    if (mounted.current) setRunning(false);
  };
  const start = async () => {
    setError("");
    setRunning(true);
    setStarting(true);
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      if (!mounted.current) return;
      camera.current = new Html5Qrcode(id);
      await camera.current.start(
        { facingMode: "environment" },
        { fps: 5, qrbox: 220 },
        (text) => {
          resolve(text);
          void stop();
        },
        () => undefined,
      );
      if (mounted.current) setStarting(false);
      if (!mounted.current && camera.current.isScanning)
        await camera.current.stop();
    } catch {
      if (mounted.current) {
        setError(
          "Camera unavailable or permission denied. Enter the asset tag instead.",
        );
        setRunning(false);
        setStarting(false);
      }
    }
  };
  return (
    <section className="space-y-3" aria-label="Asset scanner">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          resolve(value);
        }}
      >
        <label className="flex-1">
          Asset tag
          <input
            aria-label="Asset tag"
            className="block w-full bg-canvas border border-line rounded p-2"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="AF-0001"
          />
        </label>
        <button className="border border-line rounded px-3" type="submit">
          Look up tag
        </button>
        <button
          className="border border-line rounded px-3"
          type="button"
          disabled={starting}
          onClick={() => {
            void (running ? stop() : start());
          }}
        >
          {running ? "Stop camera" : "Scan with camera"}
        </button>
      </form>
      <div id={id} className={running ? "max-w-sm" : "hidden"} />
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
