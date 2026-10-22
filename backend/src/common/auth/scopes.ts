import { Prisma, Role } from '@prisma/client';

import type { AuthUser } from '../../auth/jwt.strategy';

/**
 * Row-level scoping helpers.
 *
 * The API is multi-tenant-ish: an ADMIN and an ASSET_MANAGER see the whole
 * organisation, a DEPARTMENT_HEAD sees their own department, an EMPLOYEE sees
 * only what is theirs. These helpers build the Prisma `where` clause that
 * implements that rule, so every list endpoint applies the *same* policy.
 */

/** Roles that are allowed to see organisation-wide data. */
export function isManager(user: AuthUser): boolean {
  return user.role === Role.ADMIN || user.role === Role.ASSET_MANAGER;
}

/** A value that can never match a real row — used for "has no scope at all". */
const NO_MATCH = '__no-match__';

/**
 * Which allocations may the user see?
 *
 * - manager    → everything
 * - dept. head → allocations of their department (by department *or* by holder)
 * - employee   → only the allocations where they are the holder
 */
export function allocationScope(user: AuthUser): Prisma.AllocationWhereInput {
  if (isManager(user)) return {};

  if (user.role === Role.DEPARTMENT_HEAD) {
    if (!user.departmentId) return { id: NO_MATCH };
    return {
      OR: [
        { departmentId: user.departmentId },
        { holderUser: { is: { departmentId: user.departmentId } } },
      ],
    };
  }

  return { holderUserId: user.id };
}

/**
 * Which maintenance requests may the user see?
 *
 * - manager    → everything
 * - dept. head → requests raised by their department, plus requests about
 *                assets their department currently holds
 * - employee   → only the requests they raised themselves
 */
export function maintenanceScope(
  user: AuthUser,
): Prisma.MaintenanceRequestWhereInput {
  if (isManager(user)) return {};

  if (user.role === Role.DEPARTMENT_HEAD) {
    if (!user.departmentId) return { id: NO_MATCH };
    return {
      OR: [
        { raisedBy: { is: { departmentId: user.departmentId } } },
        {
          asset: {
            is: {
              allocations: {
                some: {
                  status: 'ACTIVE',
                  OR: [
                    { departmentId: user.departmentId },
                    { holderUser: { is: { departmentId: user.departmentId } } },
                  ],
                },
              },
            },
          },
        },
      ],
    };
  }

  return { raisedById: user.id };
}

/**
 * Which bookings may the user see?
 *
 * - manager    → everything
 * - dept. head → bookings made by them or by their department
 * - employee   → only their own bookings
 */
export function bookingScope(user: AuthUser): Prisma.BookingWhereInput {
  if (isManager(user)) return {};

  if (user.role === Role.DEPARTMENT_HEAD) {
    if (!user.departmentId) return { id: NO_MATCH };
    return {
      OR: [
        { bookedById: user.id },
        { bookedBy: { is: { departmentId: user.departmentId } } },
      ],
    };
  }

  return { bookedById: user.id };
}
