/**
 * Demo seed data for AssetFlow. Idempotent — safe to run repeatedly.
 * Creates one user per role, a few departments/categories, and sample assets.
 *
 * Run with:  npm run seed
 *
 * Default password for EVERY seeded account: "password123"
 */
import { Role, AssetCondition } from '@prisma/client';

import { hashPassword } from '../src/common/security/password';
import { createPrismaClient } from '../src/prisma/prisma.service';

// The client is generated with `engineType = "client"`, so it needs a driver
// adapter — reuse the exact same factory the API uses.
const prisma = createPrismaClient(process.env.DATABASE_URL ?? '');

async function main() {
  const passwordHash = await hashPassword('password123', {
    rounds: Number(process.env.BCRYPT_ROUNDS ?? 12),
  });

  // --- Departments ---
  const it = await prisma.department.upsert({
    where: { name: 'IT' },
    update: {},
    create: { name: 'IT' },
  });
  const facilities = await prisma.department.upsert({
    where: { name: 'Facilities' },
    update: {},
    create: { name: 'Facilities' },
  });
  const hr = await prisma.department.upsert({
    where: { name: 'HR' },
    update: {},
    create: { name: 'HR' },
  });

  // --- Users (one per role) ---
  const upsertUser = (
    email: string,
    name: string,
    role: Role,
    departmentId?: string,
  ) =>
    prisma.user.upsert({
      where: { email },
      update: { role, name, departmentId },
      create: { email, name, role, passwordHash, departmentId },
    });

  const admin = await upsertUser('admin@assetflow.com', 'Ava Admin', Role.ADMIN);
  const manager = await upsertUser(
    'manager@assetflow.com',
    'Manav Manager',
    Role.ASSET_MANAGER,
    it.id,
  );
  const head = await upsertUser(
    'head@assetflow.com',
    'Hana Head',
    Role.DEPARTMENT_HEAD,
    it.id,
  );
  const priya = await upsertUser('priya@acme.com', 'Priya Sharma', Role.EMPLOYEE, it.id);
  const raj = await upsertUser('raj@acme.com', 'Raj Verma', Role.EMPLOYEE, facilities.id);

  // Make Hana the head of IT.
  await prisma.department.update({
    where: { id: it.id },
    data: { headId: head.id },
  });

  // --- Categories ---
  const electronics = await prisma.assetCategory.upsert({
    where: { name: 'Electronics' },
    update: {},
    create: {
      name: 'Electronics',
      customFields: [{ key: 'warrantyMonths', type: 'number' }],
    },
  });
  const furniture = await prisma.assetCategory.upsert({
    where: { name: 'Furniture' },
    update: {},
    create: { name: 'Furniture' },
  });
  const vehicles = await prisma.assetCategory.upsert({
    where: { name: 'Vehicles' },
    update: {},
    create: { name: 'Vehicles' },
  });

  // --- Sample assets (explicit tags AF-0001..) ---
  const assets: Array<{
    assetTag: string;
    name: string;
    categoryId: string;
    isBookable?: boolean;
    location?: string;
    condition?: AssetCondition;
  }> = [
    { assetTag: 'AF-0001', name: 'MacBook Pro 14"', categoryId: electronics.id, location: 'HQ-3F' },
    { assetTag: 'AF-0002', name: 'Dell Monitor 27"', categoryId: electronics.id, location: 'HQ-3F' },
    { assetTag: 'AF-0003', name: 'Ergonomic Chair', categoryId: furniture.id, location: 'HQ-2F' },
    { assetTag: 'AF-0004', name: 'Meeting Room B2', categoryId: furniture.id, isBookable: true, location: 'HQ-2F' },
    { assetTag: 'AF-0005', name: 'Company Van', categoryId: vehicles.id, isBookable: true, location: 'Garage' },
  ];
  for (const a of assets) {
    await prisma.asset.upsert({
      where: { assetTag: a.assetTag },
      update: {},
      create: {
        assetTag: a.assetTag,
        name: a.name,
        categoryId: a.categoryId,
        isBookable: a.isBookable ?? false,
        location: a.location,
        condition: a.condition ?? AssetCondition.GOOD,
      },
    });
  }

  console.log('Seed complete.');
  console.log('Accounts (password: password123):');
  console.log('  admin@assetflow.com   (ADMIN)');
  console.log('  manager@assetflow.com (ASSET_MANAGER)');
  console.log('  head@assetflow.com    (DEPARTMENT_HEAD)');
  console.log('  priya@acme.com        (EMPLOYEE)');
  console.log('  raj@acme.com          (EMPLOYEE)');
  void admin, manager, priya, raj;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
