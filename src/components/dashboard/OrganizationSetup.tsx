import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Building2, Search, Plus, MoreVertical, Users, Network,
  CheckCircle2, XCircle, AlertCircle, Layers, Contact,
  Tag, Settings2, Box, Edit2, X, Loader2,
  User, UserCheck, UserX, Shield, ShieldCheck, ShieldAlert,
  Crown, Briefcase, Mail, Trash2, ChevronDown, Check,
} from "lucide-react";
import {
  fetchDepartments, createDepartment, updateDepartment, toggleDepartmentStatus,
  fetchCategories, createCategory, updateCategory, toggleCategoryStatus,
  type Department, type AssetCategory, type DeptFormData, type CategoryFormData,
} from "@/services/organizationService";
import { apiGet, apiSend } from "@/lib/api";

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 300, damping: 24 } },
};

// ─────────────────────────────────────────────────────────────
// EMPLOYEE DIRECTORY — Types & Service
// ─────────────────────────────────────────────────────────────
interface Employee {
  id: string;
  name: string;
  email: string;
  department: string;
  role: string;
  status: string;
  joinedOn: string;
  avatar: string;
}

interface EmployeeFormData {
  name: string;
  email: string;
  department: string;
  role: string;
  status: string;
}

const ROLE_TO_ENUM: Record<string, string> = {
  Employee: "EMPLOYEE",
  "Department Head": "DEPARTMENT_HEAD",
  "Asset Manager": "ASSET_MANAGER",
  Admin: "ADMIN",
};

const ENUM_TO_ROLE: Record<string, string> = {
  EMPLOYEE: "Employee",
  DEPARTMENT_HEAD: "Department Head",
  ASSET_MANAGER: "Asset Manager",
  ADMIN: "Admin",
};

const initialsOf = (name: string) =>
  name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

const deptIdByName = async (name: string): Promise<string | undefined> => {
  if (!name) return undefined;
  const data = await apiGet<{ items: Array<{ id: string; name: string }> }>(
    `/org/departments?q=${encodeURIComponent(name)}`,
  );
  return data.items.find((d) => d.name.toLowerCase() === name.toLowerCase())?.id;
};

const toEmployee = (e: Record<string, any>): Employee => ({
  id: e.id,
  name: e.name,
  email: e.email,
  department: e.department?.name ?? "—",
  role: ENUM_TO_ROLE[e.role] ?? e.role,
  status: e.status === "INACTIVE" ? "Inactive" : "Active",
  joinedOn: e.createdAt ? e.createdAt.slice(0, 10) : "",
  avatar: initialsOf(e.name ?? "??"),
});

const employeeService = {
  getAll: async (): Promise<Employee[]> => {
    const data = await apiGet<{ items: Array<Record<string, any>> }>("/org/employees");
    return (data.items ?? []).map(toEmployee);
  },
  create: async (data: EmployeeFormData & { avatar: string }): Promise<Employee> => {
    const departmentId = await deptIdByName(data.department);
    const created = await apiSend<Record<string, any>>("/org/employees", "POST", {
      name: data.name,
      email: data.email,
      departmentId: departmentId ?? undefined,
      role: ROLE_TO_ENUM[data.role] ?? "EMPLOYEE",
    });
    return toEmployee(created);
  },
  update: async (id: string, data: Partial<Employee>): Promise<Employee> => {
    const payload: Record<string, any> = {
      ...(data.name ? { name: data.name } : {}),
      ...(data.status ? { status: data.status === "Active" ? "ACTIVE" : "INACTIVE" } : {}),
    };
    if (data.department) {
      const departmentId = await deptIdByName(data.department);
      if (departmentId) payload.departmentId = departmentId;
    }
    const updated = await apiSend<Record<string, any>>(`/org/employees/${id}`, "PATCH", payload);
    // Role changes go through the dedicated role endpoint.
    if (data.role && ENUM_TO_ROLE[updated.role] !== data.role) {
      await apiSend(`/org/employees/${id}/role`, "PATCH", {
        role: ROLE_TO_ENUM[data.role] ?? "EMPLOYEE",
      });
    }
    return toEmployee({ ...updated, role: data.role ? ROLE_TO_ENUM[data.role] : updated.role });
  },
  delete: async (id: string): Promise<{ success: boolean }> => {
    // No hard delete — deactivate the account instead.
    await apiSend(`/org/employees/${id}`, "PATCH", { status: "INACTIVE" });
    return { success: true };
  },
  promote: async (id: string, role: string): Promise<{ id: string; role: string }> => {
    const updated = await apiSend<{ id: string; role: string }>(
      `/org/employees/${id}/role`,
      "PATCH",
      { role: ROLE_TO_ENUM[role] ?? "EMPLOYEE" },
    );
    return { id: updated.id, role: ENUM_TO_ROLE[updated.role] ?? updated.role };
  },
  toggleStatus: async (id: string, status: string): Promise<{ id: string; status: string }> => {
    const updated = await apiSend<{ id: string; status: string }>(
      `/org/employees/${id}`,
      "PATCH",
      { status: status === "Active" ? "ACTIVE" : "INACTIVE" },
    );
    return { id: updated.id, status: updated.status === "INACTIVE" ? "Inactive" : "Active" };
  },
};

