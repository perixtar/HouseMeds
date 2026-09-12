import type postgres from 'postgres';
import { getDbClient } from './db-client';
import type { PrescriptionRepository } from '../../ports/prescription-repository.port';
import type {
  DosageUnit,
  FetchPriceQuote,
  Medicine,
  MedicineForm,
  Member,
  PrescriptionHousehold,
  PrescriptionSummary,
  PriceComparisonStatus,
  StrengthUnit,
} from '../../domain/types';

interface MedicineJson {
  id: string;
  name: string;
  genericName: string;
  form: MedicineForm;
  strength: number;
  strengthUnit: StrengthUnit;
  dosageUnit: DosageUnit;
  quantity: number;
  frequency: string;
  prescriberName: string;
  refills: number;
  medId: string;
  unitPrice: number;
  total: number;
  deleted: boolean;
}

interface MemberJson {
  id: string;
  nickname: string;
  medicines: MedicineJson[];
}

interface PrescriptionRow {
  id: string;
  household_id: string;
  submitted_at: Date;
  last_updated_at: Date;
  total_price: string;
  deleted: boolean;
  price_comparison_status: PriceComparisonStatus;
  members: MemberJson[] | null;
}

interface QuoteRow {
  medicine_id: string;
  med_id: string;
  rx_norm_id: string;
  price: string;
  pharmacy: string;
  name: string;
  form: MedicineForm;
  dosage_unit: DosageUnit;
  quantity: number;
  strength: string;
  strength_unit: StrengthUnit;
}

function toDomain(row: PrescriptionRow, quotes: QuoteRow[]): PrescriptionHousehold {
  return {
    id: row.id,
    householdId: row.household_id,
    submittedAt: row.submitted_at,
    lastUpdatedAt: row.last_updated_at,
    totalPrice: Number(row.total_price),
    deleted: row.deleted,
    members: (row.members ?? []) as Member[],
    priceComparisonStatus: row.price_comparison_status,
    priceComparisons: quotes.map((q): FetchPriceQuote => ({
      medicineId: q.medicine_id,
      medId: q.med_id,
      rxNormId: q.rx_norm_id,
      price: Number(q.price),
      pharmacy: q.pharmacy,
      name: q.name,
      form: q.form,
      dosageUnit: q.dosage_unit,
      quantity: q.quantity,
      strength: Number(q.strength),
      strengthUnit: q.strength_unit,
    })),
  };
}

// Members/medicines are never deleted, only soft-deleted in place — upsert by
// the domain-assigned id covers both "new line" and "existing line edited".
async function upsertMembersAndMedicines(
  tx: postgres.TransactionSql,
  prescriptionHouseholdId: string,
  members: Member[],
): Promise<void> {
  for (const member of members) {
    await tx`
      insert into members (id, prescription_household_id, nickname)
      values (${member.id}, ${prescriptionHouseholdId}, ${member.nickname})
      on conflict (id) do update set nickname = excluded.nickname
    `;
    for (const med of member.medicines) {
      await insertOrUpdateMedicine(tx, member.id, med);
    }
  }
}

async function insertOrUpdateMedicine(
  tx: postgres.TransactionSql,
  memberId: string,
  med: Medicine,
): Promise<void> {
  await tx`
    insert into medicines (
      id, member_id, name, generic_name, form, strength, strength_unit,
      dosage_unit, quantity, frequency, prescriber_name, refills, med_id,
      unit_price, total, deleted
    ) values (
      ${med.id}, ${memberId}, ${med.name}, ${med.genericName}, ${med.form},
      ${med.strength}, ${med.strengthUnit}, ${med.dosageUnit}, ${med.quantity},
      ${med.frequency}, ${med.prescriberName}, ${med.refills}, ${med.medId},
      ${med.unitPrice}, ${med.total}, ${med.deleted}
    )
    on conflict (id) do update set
      name = excluded.name,
      generic_name = excluded.generic_name,
      form = excluded.form,
      strength = excluded.strength,
      strength_unit = excluded.strength_unit,
      dosage_unit = excluded.dosage_unit,
      quantity = excluded.quantity,
      frequency = excluded.frequency,
      prescriber_name = excluded.prescriber_name,
      refills = excluded.refills,
      med_id = excluded.med_id,
      unit_price = excluded.unit_price,
      total = excluded.total,
      deleted = excluded.deleted
  `;
}

// Quotes aren't append-only history — each submission's comparison result
// wholesale replaces the previous one, same as the old embedded array did.
async function replaceQuotes(
  tx: postgres.TransactionSql,
  prescriptionHouseholdId: string,
  quotes: FetchPriceQuote[],
): Promise<void> {
  await tx`
    delete from medicine_price_quotes
    where medicine_id in (
      select med.id from medicines med
      join members m on m.id = med.member_id
      where m.prescription_household_id = ${prescriptionHouseholdId}
    )
  `;
  for (const q of quotes) {
    await tx`
      insert into medicine_price_quotes (
        medicine_id, med_id, rx_norm_id, price, pharmacy, name, form,
        dosage_unit, quantity, strength, strength_unit
      ) values (
        ${q.medicineId}, ${q.medId}, ${q.rxNormId}, ${q.price}, ${q.pharmacy},
        ${q.name}, ${q.form}, ${q.dosageUnit}, ${q.quantity}, ${q.strength},
        ${q.strengthUnit}
      )
    `;
  }
}

