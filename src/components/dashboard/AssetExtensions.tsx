import { Dialog } from "@/components/ui/dialog";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import AssetAttachments from "./AssetAttachments";
export default function AssetExtensions({
  asset,
  onClose,
}: {
  asset: { id: string; name: string; assetTag: string };
  onClose: () => void;
}) {
  const [qr, setQr] = useState("");
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(`assetflow:${asset.assetTag}`, {
      width: 256,
      margin: 4,
    }).then((url) => {
      if (active) setQr(url);
    });
    return () => {
      active = false;
    };
  }, [asset.assetTag]);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Files and QR for ${asset.name}`}
      panelClassName="max-w-3xl"
    >
      <section className="space-y-5 p-4">
        <button
          className="float-right"
          onClick={onClose}
          aria-label="Close asset files"
        >
          Close
        </button>
        <h2 className="font-semibold">{asset.name}</h2>
        {qr && (
          <div>
            <img
              src={qr}
              alt={`QR label ${asset.assetTag}`}
              width={256}
              height={256}
            />
            <p>{asset.assetTag}</p>
            <a
              href={qr}
              download={`${asset.assetTag}.png`}
              className="text-info underline"
            >
              Download QR label
            </a>
          </div>
        )}
        <AssetAttachments assetId={asset.id} />
      </section>
    </Dialog>
  );
}
