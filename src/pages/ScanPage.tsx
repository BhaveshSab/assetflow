import { Navigate, Link } from "react-router-dom";
import { getSession } from "@/lib/auth";
import AssetLookup from "@/components/dashboard/AssetLookup";
export default function ScanPage() {
  if (!getSession()) return <Navigate to="/signin?next=%2Fscan" replace />;
  return (
    <main className="min-h-screen bg-canvas text-ink p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <Link to="/Dashboard" className="text-info underline">
          Back to dashboard
        </Link>
        <AssetLookup />
      </div>
    </main>
  );
}