const ROLES = ["Employee", "Department Head", "Asset Manager", "Admin"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const roleConfig: Record<string, { label: string; color: string; dot: string; icon: any; description: string }> = {
  Admin:             { label: "Admin",         color: "bg-purple-500/20 text-purple-300 border-purple-500/30", dot: "bg-purple-400", icon: Crown,       description: "Full system access" },
  "Asset Manager":   { label: "Asset Manager", color: "bg-blue-500/20 text-blue-300 border-blue-500/30",       dot: "bg-blue-400",   icon: ShieldCheck, description: "Manages assets & approvals" },
  "Department Head": { label: "Dept. Head",    color: "bg-amber-500/20 text-amber-300 border-amber-500/30",   dot: "bg-amber-400",  icon: Briefcase,   description: "Manages department assets" },
  Employee:          { label: "Employee",      color: "bg-zinc-700/60 text-zinc-300 border-zinc-600/40",      dot: "bg-zinc-400",   icon: User,        description: "Standard access" },
};

const avatarColors = [
  "bg-blue-600", "bg-purple-600", "bg-emerald-600", "bg-amber-600", "bg-rose-600",
  "bg-cyan-600", "bg-indigo-600", "bg-pink-600", "bg-teal-600", "bg-orange-600",
];
const getAvatarColor = (id: string | number) =>
  avatarColors[String(id).charCodeAt(0) % avatarColors.length];

const validateEmployee = (form: EmployeeFormData, employees: Employee[], editingId?: string) => {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors.name = "Full name is required";
  if (!form.email.trim()) errors.email = "Email is required";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = "Enter a valid email address";
  else if (employees.some((e) => e.email === form.email && e.id !== editingId)) errors.email = "This email is already registered";
  if (!form.department) errors.department = "Select a department";
  if (!form.role) errors.role = "Select a role";
  return errors;
};

// ── Sub-components for Employee Directory ──

const RoleBadge = ({ role }: { role: string }) => {
  const cfg = roleConfig[role] ?? roleConfig.Employee;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${cfg.color}`}>
      <Icon size={10} />
      {cfg.label}
    </span>
  );
};

const StatusPill = ({ status }: { status: string }) => (
  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border
    ${status === "Active" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-zinc-700/40 text-zinc-400 border-zinc-600/30"}`}>
    <span className={`w-1.5 h-1.5 rounded-full ${status === "Active" ? "bg-emerald-400" : "bg-zinc-500"}`} />
    {status}
  </span>
);

const EmployeeToast = ({ toast }: { toast: { msg: string; type: string } | null }) => (
  <AnimatePresence>
    {toast && (
      <motion.div
        initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
        className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-5 py-3 rounded-xl text-sm font-medium shadow-2xl border flex items-center gap-2
          ${toast.type === "error" ? "bg-red-950 border-red-500/40 text-red-300" : toast.type === "warning" ? "bg-amber-950 border-amber-500/40 text-amber-300" : "bg-emerald-950 border-emerald-500/40 text-emerald-300"}`}
      >
        {toast.type === "error" ? <XCircle size={15} /> : toast.type === "warning" ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
        {toast.msg}
      </motion.div>
    )}
  </AnimatePresence>
);

interface ConfirmState { title: string; message: string; danger?: boolean; confirmLabel?: string; onConfirm: () => void }

const EmployeeConfirmDialog = ({ open, title, message, onConfirm, onCancel, confirmLabel = "Confirm", danger = false }: {
  open: boolean; title?: string; message?: string; onConfirm: () => void; onCancel: () => void; confirmLabel?: string; danger?: boolean
}) => (
  <AnimatePresence>
    {open && (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[150] flex items-center justify-center p-4" onClick={onCancel}>
        <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
          onClick={(e) => e.stopPropagation()} className="bg-[#1a1d2e] border border-zinc-700 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 ${danger ? "bg-red-500/20" : "bg-amber-500/20"}`}>
            <AlertCircle size={22} className={danger ? "text-red-400" : "text-amber-400"} />
          </div>
          <h3 className="text-white font-bold text-center mb-1">{title}</h3>
          <p className="text-gray-400 text-sm text-center mb-6">{message}</p>
          <div className="flex gap-3">
            <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-gray-400 text-sm hover:border-zinc-500 hover:text-white transition-all">Cancel</button>
            <button onClick={onConfirm} className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${danger ? "bg-red-600 hover:bg-red-500 text-white" : "bg-amber-600 hover:bg-amber-500 text-white"}`}>{confirmLabel}</button>
          </div>
        </motion.div>
      </motion.div>
    )}
  </AnimatePresence>
);

const EmployeeModal = ({ open, onClose, onSave, editingEmployee, departments, saving }: {
  open: boolean; onClose: () => void; onSave: (data: EmployeeFormData) => void;
  editingEmployee: Employee | null; departments: string[]; saving: boolean;
}) => {
  const isEdit = !!editingEmployee;
  const emptyForm: EmployeeFormData = { name: "", email: "", department: "", role: "Employee", status: "Active" };
  const [form, setForm] = useState<EmployeeFormData>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    if (open) {
      setForm(editingEmployee
        ? { name: editingEmployee.name, email: editingEmployee.email, department: editingEmployee.department, role: editingEmployee.role, status: editingEmployee.status }
        : emptyForm);
      setErrors({});
    }
  }, [open, editingEmployee]);

  const set = (field: string, value: string) => {
    setForm((p) => ({ ...p, [field]: value }));
    setErrors((p) => ({ ...p, [field]: undefined }));
  };

  const handleSubmit = () => {
    const errs = validateEmployee(form, [], editingEmployee?.id);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    onSave(form);
  };

  const inputCls = (field: string) =>
    `w-full bg-[#0f111a] border rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-gray-600 outline-none transition-all
    ${errors[field] ? "border-red-500/60 focus:border-red-500" : "border-zinc-700 focus:border-blue-500/60"}`;

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[100] flex items-center justify-center p-4" onClick={onClose}>
          <motion.div initial={{ scale: 0.92, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.92, opacity: 0, y: 20 }} transition={{ type: "spring" as const, damping: 25, stiffness: 300 }}
            onClick={(e) => e.stopPropagation()} className="bg-[#1a1d2e] border border-zinc-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-500/15 flex items-center justify-center"><User size={17} className="text-blue-400" /></div>
                <div>
                  <h2 className="text-sm font-bold text-white">{isEdit ? "Edit Employee" : "Add New Employee"}</h2>
                  <p className="text-[11px] text-gray-500">{isEdit ? "Update employee details" : "Signup creates Employee only"}</p>
                </div>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-700/50 transition-colors"><X size={16} className="text-gray-400" /></button>
            </div>
            <div className="p-6 flex flex-col gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Full Name *</label>
                <div className="relative">
                  <User size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" />
                  <input className={`${inputCls("name")} pl-9`} placeholder="e.g. Priya Sharma" value={form.name} onChange={(e) => set("name", e.target.value)} />
                </div>
                {errors.name && <p className="text-red-400 text-[11px] mt-1 flex items-center gap-1"><AlertCircle size={10} />{errors.name}</p>}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Work Email *</label>
                <div className="relative">
                  <Mail size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" />
                  <input className={`${inputCls("email")} pl-9`} type="email" placeholder="priya@company.com" value={form.email} onChange={(e) => set("email", e.target.value)} disabled={isEdit} />
                </div>
                {errors.email && <p className="text-red-400 text-[11px] mt-1 flex items-center gap-1"><AlertCircle size={10} />{errors.email}</p>}
                {isEdit && <p className="text-[11px] text-gray-600 mt-1">Email cannot be changed after creation.</p>}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Department *</label>
                <div className="relative">
                  <Building2 size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" />
                  <select className={`${inputCls("department")} pl-9 appearance-none cursor-pointer`} value={form.department} onChange={(e) => set("department", e.target.value)}>
                    <option value="">Select department</option>
                    {departments.map((d) => (<option key={d} value={d}>{d}</option>))}
                  </select>
                  <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                </div>
                {errors.department && <p className="text-red-400 text-[11px] mt-1 flex items-center gap-1"><AlertCircle size={10} />{errors.department}</p>}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Role *</label>
                <div className="grid grid-cols-2 gap-2">
                  {ROLES.map((r) => {
                    const cfg = roleConfig[r]; const RoleIcon = cfg.icon;
                    return (
                      <button key={r} type="button" onClick={() => set("role", r)}
                        className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-left transition-all text-xs font-medium
                          ${form.role === r ? `${cfg.color} border-opacity-60` : "border-zinc-700 text-gray-500 hover:border-zinc-500 hover:text-gray-300"}`}>
                        <RoleIcon size={13} />
                        <div><p className="font-semibold">{cfg.label}</p><p className="text-[10px] opacity-70">{cfg.description}</p></div>
                      </button>
                    );
                  })}
                </div>
                {form.role === "Admin" && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                    className="mt-2 flex items-start gap-2 bg-purple-950/40 border border-purple-500/30 rounded-lg px-3 py-2">
                    <ShieldAlert size={13} className="text-purple-400 flex-shrink-0 mt-0.5" />
                    <p className="text-[11px] text-purple-300">Admin role grants full system access. Assign with caution.</p>
                  </motion.div>
                )}
              </div>
              <div className="flex items-center justify-between bg-[#0f111a] border border-zinc-700 rounded-xl px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-white">Account Status</p>
                  <p className="text-xs text-gray-500">{form.status === "Active" ? "Employee can log in" : "Account is suspended"}</p>
                </div>
                <button type="button" onClick={() => set("status", form.status === "Active" ? "Inactive" : "Active")}
                  className={`relative w-11 h-6 rounded-full transition-all duration-300 focus:outline-none ${form.status === "Active" ? "bg-emerald-500" : "bg-zinc-600"}`}>
                  <motion.span animate={{ x: form.status === "Active" ? 20 : 2 }} transition={{ type: "spring" as const, stiffness: 400, damping: 25 }}
                    className="absolute top-1 left-0 w-4 h-4 bg-white rounded-full shadow-md" />
                </button>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-zinc-800 flex gap-3">
              <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-gray-400 text-sm hover:border-zinc-500 hover:text-white transition-all">Cancel</button>
              <button onClick={handleSubmit} disabled={saving}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-60">
                {saving ? (<><Loader2 size={14} className="animate-spin" /> Saving...</>) : (<><Check size={14} /> {isEdit ? "Update Employee" : "Add Employee"}</>)}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

