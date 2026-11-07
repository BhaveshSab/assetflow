import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Calendar as CalendarIcon,
  Clock,
  MapPin,
  Users,
  Monitor,
  Car,
  ChevronRight,
  CheckCircle2,
  Lock,
  AlertCircle,
  Loader2,
  X,
} from "lucide-react";

// Animation variants
const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.05 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 300, damping: 24 },
  },
};

interface RawBookableAsset {
  id: string;
  name?: string;
  category?: { name?: string } | null;
  location?: string;
}

interface Resource {
  id: string;
  name: string;
  type: string;
  capacity: string;
  location: string;
}

interface TimeSlot {
  id: string;
  time: string;
  status: string;
  bookedBy?: string;
  /** Local wall-clock hour this slot starts/ends — used to build the request. */
  startHour: number;
  endHour: number;
}

interface Toast { msg: string; type: string; }

// ==========================================
// BOOKING API SERVICE (real backend)
// ==========================================
import { apiGet, apiSend } from "@/lib/api";

const bookingApi = {
  /**
   * Create a booking.
   *
   * The API's own message is returned on failure. This used to `catch {}` and
   * report only "success: false", so every rejection — an overlap (409), a
   * past start time (400), a non-bookable asset (409) — reached the user as
   * the same unhelpful "Booking failed. Please try again."
   */
  confirmBooking: async (payload: {
    assetId: string;
    startTime: string;
    endTime: string;
    purpose: string;
  }): Promise<
    { success: true; bookingId: string } | { success: false; message: string }
  > => {
    try {
      const r = await apiSend<{ id: string }>("/bookings", "POST", payload);
      return { success: true, bookingId: r.id };
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Booking failed. Please try again.";
      return { success: false, message };
    }
  },
};

/**
 * An ISO timestamp for a local wall-clock hour.
 *
 * The screen used to append a literal "Z" to the hour it drew, so a 09:00 slot
 * was sent as 09:00 **UTC** — in IST (UTC+5:30) that is 14:30 local, i.e. the
 * booking was not for the slot the user clicked, and the "past" checks were
 * wrong by the same offset.
 */
const localIso = (year: number, month: number, day: number, hour: number) =>
  new Date(year, month - 1, day, hour, 0, 0, 0).toISOString();

