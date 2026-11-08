import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import AuditCycleModal from "./AuditCycleModal";
interface AssignedCycle {
  id: string;
  name: string;
}
/** Employees see only assigned open cycles, never the global manager directory. */
export default function AssignedAudits() {
  const [cycles, setCycles] = useState<AssignedCycle[]>([]);
  const [selected, setSelected] = useState<AssignedCycle>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void apiGet<AssignedCycle[]>("/audits/assigned")
      .then((data) => {
        if (active) setCycles(data);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <section className="space-y-3 border-t border-line pt-4">
      <h3 className="font-semibold">My assigned open audits</h3>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {!cycles.length && (
        <p className="text-ink-muted">
          No open audits assigned to you. Managers can also scan from Continue
          Audit.
        </p>
      )}
      <ul>
        {cycles.map((cycle) => (
          <li key={cycle.id}>
            <button
              className="text-info underline"
              onClick={() => setSelected(cycle)}
            >
              {cycle.name}
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <AuditCycleModal
          cycleId={selected.id}
          title={selected.name}
          mode="items"
          onClose={() => setSelected(undefined)}
        />
      )}
    </section>
  );
}
