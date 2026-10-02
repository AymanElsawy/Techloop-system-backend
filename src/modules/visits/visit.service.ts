import type { QueryFilter } from 'mongoose';
import { VisitModel, type Visit } from './visit.model.js';
import { VisitStatus } from './visit.types.js';
import type {
  CompleteVisitInput,
  CreateVisitInput,
  ListVisitsFilters,
} from './visit.validation.js';
import { CustomerModel } from '../customers/customer.model.js';
import { CustomerStatus } from '../customers/customer.types.js';
import { getCustomerById } from '../customers/customer.service.js';
import { UserModel, type UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';
import { AppError } from '../../utils/api-response.js';
import { VISIT, notify } from '../notifications/notification.service.js';

const isManager = (actor: UserDocument) =>
  actor.role === UserRole.OWNER || actor.role === UserRole.ADMIN;

const withRefs = [
  { path: 'customer', select: 'name phone governorate city address location debit status' },
  { path: 'salesRep createdBy', select: 'name' },
];

/** Reps only see visits assigned to them. */
const visibility = (actor: UserDocument) => (isManager(actor) ? {} : { salesRep: actor._id });

export async function createVisit(input: CreateVisitInput, actor: UserDocument) {
  // Reps always visit themselves; managers pick an active rep.
  let rep: UserDocument | null = actor;
  if (isManager(actor)) {
    if (!input.salesRepId) throw new AppError(400, 'salesRepId is required');
    rep = await UserModel.findOne({
      _id: input.salesRepId,
      role: UserRole.SALES_REP,
      isActive: true,
    });
    if (!rep) throw new AppError(400, 'Sales rep not found');
  }

  const customer = isManager(actor)
    ? await CustomerModel.findById(input.customerId)
    : await getCustomerById(input.customerId, actor);
  if (!customer) throw new AppError(404, 'Customer not found');
  if (customer.status === CustomerStatus.REJECTED)
    throw new AppError(400, 'Cannot visit a rejected customer');
  if (!rep.governorates.includes(customer.governorate)) {
    throw new AppError(400, "Customer is outside the sales rep's region");
  }

  const visit = await VisitModel.create({
    customer: customer._id,
    salesRep: rep._id,
    createdBy: actor._id,
    purpose: input.purpose,
    scheduledAt: input.scheduledAt,
  });
  await notify({ type: VISIT, docId: visit.id, number: null, party: customer }, actor);
  return visit.populate(withRefs);
}

export function listVisits(
  { from, to, status, customerId }: ListVisitsFilters,
  actor: UserDocument,
) {
  const filter: QueryFilter<Visit> = { ...visibility(actor) };
  if (from || to)
    filter.scheduledAt = {
      ...(from && { $gte: new Date(from) }),
      ...(to && { $lt: new Date(to) }),
    };
  if (status) filter.status = status;
  if (customerId) filter.customer = customerId;
  return VisitModel.find(filter).sort({ scheduledAt: 1 }).populate(withRefs);
}

export async function getVisitById(id: string, actor: UserDocument) {
  const visit = await VisitModel.findOne({ _id: id, ...visibility(actor) }).populate(withRefs);
  if (!visit) throw new AppError(404, 'Visit not found');
  return visit;
}

/** Only the assigned rep performs a visit in the field. */
async function getOwnVisit(id: string, actor: UserDocument, expected: VisitStatus) {
  const visit = await getVisitById(id, actor);
  if (String(visit.salesRep._id) !== String(actor._id)) {
    throw new AppError(403, 'Only the assigned sales rep can do this');
  }
  if (visit.status !== expected) throw new AppError(400, `Visit must be ${expected}`);
  return visit;
}

export async function startVisit(
  id: string,
  location: { latitude?: number; longitude?: number },
  actor: UserDocument,
) {
  const visit = await getOwnVisit(id, actor, VisitStatus.PLANNED);
  visit.set({
    status: VisitStatus.IN_PROGRESS,
    startedAt: new Date(),
    latitude: location.latitude ?? null,
    longitude: location.longitude ?? null,
  });
  await visit.save();
  return visit;
}

export async function completeVisit(id: string, input: CompleteVisitInput, actor: UserDocument) {
  const visit = await getOwnVisit(id, actor, VisitStatus.IN_PROGRESS);
  visit.set({
    status: VisitStatus.COMPLETED,
    completedAt: new Date(),
    notes: input.notes || null,
    productsDiscussed: input.productsDiscussed ?? [],
    customerFeedback: input.customerFeedback || null,
    nextVisitAt: input.nextVisitAt ?? null,
  });
  await visit.save();
  return visit;
}

export async function cancelVisit(
  id: string,
  reason: string | null | undefined,
  actor: UserDocument,
) {
  const visit = await getVisitById(id, actor);
  if (visit.status !== VisitStatus.PLANNED)
    throw new AppError(400, 'Only planned visits can be cancelled');
  visit.set({
    status: VisitStatus.CANCELLED,
    cancelReason: reason || null,
    cancelledAt: new Date(),
  });
  await visit.save();
  return visit;
}

/**
 * Used by invoices and collections: a sale or payment can be linked to the rep's own
 * in-progress visit for the same customer.
 */
export async function assertLinkableVisit(
  visitId: string,
  customerId: string,
  actor: UserDocument,
) {
  const visit = await VisitModel.findOne({ _id: visitId, salesRep: actor._id });
  if (!visit) throw new AppError(400, 'Visit not found');
  if (visit.status !== VisitStatus.IN_PROGRESS) throw new AppError(400, 'Visit is not in progress');
  if (String(visit.customer) !== customerId)
    throw new AppError(400, 'Visit belongs to another customer');
  return visit;
}