export class SupabasePrescriptionRepository implements PrescriptionRepository {
  async create(
    prescription: Omit<PrescriptionHousehold, 'id'>,
  ): Promise<PrescriptionHousehold> {
    const sql = await getDbClient();
    const id = await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into prescription_households
          (household_id, submitted_at, last_updated_at, total_price, deleted, price_comparison_status)
        values (
          ${prescription.householdId}, ${prescription.submittedAt},
          ${prescription.lastUpdatedAt}, ${prescription.totalPrice},
          ${prescription.deleted}, ${prescription.priceComparisonStatus}
        )
        returning id
      `;
      const prescriptionId = row!.id;
      await upsertMembersAndMedicines(tx, prescriptionId, prescription.members);
      await replaceQuotes(tx, prescriptionId, prescription.priceComparisons);
      return prescriptionId;
    });
    return { id, ...prescription };
  }

  async findById(id: string, householdId: string): Promise<PrescriptionHousehold | null> {
    const sql = await getDbClient();
    // Scoped server-side to the authenticated household's own id.
    const rows = await sql<PrescriptionRow[]>`
      select
        ph.id, ph.household_id, ph.submitted_at, ph.last_updated_at, ph.total_price,
        ph.deleted, ph.price_comparison_status,
        coalesce(members_agg.members, '[]'::json) as members
      from prescription_households ph
      left join lateral (
        select json_agg(json_build_object(
          'id', m.id,
          'nickname', m.nickname,
          'medicines', coalesce(meds_agg.medicines, '[]'::json)
        )) as members
        from members m
        left join lateral (
          select json_agg(json_build_object(
            'id', med.id, 'name', med.name, 'genericName', med.generic_name,
            'form', med.form, 'strength', med.strength, 'strengthUnit', med.strength_unit,
            'dosageUnit', med.dosage_unit, 'quantity', med.quantity,
            'frequency', med.frequency, 'prescriberName', med.prescriber_name,
            'refills', med.refills, 'medId', med.med_id, 'unitPrice', med.unit_price,
            'total', med.total, 'deleted', med.deleted
          )) as medicines
          from medicines med
          where med.member_id = m.id
        ) meds_agg on true
        where m.prescription_household_id = ph.id
      ) members_agg on true
      where ph.id = ${id} and ph.household_id = ${householdId}
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;

    const quotes = await sql<QuoteRow[]>`
      select mpq.medicine_id, mpq.med_id, mpq.rx_norm_id, mpq.price, mpq.pharmacy,
        mpq.name, mpq.form, mpq.dosage_unit, mpq.quantity, mpq.strength, mpq.strength_unit
      from medicine_price_quotes mpq
      join medicines med on med.id = mpq.medicine_id
      join members m on m.id = med.member_id
      where m.prescription_household_id = ${id}
      order by mpq.fetched_at asc
    `;

    return toDomain(row, quotes);
  }

  async listByHousehold(
    householdId: string,
    options: { includeDeleted: boolean },
  ): Promise<PrescriptionSummary[]> {
    const sql = await getDbClient();
    const rows = await sql<
      { id: string; submitted_at: Date; last_updated_at: Date; total_price: string }[]
    >`
      select id, submitted_at, last_updated_at, total_price
      from prescription_households
      where household_id = ${householdId}
      ${options.includeDeleted ? sql`` : sql`and deleted = false`}
      order by submitted_at desc
    `;

    return rows.map((row) => ({
      id: row.id,
      submittedAt: row.submitted_at,
      lastUpdatedAt: row.last_updated_at,
      totalPrice: Number(row.total_price),
    }));
  }

  async replace(prescription: PrescriptionHousehold): Promise<PrescriptionHousehold> {
    const sql = await getDbClient();
    await sql.begin(async (tx) => {
      await tx`
        update prescription_households set
          last_updated_at = ${prescription.lastUpdatedAt},
          total_price = ${prescription.totalPrice},
          deleted = ${prescription.deleted},
          price_comparison_status = ${prescription.priceComparisonStatus}
        where id = ${prescription.id} and household_id = ${prescription.householdId}
      `;
      await upsertMembersAndMedicines(tx, prescription.id, prescription.members);
      await replaceQuotes(tx, prescription.id, prescription.priceComparisons);
    });
    return prescription;
  }

  async softDelete(id: string, householdId: string): Promise<boolean> {
    const sql = await getDbClient();
    const rows = await sql`
      update prescription_households set deleted = true, last_updated_at = now()
      where id = ${id} and household_id = ${householdId}
      returning id
    `;
    return rows.length > 0;
  }
}