const PromoteModal = ({ open, employee, onClose, onPromote, saving }: {
  open: boolean; employee: Employee | null; onClose: () => void; onPromote: (id: string, role: string) => void; saving: boolean;
}) => {
  const [selectedRole, setSelectedRole] = useState("");
  useEffect(() => { if (open && employee) setSelectedRole(employee.role); }, [open, employee]);

  return (
    <AnimatePresence>
      {open && employee && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[100] flex items-center justify-center p-4" onClick={onClose}>
          <motion.div initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.92, opacity: 0 }}
            onClick={(e) => e.stopPropagation()} className="bg-[#1a1d2e] border border-zinc-700 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
              <div><h2 className="text-sm font-bold text-white">Change Role</h2><p className="text-[11px] text-gray-500">{employee.name}</p></div>
              <button onClick={onClose}><X size={15} className="text-gray-400 hover:text-white" /></button>
            </div>
            <div className="p-5 flex flex-col gap-2">
              {ROLES.map((r) => {
                const cfg = roleConfig[r]; const RoleIcon = cfg.icon;
                return (
                  <button key={r} onClick={() => setSelectedRole(r)}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all
                      ${selectedRole === r ? `${cfg.color}` : "border-zinc-700 text-gray-400 hover:border-zinc-500 hover:text-white"}`}>
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${selectedRole === r ? "" : "bg-zinc-800"}`}><RoleIcon size={15} /></div>
                    <div><p className="text-sm font-semibold">{r}</p><p className="text-[11px] opacity-70">{cfg.description}</p></div>
                    {selectedRole === r && <Check size={14} className="ml-auto" />}
                  </button>
                );
              })}
            </div>
            <div className="px-5 py-4 border-t border-zinc-800 flex gap-3">
              <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-gray-400 text-sm hover:border-zinc-500 transition-all">Cancel</button>
              <button onClick={() => onPromote(employee.id, selectedRole)} disabled={saving || selectedRole === employee.role}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                {saving ? "Updating..." : "Update Role"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// ─────────────────────────────────────────────────────────────
// EMPLOYEE DIRECTORY — Main sub-component
// ─────────────────────────────────────────────────────────────
const EmployeeDirectory = ({ departments }: { departments: string[] }) => {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [filterRole, setFilterRole] = useState("All");
  const [filterDept, setFilterDept] = useState("All");
  const [filterStatus, setFilterStatus] = useState("All");
  const [showModal, setShowModal] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<Employee | null>(null);
  const [showPromote, setShowPromote] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);

  const showToast = (msg: string, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    setLoading(true);
    setLoadError("");
    employeeService.getAll()
      .then(setEmployees)
      .catch((err: any) => setLoadError(err?.message ?? "Failed to load employees"))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => employees.filter((e) => {
    const matchSearch = !search || e.name.toLowerCase().includes(search.toLowerCase()) || e.email.toLowerCase().includes(search.toLowerCase()) || e.department.toLowerCase().includes(search.toLowerCase());
    const matchRole = filterRole === "All" || e.role === filterRole;
    const matchDept = filterDept === "All" || e.department === filterDept;
    const matchStatus = filterStatus === "All" || e.status === filterStatus;
    return matchSearch && matchRole && matchDept && matchStatus;
  }), [employees, search, filterRole, filterDept, filterStatus]);

  const stats = useMemo(() => ({
    total: employees.length,
    active: employees.filter((e) => e.status === "Active").length,
    admins: employees.filter((e) => e.role === "Admin").length,
    managers: employees.filter((e) => e.role === "Asset Manager").length,
    heads: employees.filter((e) => e.role === "Department Head").length,
  }), [employees]);

  const handleSave = async (formData: EmployeeFormData) => {
    setSaving(true);
    try {
      if (editingEmployee) {
        await employeeService.update(editingEmployee.id, { ...editingEmployee, ...formData });
        setEmployees((prev) => prev.map((e) => e.id === editingEmployee.id ? { ...e, ...formData } : e));
        showToast(`${formData.name} updated successfully`);
      } else {
        const avatar = formData.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
        const created = await employeeService.create({ ...formData, avatar });
        setEmployees((prev) => [...prev, { ...created, id: created.id ?? Date.now() }]);
        showToast(`${formData.name} added to directory`);
      }
      setShowModal(false);
      setEditingEmployee(null);
    } catch (err: any) { showToast(err?.message ?? "Failed to save. Please try again.", "error"); }
    finally { setSaving(false); }
  };

  const handleDelete = (employee: Employee) => {
    if (employee.role === "Admin") { showToast("Cannot delete an Admin account.", "error"); return; }
    setConfirm({
      title: "Delete Employee", message: `Remove ${employee.name} from the directory? This cannot be undone.`,
      danger: true, confirmLabel: "Delete",
      onConfirm: async () => {
        setConfirm(null);
        try {
          await employeeService.delete(employee.id);
          setEmployees((prev) => prev.filter((e) => e.id !== employee.id));
          showToast(`${employee.name} removed from directory`);
        } catch (err: any) {
          showToast(err?.message ?? "Failed to remove employee", "error");
        }
      },
    });
  };

  const handleToggleStatus = async (employee: Employee) => {
    const newStatus = employee.status === "Active" ? "Inactive" : "Active";
    if (employee.role === "Admin" && newStatus === "Inactive") { showToast("Cannot suspend an Admin account.", "warning"); return; }
    try {
      await employeeService.toggleStatus(employee.id, newStatus);
      setEmployees((prev) => prev.map((e) => e.id === employee.id ? { ...e, status: newStatus } : e));
      showToast(`${employee.name} ${newStatus === "Active" ? "reactivated" : "suspended"}`);
    } catch (err: any) {
      showToast(err?.message ?? "Failed to update status", "error");
    }
  };

  const handlePromote = async (id: string, role: string) => {
    setSaving(true);
    try {
      await employeeService.promote(id, role);
      setEmployees((prev) => prev.map((e) => e.id === id ? { ...e, role } : e));
      showToast(`Role updated to ${role}`);
      setShowPromote(false); setPromoteTarget(null);
    } catch (err: any) { showToast(err?.message ?? "Failed to update role.", "error"); }
    finally { setSaving(false); }
  };

  const openAdd = () => { setEditingEmployee(null); setShowModal(true); };
  const openEdit = (emp: Employee) => { setEditingEmployee(emp); setShowModal(true); };
  const openPromote = (emp: Employee) => { setPromoteTarget(emp); setShowPromote(true); };

  return (
    <div className="space-y-5">
      <EmployeeToast toast={toast} />
      <EmployeeConfirmDialog open={!!confirm} title={confirm?.title} message={confirm?.message}
        danger={confirm?.danger} confirmLabel={confirm?.confirmLabel ?? "Confirm"}
        onConfirm={confirm?.onConfirm ?? (() => {})} onCancel={() => setConfirm(null)} />

      {/* Load error banner */}
      {loadError && (
        <div className="flex items-center gap-2.5 bg-red-950/40 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-400">
          <AlertCircle size={15} className="flex-shrink-0" /> {loadError} — check that the backend is running.
        </div>
      )}
      <EmployeeModal open={showModal} onClose={() => { setShowModal(false); setEditingEmployee(null); }}
        onSave={handleSave} editingEmployee={editingEmployee} departments={departments} saving={saving} />
      <PromoteModal open={showPromote} employee={promoteTarget}
        onClose={() => { setShowPromote(false); setPromoteTarget(null); }}
        onPromote={handlePromote} saving={saving} />

      {/* Stats Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: "Total", value: stats.total, color: "text-white" },
          { label: "Active", value: stats.active, color: "text-emerald-400" },
          { label: "Admins", value: stats.admins, color: "text-purple-400" },
          { label: "Managers", value: stats.managers, color: "text-blue-400" },
          { label: "Dept. Heads", value: stats.heads, color: "text-amber-400" },
        ].map((s) => (
          <div key={s.label} className="bg-[#161925] border border-zinc-800 rounded-xl px-4 py-3 text-center">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-[11px] text-gray-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, email or department..."
            className="w-full bg-[#161925] border border-zinc-800 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder:text-gray-600 outline-none focus:border-blue-500/50 transition-colors" />
          {search && (<button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2"><X size={13} className="text-gray-500 hover:text-white" /></button>)}
        </div>
        <div className="flex gap-2 flex-wrap">
          <div className="relative">
            <select value={filterRole} onChange={(e) => setFilterRole(e.target.value)}
              className="bg-[#161925] border border-zinc-800 rounded-xl pl-3 pr-8 py-2.5 text-sm text-gray-300 outline-none focus:border-blue-500/50 transition-colors appearance-none cursor-pointer">
              <option value="All">All Roles</option>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          </div>
          <div className="relative">
            <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)}
              className="bg-[#161925] border border-zinc-800 rounded-xl pl-3 pr-8 py-2.5 text-sm text-gray-300 outline-none focus:border-blue-500/50 transition-colors appearance-none cursor-pointer">
              <option value="All">All Departments</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          </div>
          <div className="relative">
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
              className="bg-[#161925] border border-zinc-800 rounded-xl pl-3 pr-8 py-2.5 text-sm text-gray-300 outline-none focus:border-blue-500/50 transition-colors appearance-none cursor-pointer">
              <option value="All">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
            <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          </div>
          <button onClick={openAdd}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-all shadow-lg shadow-blue-600/20">
            <Plus size={15} /> Add Employee
          </button>
        </div>
      </div>

      {/* Results count */}
      {!loading && (
        <p className="text-xs text-gray-500">
          Showing <span className="text-white font-medium">{filtered.length}</span> of <span className="text-white font-medium">{employees.length}</span> employees
          {(search || filterRole !== "All" || filterDept !== "All" || filterStatus !== "All") && (
            <button onClick={() => { setSearch(""); setFilterRole("All"); setFilterDept("All"); setFilterStatus("All"); }}
              className="ml-2 text-blue-400 hover:text-blue-300 hover:underline">Clear filters</button>
          )}
        </p>
      )}

      {/* Table */}
      <div className="bg-[#161925] border border-zinc-800 rounded-2xl overflow-hidden">
        {loading && (
          <div className="py-16 flex flex-col items-center gap-3 text-gray-500">
            <Loader2 size={28} className="animate-spin text-blue-400" />
            <p className="text-sm">Loading employee directory...</p>
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="py-16 flex flex-col items-center gap-3 text-gray-500">
            <Users size={36} className="opacity-25" />
            <p className="text-sm font-medium text-gray-400">No employees found</p>
            <p className="text-xs">Try adjusting your search or filters</p>
            <button onClick={openAdd} className="mt-2 flex items-center gap-1.5 text-sm text-blue-400 hover:underline"><Plus size={14} /> Add the first employee</button>
          </div>
        )}
        {!loading && filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-5 py-3.5 text-left font-medium">Employee</th>
                  <th className="px-4 py-3.5 text-left font-medium">Department</th>
                  <th className="px-4 py-3.5 text-left font-medium">Role</th>
                  <th className="px-4 py-3.5 text-left font-medium">Status</th>
                  <th className="px-4 py-3.5 text-left font-medium hidden lg:table-cell">Joined</th>
                  <th className="px-4 py-3.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                <AnimatePresence>
                  {filtered.map((emp, i) => (
                    <motion.tr key={emp.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -20 }}
                      transition={{ delay: i * 0.03 }} className="hover:bg-zinc-800/30 transition-colors group">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold text-white flex-shrink-0 ${getAvatarColor(emp.id)}`}>{emp.avatar}</div>
                          <div>
                            <p className="font-semibold text-white leading-tight">{emp.name}</p>
                            <p className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5"><Mail size={9} /> {emp.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5"><span className="flex items-center gap-1.5 text-gray-300 text-xs"><Building2 size={12} className="text-gray-600" />{emp.department}</span></td>
                      <td className="px-4 py-3.5"><button onClick={() => openPromote(emp)} title="Click to change role" className="hover:scale-105 transition-transform"><RoleBadge role={emp.role} /></button></td>
                      <td className="px-4 py-3.5"><StatusPill status={emp.status} /></td>
                      <td className="px-4 py-3.5 text-xs text-gray-500 hidden lg:table-cell">{emp.joinedOn}</td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => handleToggleStatus(emp)} title={emp.status === "Active" ? "Suspend" : "Reactivate"}
                            className={`p-1.5 rounded-lg transition-all opacity-0 group-hover:opacity-100 ${emp.status === "Active" ? "hover:bg-amber-500/15 hover:text-amber-400 text-gray-500" : "hover:bg-emerald-500/15 hover:text-emerald-400 text-gray-500"}`}>
                            {emp.status === "Active" ? <UserX size={14} /> : <UserCheck size={14} />}
                          </button>
                          <button onClick={() => openEdit(emp)} title="Edit" className="p-1.5 rounded-lg text-gray-500 hover:bg-blue-500/15 hover:text-blue-400 transition-all opacity-0 group-hover:opacity-100"><Edit2 size={14} /></button>
                          <button onClick={() => openPromote(emp)} title="Change role" className="p-1.5 rounded-lg text-gray-500 hover:bg-purple-500/15 hover:text-purple-400 transition-all opacity-0 group-hover:opacity-100"><Shield size={14} /></button>
                          <button onClick={() => handleDelete(emp)} title="Delete" className="p-1.5 rounded-lg text-gray-500 hover:bg-red-500/15 hover:text-red-400 transition-all opacity-0 group-hover:opacity-100"><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* RBAC Info */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}
        className="flex items-start gap-3 bg-blue-950/30 border border-blue-500/20 rounded-2xl px-5 py-3">
        <ShieldCheck size={15} className="text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-blue-300/80 leading-relaxed">
          <span className="font-semibold text-blue-300">Role Assignment Policy:</span>{" "}
          Employees self-register with the <span className="text-white font-medium">Employee</span> role only.
          Only an <span className="text-purple-300 font-medium">Admin</span> can promote users to{" "}
          <span className="text-amber-300 font-medium">Department Head</span> or{" "}
          <span className="text-blue-300 font-medium">Asset Manager</span> here in the Employee Directory.
          Click any role badge in the table to promote.
        </p>
      </motion.div>
    </div>
  );
};

type TabName = "Departments" | "Categories" | "Employees";

export default function OrganizationSetup() {
  const [activeTab, setActiveTab] = useState<TabName>("Departments");

  // --- Data States ---
  const [departments, setDepartments] = useState<Department[]>([]);
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingCategories, setIsLoadingCategories] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCategories, setErrorCategories] = useState<string | null>(null);

  // --- Search States ---
  const [searchTerm, setSearchTerm] = useState("");
  const [searchTermCategories, setSearchTermCategories] = useState("");

  // --- Modal States ---
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Department | AssetCategory | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Department form
  const [deptForm, setDeptForm] = useState<DeptFormData>({ name: "", head: "", parent: "", status: "Active" });
  // Category form
  const [catForm, setCatForm] = useState<CategoryFormData>({ name: "", description: "", customFields: "", status: "Active" });

  // ==========================================
  // DATA FETCHING (via Service Layer)
  // ==========================================
  useEffect(() => {
    if (activeTab !== "Departments") return;
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await fetchDepartments();
        setDepartments(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load departments.");
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "Categories") return;
    const load = async () => {
      setIsLoadingCategories(true);
      setErrorCategories(null);
      try {
        const data = await fetchCategories();
        setCategories(data);
      } catch (err) {
        setErrorCategories(err instanceof Error ? err.message : "Failed to load categories.");
      } finally {
        setIsLoadingCategories(false);
      }
    };
    load();
  }, [activeTab]);

  // ==========================================
  // MODAL: Open / Close
  // ==========================================
  const handleOpenModal = (item: Department | AssetCategory | null = null) => {
    setEditingItem(item);
    if (activeTab === "Departments") {
      if (item && "headEmail" in item) {
        const d = item as Department;
        setDeptForm({ name: d.name, head: d.head, parent: d.parent ?? "", status: d.status });
      } else {
        setDeptForm({ name: "", head: "", parent: "", status: "Active" });
      }
    } else {
      if (item && "customFields" in item) {
        const c = item as AssetCategory;
        setCatForm({ name: c.name, description: c.description, customFields: c.customFields.join(", "), status: c.status });
      } else {
        setCatForm({ name: "", description: "", customFields: "", status: "Active" });
      }
    }
    setIsModalOpen(true);
  };

  // ==========================================
  // CRUD: Save (Create or Update via Service)
  // ==========================================
  const handleSave = async () => {
    setIsSaving(true);
    try {
      if (activeTab === "Departments") {
        if (!deptForm.name.trim()) return;
        if (editingItem) {
          const updated = await updateDepartment(editingItem.id, deptForm);
          setDepartments((prev) => prev.map((d) => (d.id === editingItem.id ? { ...d, ...updated, parent: deptForm.parent || null, headEmail: (d as Department).headEmail, employeeCount: (d as Department).employeeCount } : d)));
        } else {
          const created = await createDepartment(deptForm);
          setDepartments((prev) => [...prev, created]);
        }
      } else if (activeTab === "Categories") {
        if (!catForm.name.trim()) return;
        if (editingItem) {
          const updated = await updateCategory(editingItem.id, catForm);
          setCategories((prev) => prev.map((c) => (c.id === editingItem.id ? { ...c, ...updated, assetCount: (c as AssetCategory).assetCount } : c)));
        } else {
          const created = await createCategory(catForm);
          setCategories((prev) => [...prev, created]);
        }
      }
      setIsModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  // ==========================================
  // CRUD: Toggle Status (via Service)
  // ==========================================
  const handleToggleStatus = async (item: Department | AssetCategory) => {
    try {
      if (activeTab === "Departments") {
        const newStatus = await toggleDepartmentStatus(item.id, item.status);
        setDepartments((prev) => prev.map((d) => (d.id === item.id ? { ...d, status: newStatus } : d)));
      } else if (activeTab === "Categories") {
        const newStatus = await toggleCategoryStatus(item.id, item.status);
        setCategories((prev) => prev.map((c) => (c.id === item.id ? { ...c, status: newStatus } : c)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Status toggle failed.");
    }
  };

  // ==========================================
  // FILTERING
  // ==========================================
  const filteredDepartments = departments.filter((d) => d.name.toLowerCase().includes(searchTerm.toLowerCase()) || d.head.toLowerCase().includes(searchTerm.toLowerCase()));
  const filteredCategories = categories.filter((c) => c.name.toLowerCase().includes(searchTermCategories.toLowerCase()) || c.description.toLowerCase().includes(searchTermCategories.toLowerCase()));

  const isDept = activeTab === "Departments";

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="bg-blue-600/20 text-blue-400 text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider border border-blue-500/20">Admin Only</span>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Organization Setup</h1>
          <p className="text-sm text-gray-400 mt-1">Manage organizational structure and asset classifications.</p>
        </div>
        {activeTab !== "Employees" && (
        <motion.button
          whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
          onClick={() => handleOpenModal()}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium shadow-[0_0_20px_rgba(37,99,235,0.3)] transition-all"
        >
          <Plus size={18} />
          {activeTab === "Departments" ? "New Department" : "New Category"}
        </motion.button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex p-1 bg-[#161925] border border-zinc-800/80 rounded-xl w-full overflow-x-auto">
        {([{ id: "Departments" as TabName, icon: Building2, label: "Departments" }, { id: "Categories" as TabName, icon: Layers, label: "Asset Categories" }, { id: "Employees" as TabName, icon: Contact, label: "Employee Directory" }]).map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex-1 flex items-center justify-center gap-2 whitespace-nowrap px-6 py-3 rounded-lg text-sm font-medium transition-all ${activeTab === tab.id ? "bg-zinc-800 text-white shadow-sm" : "text-gray-400 hover:text-gray-200 hover:bg-zinc-800/50"}`}>
            <tab.icon size={16} className={activeTab === tab.id ? "text-blue-400" : "text-gray-500"} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Error Banner */}
      {(error && isDept) || (errorCategories && !isDept) ? (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-4 text-red-400">
          <AlertCircle size={20} />
          <p className="text-sm">{isDept ? error : errorCategories}</p>
        </div>
      ) : null}

      {/* ========================================== */}
      {/* TAB A: DEPARTMENTS                         */}
      {/* ========================================== */}
      {activeTab === "Departments" && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
          <div className="flex flex-col md:flex-row gap-4 justify-between items-center bg-[#161925] border border-zinc-800/80 rounded-2xl p-4 shadow-xl">
            <div className="relative w-full md:w-96">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
              <input type="text" placeholder="Search departments or heads..." className="w-full bg-[#0f111a] border border-zinc-800 text-white text-sm rounded-xl pl-10 pr-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-zinc-600" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
            </div>
          </div>

          <div className="bg-[#161925] border border-zinc-800/80 rounded-2xl shadow-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800 bg-[#161925]/50">
                    <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider">Department Name</th>
                    <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider">Department Head</th>
                    <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider">Hierarchy</th>
                    <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider text-center">Employees</th>
                    <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider">Status</th>
                    <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {isLoading && !error && Array.from({ length: 4 }).map((_, idx) => (
                    <tr key={`sk-${idx}`} className="animate-pulse">
                      <td className="py-4 px-6"><div className="h-5 bg-zinc-800 rounded w-32" /></td>
                      <td className="py-4 px-6"><div className="h-4 bg-zinc-800 rounded w-24" /></td>
                      <td className="py-4 px-6"><div className="h-4 bg-zinc-800 rounded w-28" /></td>
                      <td className="py-4 px-6"><div className="h-4 bg-zinc-800 rounded w-8 mx-auto" /></td>
                      <td className="py-4 px-6"><div className="h-6 bg-zinc-800 rounded-full w-16" /></td>
                      <td className="py-4 px-6 text-right"><div className="h-6 w-6 bg-zinc-800 rounded-lg ml-auto" /></td>
                    </tr>
                  ))}
                  {!isLoading && !error && (
                    <AnimatePresence>
                      {filteredDepartments.map((dept) => (
                        <motion.tr key={dept.id} variants={itemVariants} initial="hidden" animate="show" exit="hidden" layout className="hover:bg-zinc-800/30 transition-colors group">
                          <td className="py-4 px-6"><p className="text-sm font-semibold text-gray-200 group-hover:text-blue-400 transition-colors">{dept.name}</p><p className="text-xs text-zinc-500 font-mono mt-0.5">{dept.id}</p></td>
                          <td className="py-4 px-6">{dept.headEmail ? (<div className="flex items-center gap-3"><div className="w-8 h-8 rounded-full bg-blue-900 border border-blue-700 flex items-center justify-center text-xs font-bold text-blue-200">{dept.head.charAt(0)}</div><div><p className="text-sm font-medium text-gray-200">{dept.head}</p><p className="text-[10px] text-zinc-500">{dept.headEmail}</p></div></div>) : (<span className="text-sm text-gray-500 italic">Unassigned</span>)}</td>
                          <td className="py-4 px-6">{dept.parent ? (<div className="flex items-center gap-2 text-sm text-gray-400"><Network size={14} className="text-zinc-500" />{dept.parent}</div>) : (<span className="text-sm text-gray-600">- Top Level -</span>)}</td>
                          <td className="py-4 px-6 text-center"><div className="inline-flex items-center gap-1.5 bg-[#0f111a] border border-zinc-800 px-3 py-1 rounded-lg text-sm text-gray-300"><Users size={14} className="text-zinc-500" />{dept.employeeCount}</div></td>
                          <td className="py-4 px-6">
                            <button onClick={() => handleToggleStatus(dept)} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer transition-colors ${dept.status === "Active" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20" : "bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700"}`}>{dept.status === "Active" ? <CheckCircle2 size={12} /> : <XCircle size={12} />}{dept.status}</button>
                          </td>
                          <td className="py-4 px-6 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button onClick={() => handleOpenModal(dept)} className="text-gray-500 hover:text-blue-400 p-1.5 rounded-lg hover:bg-zinc-800 transition-colors" title="Edit"><Edit2 size={16} /></button>
                              <button className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"><MoreVertical size={18} /></button>
                            </div>
                          </td>
                        </motion.tr>
                      ))}
                    </AnimatePresence>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </motion.div>
      )}

      {/* ========================================== */}
      {/* TAB B: ASSET CATEGORIES                    */}
      {/* ========================================== */}
      {activeTab === "Categories" && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
          <div className="flex flex-col md:flex-row gap-4 justify-between items-center bg-[#161925] border border-zinc-800/80 rounded-2xl p-4 shadow-xl">
            <div className="relative w-full md:w-96">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
              <input type="text" placeholder="Search categories..." className="w-full bg-[#0f111a] border border-zinc-800 text-white text-sm rounded-xl pl-10 pr-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-zinc-600" value={searchTermCategories} onChange={(e) => setSearchTermCategories(e.target.value)} />
            </div>
          </div>

          <div className="bg-[#161925] border border-zinc-800/80 rounded-2xl shadow-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800 bg-[#161925]/50">
                    <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider">Category Details</th>
                    <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider w-1/3">Custom Fields</th>
                    <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider text-center">Total Assets</th>
                    <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider">Status</th>
                    <th className="py-4 px-6 text-xs font-semibold text-gray-400 uppercase tracking-wider text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {isLoadingCategories && !errorCategories && Array.from({ length: 4 }).map((_, idx) => (
                    <tr key={`csk-${idx}`} className="animate-pulse">
                      <td className="py-4 px-6"><div className="h-5 bg-zinc-800 rounded w-32 mb-2" /><div className="h-3 bg-zinc-800 rounded w-48" /></td>
                      <td className="py-4 px-6 flex gap-2"><div className="h-6 w-20 bg-zinc-800 rounded-full" /><div className="h-6 w-24 bg-zinc-800 rounded-full" /></td>
                      <td className="py-4 px-6"><div className="h-4 bg-zinc-800 rounded w-8 mx-auto" /></td>
                      <td className="py-4 px-6"><div className="h-6 bg-zinc-800 rounded-full w-16" /></td>
                      <td className="py-4 px-6 text-right"><div className="h-6 w-6 bg-zinc-800 rounded-lg ml-auto" /></td>
                    </tr>
                  ))}
                  {!isLoadingCategories && !errorCategories && (
                    <AnimatePresence>
                      {filteredCategories.map((cat) => (
                        <motion.tr key={cat.id} variants={itemVariants} initial="hidden" animate="show" exit="hidden" layout className="hover:bg-zinc-800/30 transition-colors group">
                          <td className="py-4 px-6">
                            <div className="flex items-start gap-3">
                              <div className="mt-1 p-2 bg-zinc-800/50 rounded-lg text-gray-400 group-hover:text-blue-400 group-hover:bg-blue-500/10 transition-colors"><Layers size={18} /></div>
                              <div><p className="text-sm font-semibold text-gray-200 group-hover:text-blue-400 transition-colors">{cat.name}</p><p className="text-xs text-zinc-500 mt-1 max-w-xs leading-relaxed">{cat.description}</p><p className="text-[10px] text-zinc-600 font-mono mt-1">{cat.id}</p></div>
                            </div>
                          </td>
                          <td className="py-4 px-6">{cat.customFields?.length > 0 ? (<div className="flex flex-wrap gap-2">{cat.customFields.map((f, i) => (<span key={i} className="inline-flex items-center gap-1 bg-[#0f111a] border border-zinc-700 px-2.5 py-1 rounded-md text-[11px] text-gray-300"><Tag size={10} className="text-zinc-500" />{f}</span>))}</div>) : (<span className="text-xs text-zinc-600 italic">No custom fields</span>)}</td>
                          <td className="py-4 px-6 text-center"><div className="inline-flex items-center gap-1.5 bg-[#0f111a] border border-zinc-800 px-3 py-1 rounded-lg text-sm text-gray-300"><Box size={14} className="text-zinc-500" />{cat.assetCount}</div></td>
                          <td className="py-4 px-6">
                            <button onClick={() => handleToggleStatus(cat)} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer transition-colors ${cat.status === "Active" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20" : "bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700"}`}>{cat.status === "Active" ? <CheckCircle2 size={12} /> : <XCircle size={12} />}{cat.status}</button>
                          </td>
                          <td className="py-4 px-6 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button onClick={() => handleOpenModal(cat)} className="text-gray-500 hover:text-blue-400 p-1.5 rounded-lg hover:bg-zinc-800 transition-colors" title="Edit"><Edit2 size={16} /></button>
                              <button className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-zinc-800 transition-colors" title="Configure"><Settings2 size={18} /></button>
                            </div>
                          </td>
                        </motion.tr>
                      ))}
                    </AnimatePresence>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </motion.div>
      )}

      {/* ========================================== */}
      {/* TAB C: EMPLOYEE DIRECTORY                 */}
      {/* ========================================== */}
      {activeTab === "Employees" && (
        <EmployeeDirectory departments={departments.map((d) => d.name)} />
      )}

      {/* ========================================== */}
      {/* UNIFIED MODAL                              */}
      {/* ========================================== */}
      <AnimatePresence>
        {isModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={() => !isSaving && setIsModalOpen(false)}>
            <motion.div initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }} transition={{ type: "spring" as const, stiffness: 300, damping: 24 }} className="bg-[#161925] border border-zinc-800 p-6 rounded-2xl w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-bold text-white">{editingItem ? "Edit" : "Create"} {isDept ? "Department" : "Category"}</h2>
                <button onClick={() => !isSaving && setIsModalOpen(false)} className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"><X size={18} /></button>
              </div>

              <div className="space-y-4">
                {/* Name */}
                <div>
                  <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">{isDept ? "Department Name" : "Category Name"}</label>
                  <input className="w-full bg-[#0f111a] border border-zinc-700 text-white text-sm p-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-zinc-600" placeholder={isDept ? "e.g. Engineering" : "e.g. Electronics"} value={isDept ? deptForm.name : catForm.name} onChange={(e) => isDept ? setDeptForm({ ...deptForm, name: e.target.value }) : setCatForm({ ...catForm, name: e.target.value })} />
                </div>

                {/* Department-specific: Head */}
                {isDept && (
                  <div>
                    <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Department Head</label>
                    <input className="w-full bg-[#0f111a] border border-zinc-700 text-white text-sm p-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-zinc-600" placeholder="e.g. John Doe" value={deptForm.head} onChange={(e) => setDeptForm({ ...deptForm, head: e.target.value })} />
                  </div>
                )}

                {/* Department-specific: Parent */}
                {isDept && (
                  <div>
                    <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Parent Department</label>
                    <select className="w-full bg-[#0f111a] border border-zinc-700 text-white text-sm p-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all" value={deptForm.parent} onChange={(e) => setDeptForm({ ...deptForm, parent: e.target.value })}>
                      <option value="">No Parent (Top Level)</option>
                      {departments.filter((d) => d.id !== editingItem?.id).map((d) => (<option key={d.id} value={d.name}>{d.name}</option>))}
                    </select>
                  </div>
                )}

                {/* Category-specific: Description */}
                {!isDept && (
                  <div>
                    <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Description</label>
                    <input className="w-full bg-[#0f111a] border border-zinc-700 text-white text-sm p-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-zinc-600" placeholder="Brief description..." value={catForm.description} onChange={(e) => setCatForm({ ...catForm, description: e.target.value })} />
                  </div>
                )}

                {/* Category-specific: Custom Fields */}
                {!isDept && (
                  <div>
                    <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Custom Fields (comma-separated)</label>
                    <input className="w-full bg-[#0f111a] border border-zinc-700 text-white text-sm p-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-zinc-600" placeholder="e.g. Warranty, Serial No, Condition" value={catForm.customFields} onChange={(e) => setCatForm({ ...catForm, customFields: e.target.value })} />
                  </div>
                )}

                {/* Status */}
                <div>
                  <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Status</label>
                  <select className="w-full bg-[#0f111a] border border-zinc-700 text-white text-sm p-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all" value={isDept ? deptForm.status : catForm.status} onChange={(e) => isDept ? setDeptForm({ ...deptForm, status: e.target.value }) : setCatForm({ ...catForm, status: e.target.value })}>
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </div>

                {/* Save Button */}
                <motion.button
                  whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
                  onClick={handleSave}
                  disabled={isSaving || (isDept ? !deptForm.name.trim() : !catForm.name.trim())}
                  className={`w-full py-3.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 ${isSaving || (isDept ? !deptForm.name.trim() : !catForm.name.trim()) ? "bg-zinc-800 text-zinc-500 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700 text-white shadow-[0_0_20px_rgba(37,99,235,0.3)]"}`}
                >
                  {isSaving && <Loader2 size={16} className="animate-spin" />}
                  {isSaving ? "Saving..." : editingItem ? "Save Changes" : `Create ${isDept ? "Department" : "Category"}`}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
