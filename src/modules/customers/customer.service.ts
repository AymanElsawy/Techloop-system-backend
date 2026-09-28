import type { QueryFilter } from 'mongoose';
import { CustomerModel, type Customer } from './customer.model.js';
import { CustomerStatus } from './customer.types.js';
import type {
  CreateCustomerInput,
  ListCustomersFilters,
  UpdateCustomerInput,
} from './customer.validation.js';
import type { UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';
import { AppError } from '../../utils/api-response.js';

const isManager = (actor: UserDocument) =>
  actor.role === UserRole.OWNER || actor.role === UserRole.ADMIN;

/** Contact details a rep may change on any non-rejected customer. */
const REP_EDITABLE_FIELDS = new Set([
  'phone',
  'contactPerson',
  'city',
  'address',
  'location',
  'notes',
]);

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const withPeople = { path: 'createdBy reviewedBy', select: 'name' };

/** Rejected customers are visible only to managers and to the rep who added them. */
/** Reps see only customers in their region's governorates (no region = no customers). */
export function visibilityFilter(actor: UserDocument): QueryFilter<Customer> {
  return isManager(actor)
    ? {}
    : {
        governorate: { $in: actor.governorates },
        $or: [{ status: { $ne: CustomerStatus.REJECTED } }, { createdBy: actor._id }],
      };
}

function assertInRegion(governorate: string | undefined, actor: UserDocument) {
  if (governorate && !isManager(actor) && !(actor.governorates as string[]).includes(governorate)) {
    throw new AppError(403, 'Governorate is outside your region');
  }
}

export function createCustomer(input: CreateCustomerInput, actor: UserDocument) {
  assertInRegion(input.governorate, actor);
  const approved = isManager(actor);
  return CustomerModel.create({
    ...input,
    status: approved ? CustomerStatus.APPROVED : CustomerStatus.PENDING,
    createdBy: actor._id,
    ...(approved && { reviewedBy: actor._id, reviewedAt: new Date() }),
  });
}

export function listCustomers(
  { governorate, status, search }: ListCustomersFilters,
  actor: UserDocument,
) {
  const filters: QueryFilter<Customer>[] = [visibilityFilter(actor)];
  if (governorate) filters.push({ governorate });
  if (status) filters.push({ status });
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filters.push({ $or: [{ name: pattern }, { phone: pattern }] });
  }
  return CustomerModel.find({ $and: filters }).sort({ name: 1 }).populate(withPeople);
}

export async function getCustomerById(id: string, actor: UserDocument) {
  const customer = await CustomerModel.findOne({ _id: id, ...visibilityFilter(actor) }).populate(
    withPeople,
  );
  if (!customer) throw new AppError(404, 'Customer not found');
  return customer;
}

export async function updateCustomer(id: string, input: UpdateCustomerInput, actor: UserDocument) {
  const customer = await getCustomerById(id, actor);
  const ownPending =
    customer.status === CustomerStatus.PENDING &&
    String(customer.createdBy._id) === String(actor._id);

  assertInRegion(input.governorate ?? undefined, actor);

  // Reps may update contact details of any customer they can see, except rejected ones.
  if (!isManager(actor) && !ownPending) {
    if (customer.status === CustomerStatus.REJECTED) throw new AppError(403, 'Forbidden');
    const restricted = Object.keys(input).filter(
      (key) =>
        input[key as keyof UpdateCustomerInput] !== undefined && !REP_EDITABLE_FIELDS.has(key),
    );
    if (restricted.length)
      throw new AppError(403, `Sales reps cannot edit: ${restricted.join(', ')}`);
  }

  customer.set(input);
  return customer.save();
}

export async function approveCustomer(id: string, actor: UserDocument) {
  const customer = await getCustomerById(id, actor);
  if (customer.status === CustomerStatus.APPROVED)
    throw new AppError(400, 'Customer is already approved');

  customer.set({
    status: CustomerStatus.APPROVED,
    rejectionReason: null,
    reviewedBy: actor._id,
    reviewedAt: new Date(),
  });
  await customer.save();
  return customer.populate(withPeople);
}

export async function rejectCustomer(id: string, reason: string, actor: UserDocument) {
  const customer = await getCustomerById(id, actor);
  if (customer.status !== CustomerStatus.PENDING)
    throw new AppError(400, 'Only pending customers can be rejected');

  customer.set({
    status: CustomerStatus.REJECTED,
    rejectionReason: reason,
    reviewedBy: actor._id,
    reviewedAt: new Date(),
  });
  await customer.save();
  return customer.populate(withPeople);
}