const fmt12 = (h: number) => {
  const period = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${String(hr).padStart(2, "0")}:00 ${period}`;
};

const getResourceIcon = (type: string) => {
  if (type === "room") return <Users size={18} />;
  if (type === "vehicle") return <Car size={18} />;
  return <Monitor size={18} />;
};

export default function ResourceBooking() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [slots, setSlots] = useState<TimeSlot[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date();
    return d.getDate();
  });
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  // The slot list is already drawn for the first bookable resource when nobody
  // has clicked a card, so confirming has to target that same resource.
  // `handleConfirmBooking` used to read `selectedResource` alone and return
  // silently, which made the Confirm button do nothing at all — no request, no
  // toast — on a freshly opened screen.
  const activeResource = selectedResource ?? resources[0] ?? null;

  const showToast = (msg: string, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // ==========================================
  // BACKEND INTEGRATION: Fetch Resources & Slots
  // ==========================================
  const fetchBookingData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    try {
      // 1) Bookable assets = isBookable=true and in service.
      const assets = await apiGet<{ items: RawBookableAsset[] }>(
        "/assets?isBookable=true",
      );
      const resourceList: Resource[] = (assets.items ?? []).map((a) => {
        const cat = (a.category?.name ?? "").toLowerCase();
        return {
          id: a.id,
          name: a.name ?? "Unnamed resource",
          type: cat.includes("vehicle") || cat.includes("van")
            ? "vehicle"
            : cat.includes("furniture") || cat.includes("meeting") || cat.includes("room")
              ? "room"
              : "equipment",
          capacity: a.category?.name ?? "—",
          location: a.location ?? "—",
        };
      });
      setResources(resourceList);

      // 2) Slots for the selected date — mark overlaps as booked.
      const target = selectedResource ?? resourceList[0] ?? null;
      if (!target) {
        setSlots([]);
        return;
      }
      // A failed calendar read must be visible: swallowing it showed every
      // slot as "available" and the overlap warning never appeared.
      const bookings = await apiGet<{ items?: Array<{
          startTime: string; endTime: string;
          bookedBy?: { name: string };
        }> }>(
          `/bookings?assetId=${target.id}` +
            `&from=${encodeURIComponent(localIso(year, month, selectedDate, 0))}` +
            `&to=${encodeURIComponent(localIso(year, month, selectedDate, 24))}`,
        );

      const daySlots: TimeSlot[] = [];
      for (let h = 9; h <= 16; h++) {
        const start = localIso(year, month, selectedDate, h);
        const end = localIso(year, month, selectedDate, h + 1);
        const conflict = (bookings.items ?? []).find(
          (b) =>
            new Date(b.startTime).getTime() < new Date(end).getTime() &&
            new Date(b.endTime).getTime() > new Date(start).getTime(),
        );
        // A slot that has already ended cannot be booked — the API refuses it
        // ("startTime must be in the future"), so offering it was a dead end.
        const elapsed = new Date(end).getTime() <= Date.now();
        daySlots.push({
          id: `S${h - 8}`,
          time: `${fmt12(h)} - ${fmt12(h + 1)}`,
          status: conflict ? "booked" : elapsed ? "past" : "available",
          bookedBy: conflict?.bookedBy?.name,
          startHour: h,
          endHour: h + 1,
        });
      }
      setSlots(daySlots);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load booking data."
      );
    } finally {
      setIsLoading(false);
    }
  }, [selectedDate, selectedResource]);

  useEffect(() => {
    void fetchBookingData();
  }, [fetchBookingData]);

  const handleConfirmBooking = async () => {
    if (!selectedSlot || !activeResource) return;
    const slot = slots.find((s) => s.id === selectedSlot);
    if (!slot) return;

    setBooking(true);
    const now = new Date();
    const res = await bookingApi.confirmBooking({
      assetId: activeResource.id,
      startTime: localIso(now.getFullYear(), now.getMonth() + 1, selectedDate, slot.startHour),
      endTime: localIso(now.getFullYear(), now.getMonth() + 1, selectedDate, slot.endHour),
      purpose: "Resource booking from portal",
    });

    if (res.success) {
      showToast(`Booking confirmed! ID: ${res.bookingId}`);
      setSelectedSlot(null);
      // Re-read the calendar so a neighbouring slot shows the new overlap.
      await fetchBookingData();
    } else {
      // Show what the API actually said (overlap, past time, not bookable…).
      showToast(res.message, "error");
    }
    setBooking(false);
  };

  // Calendar grid for the current month (real number of days).
  const now = new Date();
  const daysInMonth = Array.from(
    { length: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() },
    (_, i) => i + 1
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full space-y-8"
    >
      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-xl text-sm font-medium shadow-xl border ${toast.type === "error" ? "bg-danger/25 border-danger/40 text-danger" : "bg-success/25 border-success/40 text-success"}`}
          >{toast.type === "error" ? <X size={14} className="inline mr-1.5" /> : <CheckCircle2 size={14} className="inline mr-1.5" />}{toast.msg}</motion.div>
        )}
      </AnimatePresence>
      {/* --- Page Header --- */}
      <div>
        <h1 className="text-2xl font-bold text-ink tracking-tight">
          Resource Booking
        </h1>
        <p className="text-sm text-ink-muted mt-1">
          Reserve shared rooms, vehicles, and equipment with real-time overlap
          validation.
        </p>
      </div>

      {error && (
        <div role="alert" className="bg-danger/10 border border-danger/20 rounded-xl p-4 flex items-center gap-4 text-danger">
          <AlertCircle size={20} />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* --- Main Booking Interface --- */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* LEFT COLUMN: Resource & Date Selection */}
        <div className="lg:col-span-5 space-y-6">
          {/* Step 1: Select Resource */}
          <div className="bg-surface-2 border border-line/80 rounded-2xl p-6 shadow-xl relative overflow-hidden">
            <div className="absolute -top-20 -left-20 w-40 h-40 bg-info/10 rounded-full blur-3xl pointer-events-none"></div>
            <h3 className="text-sm font-semibold text-ink-muted uppercase tracking-wider mb-4 flex items-center gap-2">
              <span className="bg-info/20 text-info w-5 h-5 rounded flex items-center justify-center text-xs">
                1
              </span>
              Select Resource
            </h3>

            <div className="space-y-3">
              {isLoading
                ? Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-16 bg-surface-3/50 animate-pulse rounded-xl"
                    ></div>
                  ))
                : resources.map((res) => (
                    <motion.div
                      key={res.id}
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.99 }}
                      onClick={() => setSelectedResource(res)}
                      className={`cursor-pointer flex items-center gap-4 p-3 rounded-xl border transition-all ${
                        selectedResource?.id === res.id
                          ? "bg-info/10 border-info/50 shadow-[0_0_15px_rgba(37,99,235,0.15)]"
                          : "bg-canvas border-line/80 hover:border-line"
                      }`}
                    >
                      <div
                        className={`p-2 rounded-lg ${
                          selectedResource?.id === res.id
                            ? "bg-info text-white"
                            : "bg-surface-3 text-ink-muted"
                        }`}
                      >
                        {getResourceIcon(res.type)}
                      </div>
                      <div>
                        <h4
                          className={`text-sm font-semibold ${
                            selectedResource?.id === res.id
                              ? "text-info"
                              : "text-ink"
                          }`}
                        >
                          {res.name}
                        </h4>
                        <div className="flex gap-3 text-xs text-ink-subtle mt-1">
                          <span className="flex items-center gap-1">
                            <Users size={10} /> {res.capacity}
                          </span>
                          <span className="flex items-center gap-1">
                            <MapPin size={10} /> {res.location}
                          </span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
            </div>
          </div>

          {/* Step 2: Select Date */}
          <div className="bg-surface-2 border border-line/80 rounded-2xl p-6 shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-semibold text-ink-muted uppercase tracking-wider flex items-center gap-2">
                <span className="bg-info/20 text-info w-5 h-5 rounded flex items-center justify-center text-xs">
                  2
                </span>
                Select Date
              </h3>
              <span className="text-ink font-medium text-sm">
                {new Date().toLocaleString("default", { month: "long", year: "numeric" })}
              </span>
            </div>

            <div className="grid grid-cols-7 gap-1 sm:gap-2">
              {["S", "M", "T", "W", "T", "F", "S"].map((day, i) => (
                <div
                  key={`dow-${i}`}
                  className="text-center text-xs font-semibold text-ink-faint py-1"
                >
                  {day}
                </div>
              ))}
              {daysInMonth.map((day) => {
                const isPast = day < now.getDate();
                return (
                <button
                  key={day}
                  onClick={() => setSelectedDate(day)}
                  disabled={isPast}
                  className={`w-full aspect-square flex items-center justify-center rounded-lg text-sm font-medium transition-all ${
                    isPast
                      ? "text-ink cursor-not-allowed"
                      : selectedDate === day
                      ? "bg-info text-white shadow-lg shadow-blue-900/30"
                      : "text-ink-soft hover:bg-surface-3"
                  }`}
                >
                  {day}
                </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Time Slots */}
        <div className="lg:col-span-7">
          <div className="bg-surface-2 border border-line/80 rounded-2xl p-6 shadow-xl h-full flex flex-col">
            <div className="flex justify-between items-end mb-6 pb-4 border-b border-line/50">
              <div>
                <h3 className="text-sm font-semibold text-ink-muted uppercase tracking-wider flex items-center gap-2 mb-1">
                  <span className="bg-info/20 text-info w-5 h-5 rounded flex items-center justify-center text-xs">
                    3
                  </span>
                  Available Slots
                </h3>
                <h2 className="text-xl font-bold text-ink">
                  {activeResource?.name || "Select a resource"}
                </h2>
                <p className="text-sm text-info flex items-center gap-1 mt-1">
                  <CalendarIcon size={14} /> {new Date().toLocaleString("default", { month: "short" })} {selectedDate}, {new Date().getFullYear()}
                </p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto pr-2 space-y-3">
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-16 bg-surface-3/30 animate-pulse rounded-xl border border-line/50"
                  ></div>
                ))
              ) : (
                <motion.div
                  variants={containerVariants}
                  initial="hidden"
                  animate="show"
                  className="space-y-3"
                >
                  {slots.map((slot) => {
                    const isBooked = slot.status === "booked";
                    const isPast = slot.status === "past";
                    const isSelected = selectedSlot === slot.id;

                    return (
                      <motion.button
                        key={slot.id}
                        variants={itemVariants}
                        disabled={isBooked || isPast}
                        onClick={() => setSelectedSlot(slot.id)}
                        className={`w-full flex items-center justify-between p-4 rounded-xl border text-left transition-all ${
                          isBooked || isPast
                            ? "bg-danger/5 border-danger/10 cursor-not-allowed opacity-75"
                            : isSelected
                            ? "bg-info/10 border-info shadow-[0_0_20px_rgba(37,99,235,0.15)]"
                            : "bg-canvas border-line hover:border-line hover:bg-surface-3/50"
                        }`}
                      >
                        <div className="flex items-center gap-4">
                          <div
                            className={`p-2 rounded-lg ${
                              isBooked
                                ? "bg-danger/10 text-danger"
                                : isPast
                                ? "bg-surface-3 text-ink-faint"
                                : isSelected
                                ? "bg-info text-white"
                                : "bg-surface-3 text-ink-muted"
                            }`}
                          >
                            <Clock size={18} />
                          </div>
                          <div>
                            <p
                              className={`font-semibold ${
                                isBooked || isPast
                                  ? "text-ink-subtle"
                                  : isSelected
                                  ? "text-info"
                                  : "text-ink"
                              }`}
                            >
                              {slot.time}
                            </p>
                            <p className="text-xs text-ink-subtle mt-0.5">
                              {isBooked
                                ? `Overlap conflict: booked by ${slot.bookedBy ?? "another user"}`
                                : isPast
                                ? "This time has already passed today"
                                : "Slot available for booking"}
                            </p>
                          </div>
                        </div>

                        <div>
                          {isBooked ? (
                            <div className="flex items-center gap-1.5 px-3 py-1 bg-danger/10 text-danger rounded-full text-xs font-semibold border border-danger/20">
                              <Lock size={12} /> Unavailable
                            </div>
                          ) : isPast ? (
                            <div className="flex items-center gap-1.5 px-3 py-1 bg-surface-3 text-ink-subtle rounded-full text-xs font-semibold border border-line">
                              <Lock size={12} /> Past
                            </div>
                          ) : isSelected ? (
                            <div className="flex items-center gap-1.5 px-3 py-1 bg-info text-white rounded-full text-xs font-semibold shadow-md shadow-blue-500/20">
                              <CheckCircle2 size={12} /> Selected
                            </div>
                          ) : (
                            <ChevronRight
                              size={18}
                              className="text-ink-faint"
                            />
                          )}
                        </div>
                      </motion.button>
                    );
                  })}
                </motion.div>
              )}
            </div>

            {/* Sticky Action Footer */}
            <div className="mt-6 pt-4 border-t border-line/50">
              <motion.button
                whileHover={{ scale: selectedSlot ? 1.01 : 1 }}
                whileTap={{ scale: selectedSlot ? 0.99 : 1 }}
                disabled={!selectedSlot || booking}
                onClick={handleConfirmBooking}
                className={`w-full py-3.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 ${
                  selectedSlot && !booking
                    ? "bg-info hover:bg-info text-white shadow-[0_0_20px_rgba(37,99,235,0.3)]"
                    : "bg-surface-3 text-ink-subtle cursor-not-allowed"
                }`}
              >
                {booking ? (
                  <><Loader2 size={16} className="animate-spin" /> Confirming…</>
                ) : selectedSlot ? (
                  "Confirm Booking"
                ) : (
                  "Select a time slot to continue"
                )}
              </motion.button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
