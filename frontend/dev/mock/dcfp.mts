/**
 * The DCFP's flows for the mock API, in the Go API's shapes (docs/modules/orders.md):
 *
 * - `GET/POST /orders/stockouts`: hotspot stockout reports. A report notifies the district's
 *   DCFPs; it is not an order. `GET /orders/stockouts/:id` adds deliveries and history,
 *   `GET /orders/stockouts/:id/riders` lists the delivery agents, and
 *   `POST /orders/stockouts/:id/deliveries` sends stock from the district store, and
 *   `POST /orders/stockouts/:id/rejection` rejects a request before any stock goes.
 * - `POST /orders/warehouse-requests`: the DCFP orders a condom category and quantity from NMS or JMS,
 *   with no unit; the warehouse chooses the product and the order takes that product's unit.
 * - `POST /orders/district-dispatches`: NMS or JMS sends free stock to a district store before it
 *   orders, one dispatched order per product, all lines or none.
 * - `GET /orders`, `/orders/:id`, `/orders/:id/events`, and `POST /orders/:id/actions/{review,
 *   check-stock,reject,dispatch,receive}`: the warehouse approves, reserves and dispatches from
 *   the batches in `inventory.mts`, first expiry first out; the district's receipt adds to the
 *   batches at its store.
 * - `/notifications`: the signed-in user's central inbox.
 *
 * The mock user sees every store, as an administrator does: Wakiso's orders for the DCFP screens,
 * and a few other districts' orders for the warehouse screens. Seeded orders start at each
 * status.
 */
import { mockProductFacts, mockProductId, mockUnitId } from './admin.mts';
import { MOCK_STORES, mockDistrictStoreId } from './hotspots.mts';
import { addTo, log, planTake, reservableFor, reserve, take, type Take } from './inventory.mts';

interface Reply {
  status: number;
  body: unknown;
}

type Body = Record<string, unknown>;

type Status =
  'queued' | 'reviewed' | 'on_hold' | 'confirmed' | 'rejected' | 'dispatched' | 'received';

interface Order {
  id: string;
  condom_id: string | null;
  condom_category: 'male' | 'female';
  quantity_needed: number;
  quantity_issued: number | null;
  quantity_received: number | null;
  order_status: Status;
  order_date: string;
  ordered_by_id: string;
  handled_by_id: string | null;
  ordered_for_store_id: string;
  ordered_from_store_id: string;
  /** Null until the warehouse chooses the product; then the product's catalogue unit. */
  unit_of_measure_id: string | null;
  comment: string | null;
  discrepancy_note: string | null;
  quantity_approved: number | null;
  rejection_reason: string | null;
  waybill_number: string | null;
  vehicle_registration: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  /** Stock the warehouse sent without an order. */
  unrequested: boolean;
  hot_spot_id: null;
  parent_order_id: null;
  rider_id: null;
  delivery_note: null;
  created_at: string;
  updated_at: string;
}

interface Event {
  id: string;
  order_id: string;
  actor_id: string;
  action: string;
  status: Status;
  created_at: string;
}

interface Report {
  id: string;
  hot_spot_id: string;
  hot_spot: {
    name: string;
    village: string | null;
    subcounty: string | null;
    district: string | null;
    contact_name: string | null;
    contact_phone: string | null;
  };
  condom_id: string | null;
  selection: 'male' | 'female' | 'both';
  product: string;
  district_store_id: string;
  reported_by_id: string;
  reported_by: string;
  comment: string | null;
  repeat_count: number;
  last_reported_at: string;
  status:
    'awaiting_supply' | 'awaiting_acknowledgement' | 'partly_received' | 'fulfilled' | 'rejected';
  rejected_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  created_at: string;
}

interface Rider {
  id: string;
  name: string;
  phone: string | null;
}

/** Delivery agents working in the mock DCFP's district (GET /orders/stockouts/:id/riders). */
const riders = (): Rider[] => [
  { id: id(11, 1), name: 'Moses Kato', phone: '0772 000111' },
  { id: id(11, 2), name: 'Sarah Achieng', phone: null },
];

/** Stock the district sent a hotspot against a report, in the Go API's shape. */
interface HotspotDelivery {
  id: string;
  note: string | null;
  created_at: string;
  /** The delivery agent carrying it, when one was named. */
  rider: Rider | null;
  lines: {
    id: string;
    product: string;
    category: 'male' | 'female';
    quantity: number;
    pieces: number;
    acknowledged_pieces: number | null;
    acknowledged_at: string | null;
  }[];
}

interface ReportEvent {
  id: string;
  action: 'raised' | 'repeated' | 'selection_changed' | 'delivered' | 'acknowledged' | 'rejected';
  selection: string;
  data: {
    comment?: string | null;
    lines?: { category: 'male' | 'female'; pieces: number }[];
    reason?: string;
  };
  created_at: string;
}

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  resource_type: string | null;
  resource_id: string | null;
  actor_id: string | null;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

const id = (prefix: number, n: number) =>
  `00000000-0000-4000-${String(8300 + prefix)}-${String(n).padStart(12, '0')}`;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000).toISOString();

const DISTRICT = mockDistrictStoreId('Wakiso') ?? '';
const NMS = MOCK_STORES.find((store) => store.code === 'nms')?.id ?? '';
const JMS = MOCK_STORES.find((store) => store.code === 'jms')?.id ?? '';
const NATIONAL = new Set([NMS, JMS]);
const ME = '00000000-0000-4000-8002-000000000001';
const WAREHOUSE_STAFF = '00000000-0000-4000-8002-000000000009';

/** Products the seed refers to, by the admin mock's numbering, and what the API calls them. */
const PRODUCTS: Record<string, { name: string; unit: string | null }> = {
  [mockProductId(1)]: { name: 'Engabu Free Male', unit: mockUnitId(1) },
  [mockProductId(2)]: { name: 'Engabu Free Male', unit: mockUnitId(2) },
  [mockProductId(3)]: { name: 'Engabu Free Male', unit: mockUnitId(3) },
  [mockProductId(4)]: { name: 'FC2 Free Female', unit: mockUnitId(1) },
  [mockProductId(5)]: { name: 'FC2 Free Female', unit: mockUnitId(2) },
  [mockProductId(7)]: { name: 'Trust Commercial Male', unit: null },
  [mockProductId(99)]: {
    name: 'A brand name long enough Socially marketed Female',
    unit: mockUnitId(3),
  },
};

/** The condom category of a seeded product, read from its name. */
const categoryOf = (product: string | null): 'male' | 'female' =>
  product && PRODUCTS[product]?.name.endsWith('Female') ? 'female' : 'male';

const state = {
  orders: [] as Order[],
  events: [] as Event[],
  reports: [] as Report[],
  deliveries: new Map<string, HotspotDelivery[]>(),
  reportEvents: new Map<string, ReportEvent[]>(),
  /** Client references already recorded, so a retried send is saved once. */
  deliveryRefs: new Set<string>(),
  notifications: [] as Notification[],
  /** The batches each dispatched order took, for the district's receipt. */
  shipments: new Map<string, Take[]>(),
  next: 1,
};

const ok = (data: unknown, status = 200): Reply => ({ status, body: { success: true, data } });
const fail = (status: number, message: string, error?: Record<string, string>): Reply => ({
  status,
  body: error ? { success: false, message, error } : { success: false, message },
});

function order(
  n: number,
  values: Partial<Order> & Pick<Order, 'order_status'>,
  hours: number,
): Order {
  const quantity = values.quantity_needed ?? 500;
  const product = values.condom_id === undefined ? mockProductId(5) : values.condom_id;
  return {
    id: id(1, n),
    condom_id: product,
    condom_category: categoryOf(product),
    quantity_needed: quantity,
    quantity_issued: null,
    quantity_received: null,
    order_date: hoursAgo(hours).slice(0, 10),
    ordered_by_id: ME,
    handled_by_id: null,
    ordered_for_store_id: DISTRICT,
    ordered_from_store_id: NMS,
    unit_of_measure_id: product === null ? null : mockUnitId(2),
    comment: null,
    discrepancy_note: null,
    quantity_approved: null,
    rejection_reason: null,
    waybill_number: null,
    vehicle_registration: null,
    driver_name: null,
    driver_phone: null,
    unrequested: false,
    hot_spot_id: null,
    parent_order_id: null,
    rider_id: null,
    delivery_note: null,
    created_at: hoursAgo(hours),
    updated_at: hoursAgo(Math.max(hours - 6, 0)),
    ...values,
  };
}

/** The steps that brought a seeded order to its status. */
function historyOf(o: Order): Event[] {
  const steps: [string, Status, string][] = [['replenishment_requested', 'queued', ME]];
  const reached = ['queued', 'reviewed', 'on_hold', 'confirmed', 'dispatched', 'received'].indexOf(
    o.order_status,
  );
  if (reached >= 1) steps.push(['review', 'reviewed', WAREHOUSE_STAFF]);
  if (o.order_status === 'on_hold') steps.push(['check-stock', 'on_hold', WAREHOUSE_STAFF]);
  if (reached >= 3) steps.push(['check-stock', 'confirmed', WAREHOUSE_STAFF]);
  if (reached >= 4) steps.push(['dispatch', 'dispatched', WAREHOUSE_STAFF]);
  if (reached >= 5) steps.push(['receive', 'received', ME]);
  if (o.order_status === 'rejected') steps.push(['reject', 'rejected', WAREHOUSE_STAFF]);
  const start = Date.parse(o.created_at);
  return steps.map(([action, status, actor], index) => ({
    id: `${o.id}-e${index}`,
    order_id: o.id,
    actor_id: actor,
    action,
    status,
    created_at: new Date(start + index * 3 * 60 * 60_000).toISOString(),
  }));
}

function report(n: number, values: Partial<Report>, hours: number): Report {
  return {
    id: id(2, n),
    hot_spot_id: id(3, n),
    hot_spot: {
      name: 'Kisenyi Landing Site',
      village: 'Kisenyi',
      subcounty: 'Katabi Town Council',
      district: 'Wakiso',
      contact_name: 'Peter Okello',
      contact_phone: '0772 123456',
    },
    condom_id: null,
    selection: 'female',
    product: 'female condoms',
    district_store_id: DISTRICT,
    reported_by_id: id(4, n),
    reported_by: 'Grace Nakato',
    comment: null,
    repeat_count: 0,
    last_reported_at: hoursAgo(hours),
    status: 'awaiting_supply',
    rejected_at: null,
    rejected_by: null,
    rejection_reason: null,
    created_at: hoursAgo(hours),
    ...values,
  };
}

/** Where a report stands from its deliveries, as the Go API derives it. */
function statusOf(r: Report): Report['status'] {
  if (r.rejected_at) return 'rejected';
  const lines = (state.deliveries.get(r.id) ?? []).flatMap((d) => d.lines);
  if (lines.length === 0) return 'awaiting_supply';
  if (lines.some((line) => line.acknowledged_at === null)) return 'awaiting_acknowledgement';
  const short = lines.some((line) => (line.acknowledged_pieces ?? 0) < line.pieces);
  const covered = (category: 'male' | 'female') =>
    r.selection !== 'both' && r.selection !== category
      ? true
      : lines.some((line) => line.category === category);
  return !short && covered('male') && covered('female') ? 'fulfilled' : 'partly_received';
}

function addReportEvent(r: Report, event: Omit<ReportEvent, 'id' | 'selection'>): void {
  const events = state.reportEvents.get(r.id) ?? [];
  events.push({ id: `${r.id}-e${String(events.length)}`, selection: r.selection, ...event });
  state.reportEvents.set(r.id, events);
}

/** A seeded delivery: already sent (and maybe confirmed), so no stock moves now. */
function seedDelivery(
  r: Report,
  hours: number,
  lines: {
    product: string;
    category: 'male' | 'female';
    quantity: number;
    perUnit: number;
    received?: number;
  }[],
  note: string | null = null,
): void {
  const at = hoursAgo(hours);
  const delivery: HotspotDelivery = {
    id: `${r.id}-d${String((state.deliveries.get(r.id) ?? []).length)}`,
    note,
    created_at: at,
    rider: null,
    lines: lines.map((line, index) => ({
      id: `${r.id}-l${String(index)}`,
      product: line.product,
      category: line.category,
      quantity: line.quantity,
      pieces: line.quantity * line.perUnit,
      acknowledged_pieces: line.received ?? null,
      acknowledged_at: line.received === undefined ? null : hoursAgo(hours - 3),
    })),
  };
  state.deliveries.set(r.id, [...(state.deliveries.get(r.id) ?? []), delivery]);
  addReportEvent(r, {
    action: 'delivered',
    data: { lines: delivery.lines.map(({ category, pieces }) => ({ category, pieces })) },
    created_at: at,
  });
  const confirmed = delivery.lines.filter((line) => line.acknowledged_at !== null);
  if (confirmed.length > 0) {
    addReportEvent(r, {
      action: 'acknowledged',
      data: {
        lines: confirmed.map((line) => ({
          category: line.category,
          pieces: line.acknowledged_pieces ?? 0,
        })),
      },
      created_at: hoursAgo(hours - 3),
    });
  }
  r.status = statusOf(r);
}

function stockoutNotification(r: Report): Notification {
  const place = [r.hot_spot.village, r.hot_spot.subcounty, r.hot_spot.district]
    .filter(Boolean)
    .join(', ');
  const contact = [
    r.hot_spot.contact_name,
    r.hot_spot.contact_phone && `(${r.hot_spot.contact_phone})`,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    id: `${r.id}-n`,
    type: 'order.stockout_reported',
    title: `Stockout at ${r.hot_spot.name}`,
    body:
      `${r.hot_spot.name}${place ? `, ${place},` : ''} is out of ${r.product}.` +
      (r.comment ? ` Message: "${r.comment}"` : '') +
      ` Reported by ${r.reported_by}.` +
      (contact ? ` Contact: ${contact}.` : ''),
    resource_type: 'hotspot',
    resource_id: r.hot_spot_id,
    actor_id: r.reported_by_id,
    data: {
      report_id: r.id,
      hotspot: r.hot_spot.name,
      product: r.product,
      message: r.comment ?? '',
    },
    read_at: null,
    created_at: r.created_at,
  };
}

export function seedDcfp(dataset: string): void {
  state.next = 100;
  state.deliveries = new Map();
  state.reportEvents = new Map();
  state.deliveryRefs = new Set();
  if (dataset === 'empty') {
    Object.assign(state, { orders: [], events: [], reports: [], notifications: [] });
    return;
  }
  state.orders = [
    order(
      1,
      {
        order_status: 'queued',
        condom_id: null,
        condom_category: 'female',
        comment: 'Two hotspots in Katabi are out',
      },
      3,
    ),
    order(
      2,
      { order_status: 'on_hold', ordered_from_store_id: JMS, condom_id: mockProductId(2) },
      30,
    ),
    order(
      3,
      { order_status: 'dispatched', quantity_issued: 480, handled_by_id: WAREHOUSE_STAFF },
      52,
    ),
    order(
      4,
      {
        order_status: 'received',
        condom_id: mockProductId(2),
        quantity_needed: 1000,
        quantity_issued: 1000,
        quantity_received: 990,
        discrepancy_note: 'One box damaged in transit',
        handled_by_id: WAREHOUSE_STAFF,
      },
      24 * 9,
    ),
    order(
      5,
      {
        order_status: 'rejected',
        ordered_from_store_id: JMS,
        condom_id: null,
        condom_category: 'female',
        quantity_needed: 800,
        rejection_reason:
          'Female condoms are reserved for the national campaign until 15 December. Please order from NMS.',
      },
      24 * 4,
    ),
    // Other districts' orders, for the warehouse screens.
    order(
      6,
      {
        order_status: 'queued',
        ordered_for_store_id: mockDistrictStoreId('Kampala') ?? '',
        condom_id: null,
        condom_category: 'male',
        quantity_needed: 800,
        comment: 'Stock for the Independence Day outreach',
      },
      5,
    ),
    order(
      7,
      {
        order_status: 'queued',
        ordered_for_store_id: mockDistrictStoreId('Gulu') ?? '',
        condom_id: null,
        quantity_needed: 900,
      },
      26,
    ),
    order(
      8,
      {
        order_status: 'confirmed',
        ordered_for_store_id: mockDistrictStoreId('Mukono') ?? '',
        quantity_needed: 400,
        quantity_approved: 400,
      },
      40,
    ),
  ];
  state.reports = [
    report(1, { comment: 'Dispenser empty since Monday' }, 2),
    report(
      2,
      {
        hot_spot: {
          name: 'Nansana Bus Park',
          village: 'Nansana',
          subcounty: 'Nansana Division',
          district: 'Wakiso',
          contact_name: null,
          contact_phone: '0701 555123',
        },
        condom_id: mockProductId(2),
        selection: 'male',
        product: 'Engabu Free Male',
        reported_by: 'Moses Kato',
        comment: 'Running low. Weekend market',
      },
      20,
    ),
    report(
      3,
      {
        hot_spot: {
          name: 'Kasangati Bar 7',
          village: null,
          subcounty: null,
          district: 'Wakiso',
          contact_name: null,
          contact_phone: null,
        },
        reported_by: 'Agnes Atim',
      },
      24 * 12,
    ),
    report(
      4,
      {
        hot_spot: {
          name: 'Mpererwe Lodge',
          village: 'Mpererwe',
          subcounty: 'Kira Municipality',
          district: 'Wakiso',
          contact_name: 'Ruth Achieng',
          contact_phone: '0753 444210',
        },
        selection: 'male',
        product: 'male condoms',
        reported_by: 'Ruth Achieng',
        comment: 'Need more for the weekend',
      },
      24 * 6,
    ),
  ];
  if (dataset === 'worst') {
    state.reports.unshift(
      report(
        99,
        {
          hot_spot: {
            name: 'A hotspot with a name long enough to wrap twice in the table cell',
            village: 'V'.repeat(60),
            subcounty: null,
            district: 'Wakiso',
            contact_name: 'Someone With A Very Long Name Indeed',
            contact_phone: '+256 772 000000 ext. 12345',
          },
          selection: 'both',
          product: 'male and female condoms',
          comment: 'x'.repeat(600),
          repeat_count: 1_234,
        },
        1,
      ),
    );
  }
  for (const r of state.reports) {
    addReportEvent(r, { action: 'raised', data: { comment: r.comment }, created_at: r.created_at });
  }
  // Kisenyi said it again; Nansana got less than was sent; Kasangati has what it asked for.
  const [kisenyi, nansana, kasangati] = state.reports.filter((r) => !r.id.endsWith('99'));
  if (kisenyi) {
    kisenyi.repeat_count = 1;
    kisenyi.last_reported_at = hoursAgo(1);
    addReportEvent(kisenyi, {
      action: 'repeated',
      data: { comment: 'Still empty. Clients asking at the bar' },
      created_at: kisenyi.last_reported_at,
    });
  }
  if (nansana) {
    seedDelivery(
      nansana,
      16,
      [{ product: 'Engabu Free Male', category: 'male', quantity: 2, perUnit: 144, received: 240 }],
      'Sent with the VHT on the evening boda',
    );
  }
  if (kasangati) {
    seedDelivery(kasangati, 24 * 11, [
      { product: 'FC2 Free Female', category: 'female', quantity: 3, perUnit: 100, received: 300 },
    ]);
  }
  // Mpererwe was supplied the week before, so the district rejected its request.
  const mpererwe = state.reports.find((r) => r.id === id(2, 4));
  if (mpererwe)
    rejectReport(
      mpererwe,
      'The hotspot was supplied last week and should still have stock.',
      24 * 5,
    );
  state.events = state.orders.flatMap(historyOf);
  state.shipments = new Map();
  // Confirmed orders hold their reservations at the warehouse.
  for (const o of state.orders) {
    if (o.order_status === 'confirmed' && o.condom_id && o.unit_of_measure_id) {
      reserve(o.ordered_from_store_id, o.condom_id, o.unit_of_measure_id, approvedOf(o));
    }
  }
  state.notifications = state.reports.map(stockoutNotification);
  // Older ones have been read.
  for (const n of state.notifications.slice(2)) n.read_at = hoursAgo(1);
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

function placeWarehouseOrder(body: Body): Reply {
  // Like the Go API, which refuses unknown fields: the DCFP names no product and no unit.
  if ('unit_of_measure_id' in body || 'condom_id' in body) return fail(400, 'invalid request body');
  const warehouse = text(body.warehouse_store_id);
  const category = text(body.condom_category);
  const quantity = body.quantity;
  if (!warehouse) {
    const message = 'provide the warehouse_store_id UUID';
    return fail(422, message, { warehouse_store_id: message });
  }
  if (category !== 'male' && category !== 'female') {
    const message = 'condom_category must be male or female';
    return fail(422, message, { condom_category: message });
  }
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
    const message = 'quantity must be a positive whole number';
    return fail(422, message, { quantity: message });
  }
  if (!NATIONAL.has(warehouse)) {
    const message = 'warehouse_store_id must name a national warehouse (NMS or JMS)';
    return fail(422, message, { warehouse_store_id: message });
  }
  const created = order(
    (state.next += 1),
    {
      order_status: 'queued',
      condom_id: null,
      condom_category: category,
      quantity_needed: quantity,
      ordered_from_store_id: warehouse,
      comment: text(body.comment) || null,
    },
    0,
  );
  created.updated_at = created.created_at;
  state.orders.unshift(created);
  state.events.push(...historyOf(created));
  return ok(created, 201);
}

const conflict = () => fail(409, 'action is unavailable in the current order state');
const approvedOf = (o: Order) => o.quantity_approved ?? o.quantity_needed;

function step(o: Order, action: string, status: Status, actor = WAREHOUSE_STAFF): void {
  o.order_status = status;
  o.updated_at = new Date().toISOString();
  state.events.push({
    id: `${o.id}-e${String(state.events.length)}`,
    order_id: o.id,
    actor_id: actor,
    action,
    status,
    created_at: o.updated_at,
  });
}

/** Like the Go API: approve a queued or held order for a product of its category, all or part. */
function review(o: Order, body: Body): Reply {
  if (o.order_status !== 'queued' && o.order_status !== 'on_hold') return conflict();
  const asked = body.quantity_approved;
  const quantity = asked === undefined ? o.quantity_needed : asked;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
    return fail(422, 'action requires valid shipment or receipt details');
  }
  if (quantity > o.quantity_needed)
    return fail(422, 'action requires valid shipment or receipt details');
  const chosen = text(body.condom_id) || o.condom_id;
  if (!chosen) {
    const message = 'choose the product to send: give condom_id at review';
    return fail(422, message, { condom_id: message });
  }
  if (!PRODUCTS[chosen] || categoryOf(chosen) !== o.condom_category) {
    const message = 'the product chosen is not of the condom category requested';
    return fail(422, message, { condom_id: message });
  }
  // The order is counted in the chosen product's catalogue unit.
  const unit = PRODUCTS[chosen].unit;
  if (!unit) {
    const message =
      'the product chosen has no unit in the catalogue; give it one before sending it';
    return fail(422, message, { condom_id: message });
  }
  o.condom_id = chosen;
  o.unit_of_measure_id = unit;
  o.quantity_approved = quantity;
  step(o, 'review', 'reviewed');
  return ok(o);
}

/** Reserves the approved quantity when enough unexpired stock is free, else holds the order. */
function checkStock(o: Order): Reply {
  if (
    (o.order_status !== 'reviewed' && o.order_status !== 'on_hold') ||
    !o.condom_id ||
    !o.unit_of_measure_id
  ) {
    return conflict();
  }
  const approved = approvedOf(o);
  if (reservableFor(o.ordered_from_store_id, o.condom_id, o.unit_of_measure_id) >= approved) {
    reserve(o.ordered_from_store_id, o.condom_id, o.unit_of_measure_id, approved);
    step(o, 'check-stock', 'confirmed');
  } else {
    step(o, 'check-stock', 'on_hold');
  }
  return ok(o);
}

function reject(o: Order, body: Body): Reply {
  if (!['queued', 'reviewed', 'on_hold', 'confirmed'].includes(o.order_status)) return conflict();
  const reason = text(body.reason);
  if (!reason) {
    return fail(422, 'say why the order is rejected', { reason: 'say why the order is rejected' });
  }
  if (o.order_status === 'confirmed' && o.condom_id && o.unit_of_measure_id) {
    reserve(o.ordered_from_store_id, o.condom_id, o.unit_of_measure_id, -approvedOf(o));
  }
  o.rejection_reason = reason;
  step(o, 'reject', 'rejected');
  return ok(o);
}

/** Like the Go API: dispatch what is reserved, or less, first expiry first out. */
function dispatch(o: Order, body: Body): Reply {
  if (o.order_status !== 'confirmed' || !o.condom_id || !o.unit_of_measure_id) return conflict();
  const approved = approvedOf(o);
  const asked = body.quantity_issued;
  const quantity = asked === undefined ? approved : asked;
  if (
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > approved
  ) {
    return fail(422, 'action requires valid shipment or receipt details');
  }
  const plan = planTake(o.ordered_from_store_id, o.condom_id, o.unit_of_measure_id, quantity);
  if (!plan) return fail(409, 'not enough unexpired stock: expired batches cannot be issued');
  const reason = text(body.expiry_exception_reason);
  if (plan.nearExpiry && !reason) {
    const message = 'stock expiring within one month needs expiry_exception_reason';
    return fail(422, message, { expiry_exception_reason: message });
  }
  reserve(o.ordered_from_store_id, o.condom_id, o.unit_of_measure_id, -approved);
  state.shipments.set(o.id, take(plan.takes));
  log(o.ordered_from_store_id, o.condom_id, o.unit_of_measure_id, 'dispatch', -quantity, {
    orderId: o.id,
  });
  Object.assign(o, {
    quantity_issued: quantity,
    handled_by_id: WAREHOUSE_STAFF,
    waybill_number: text(body.waybill_number) || null,
    vehicle_registration: text(body.vehicle_registration) || null,
    driver_name: text(body.driver_name) || null,
    driver_phone: text(body.driver_phone) || null,
  });
  step(o, 'dispatch', 'dispatched');
  return ok(o);
}

const DISPATCH_FIELDS = new Set([
  'warehouse_store_id',
  'district_store_id',
  'lines',
  'note',
  'expiry_exception_reason',
  'waybill_number',
  'vehicle_registration',
  'driver_name',
  'driver_phone',
]);

/**
 * Like the Go API: free stock (unexpired, unreserved) goes to a district store before it orders,
 * first expiry first out, as one dispatched order per line. Every line is checked before any
 * stock moves, so the lines go together or not at all.
 */
function districtDispatch(body: Body): Reply {
  if (Object.keys(body).some((key) => !DISPATCH_FIELDS.has(key))) {
    return fail(400, 'invalid request body');
  }
  const warehouse = text(body.warehouse_store_id);
  const district = text(body.district_store_id);
  if (!NATIONAL.has(warehouse)) {
    const message = 'warehouse_store_id must name a national warehouse (NMS or JMS)';
    return fail(422, message, { warehouse_store_id: message });
  }
  if (!MOCK_STORES.some((store) => store.id === district && store.store_type === 'district')) {
    const message = 'district_store_id must name a district store';
    return fail(422, message, { district_store_id: message });
  }
  const lines = Array.isArray(body.lines) ? (body.lines as Body[]) : [];
  if (lines.length < 1 || lines.length > 20) {
    const message = 'a dispatch needs between 1 and 20 lines';
    return fail(422, message, { lines: message });
  }
  const reason = text(body.expiry_exception_reason);
  const planned = [];
  for (const [index, line] of lines.entries()) {
    const at = `line ${String(index + 1)}: `;
    const product = text(line.condom_id);
    const quantity = line.quantity;
    const first = lines.findIndex((other) => text(other.condom_id) === product);
    if (first < index) {
      return fail(
        422,
        `${at}the product is already on line ${String(first + 1)}; put its whole quantity on one line`,
      );
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      return fail(422, `${at}quantity must be a whole number from 1 to 10000000`);
    }
    const unit = PRODUCTS[product]?.unit;
    if (!PRODUCTS[product]) return fail(422, `${at}condom_id does not name a product`);
    if (!unit) {
      return fail(
        422,
        `${at}the product chosen has no unit in the catalogue; give it one before sending it`,
      );
    }
    if (reservableFor(warehouse, product, unit) < quantity) {
      return fail(
        409,
        `${at}not enough free stock: on hand less reserved and expired stock does not cover it`,
      );
    }
    const plan = planTake(warehouse, product, unit, quantity);
    if (!plan)
      return fail(409, `${at}not enough unexpired stock: expired batches cannot be issued`);
    if (plan.nearExpiry && !reason) {
      const message = `${at}stock expiring within one month needs expiry_exception_reason`;
      return fail(422, message, { expiry_exception_reason: message });
    }
    planned.push({ product, unit, quantity, plan });
  }
  const created = planned.map(({ product, unit, quantity, plan }) => {
    const sent = order(
      (state.next += 1),
      {
        order_status: 'dispatched',
        condom_id: product,
        condom_category: categoryOf(product),
        unit_of_measure_id: unit,
        quantity_needed: quantity,
        quantity_approved: quantity,
        quantity_issued: quantity,
        ordered_by_id: WAREHOUSE_STAFF,
        handled_by_id: WAREHOUSE_STAFF,
        ordered_for_store_id: district,
        ordered_from_store_id: warehouse,
        comment: text(body.note) || null,
        waybill_number: text(body.waybill_number) || null,
        vehicle_registration: text(body.vehicle_registration) || null,
        driver_name: text(body.driver_name) || null,
        driver_phone: text(body.driver_phone) || null,
        unrequested: true,
      },
      0,
    );
    sent.updated_at = sent.created_at;
    state.shipments.set(sent.id, take(plan.takes));
    log(warehouse, product, unit, 'dispatch', -quantity, { orderId: sent.id });
    state.orders.unshift(sent);
    state.events.push({
      id: `${sent.id}-e${String(state.events.length)}`,
      order_id: sent.id,
      actor_id: WAREHOUSE_STAFF,
      action: 'dispatch',
      status: 'dispatched',
      created_at: sent.created_at,
    });
    return sent;
  });
  return ok(created, 201);
}

/** The district's batches are the ones shipped: a shortfall comes off the last of them. */
function receiveIntoBatches(o: Order, counted: number): void {
  if (!o.condom_id || !o.unit_of_measure_id || counted <= 0) return;
  let left = counted;
  for (const shipped of state.shipments.get(o.id) ?? []) {
    const quantity = Math.min(left, shipped.quantity);
    if (quantity > 0) {
      addTo(
        o.ordered_for_store_id,
        o.condom_id,
        o.unit_of_measure_id,
        shipped.batch_number,
        shipped.expiry_date,
        quantity,
      );
    }
    left -= quantity;
  }
  // A surplus, or an order seeded as dispatched, goes to a batch of unknown expiry.
  if (left > 0) addTo(o.ordered_for_store_id, o.condom_id, o.unit_of_measure_id, null, null, left);
  log(o.ordered_for_store_id, o.condom_id, o.unit_of_measure_id, 'order_receipt', counted, {
    orderId: o.id,
  });
}

function receive(o: Order, body: Body): Reply {
  if (o.order_status !== 'dispatched') {
    return fail(409, 'action is unavailable in the current order state');
  }
  const counted = body.quantity_received;
  const note = text(body.discrepancy_note);
  if (typeof counted !== 'number' || !Number.isInteger(counted) || counted < 0) {
    return fail(422, 'action requires valid shipment or receipt details');
  }
  if (counted !== o.quantity_issued && !note) {
    return fail(422, 'action requires valid shipment or receipt details');
  }
  receiveIntoBatches(o, counted);
  Object.assign(o, {
    order_status: 'received',
    quantity_received: counted,
    discrepancy_note: note || null,
    updated_at: new Date().toISOString(),
  });
  state.events.push({
    id: `${o.id}-e${state.events.length}`,
    order_id: o.id,
    actor_id: ME,
    action: 'receive',
    status: 'received',
    created_at: o.updated_at,
  });
  return ok(o);
}

function reportStockout(body: Body): Reply {
  const hotSpot = text(body.hot_spot_id);
  const selection = text(body.condom_category);
  if (!hotSpot) return fail(422, "provide the hotspot's UUID");
  if (selection !== 'male' && selection !== 'female' && selection !== 'both') {
    return fail(422, 'condom_category must be male, female or both');
  }
  const created = report(
    (state.next += 1),
    {
      hot_spot_id: hotSpot,
      selection,
      product: selection === 'both' ? 'male and female condoms' : `${selection} condoms`,
      reported_by: 'Sarah Nakato',
      reported_by_id: ME,
      comment: text(body.message) || null,
    },
    0,
  );
  state.reports.unshift(created);
  addReportEvent(created, {
    action: 'raised',
    data: { comment: created.comment },
    created_at: created.created_at,
  });
  state.notifications.unshift(stockoutNotification(created));
  return ok(created, 201);
}

/**
 * `POST /orders/stockouts/:id/deliveries`: the district sends a hotspot stock against its report,
 * each line in the product's catalogue unit, taken from the district store first expiry first.
 * All lines or none; a retried `client_reference` is recorded once.
 */
function deliverToHotspot(r: Report, body: Body): Reply {
  const reference = text(body.client_reference);
  if (reference && state.deliveryRefs.has(reference)) return ok(r, 201);
  if (r.status === 'fulfilled') return fail(409, 'the report is already fulfilled');
  if (r.status === 'rejected') {
    return fail(
      409,
      'this request was rejected; the hotspot reports the stockout again if it still needs stock',
    );
  }
  const lines = Array.isArray(body.lines) ? (body.lines as Body[]) : [];
  if (lines.length === 0 || lines.length > 20) return fail(422, 'send between 1 and 20 lines');
  const reason = text(body.expiry_exception_reason);
  const planned = [];
  for (const line of lines) {
    const condom = text(line.condom_id);
    const unit = text(line.unit_of_measure_id);
    const quantity = Number(line.quantity);
    const facts = mockProductFacts(condom);
    if (!facts?.active || !facts.category || !facts.unit_id || !facts.pieces_per_unit) {
      return fail(422, 'a referenced product does not exist or cannot be sent');
    }
    if (r.selection !== 'both' && facts.category !== r.selection) {
      return fail(422, 'the product is not of a type the hotspot asked for');
    }
    if (unit !== facts.unit_id) return fail(422, "deliver in the product's catalogue unit");
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      return fail(422, 'quantity must be a positive whole number');
    }
    const plan = planTake(r.district_store_id, condom, unit, quantity);
    if (!plan) return fail(409, 'not enough stock in the district store');
    if (plan.nearExpiry && !reason) {
      const message = 'stock expiring within one month needs expiry_exception_reason';
      return fail(422, message, { expiry_exception_reason: message });
    }
    planned.push({
      condom,
      unit,
      quantity,
      category: facts.category,
      perUnit: facts.pieces_per_unit,
      plan,
    });
  }
  const riderId = text(body.rider_id);
  const rider = riderId ? (riders().find((candidate) => candidate.id === riderId) ?? null) : null;
  if (riderId && !rider) {
    const message =
      "the delivery agent must be an active delivery agent working in the hotspot's district";
    return fail(422, message, { rider_id: message });
  }
  const note = text(body.note) || null;
  const deliveries = state.deliveries.get(r.id) ?? [];
  const delivery: HotspotDelivery = {
    id: `${r.id}-d${String(deliveries.length)}`,
    note,
    created_at: new Date().toISOString(),
    rider,
    lines: planned.map((item, index) => {
      for (const taken of item.plan.takes) {
        log(r.district_store_id, item.condom, item.unit, 'hotspot_delivery', -taken.quantity, {
          note,
          batch: taken.batch,
        });
      }
      take(item.plan.takes);
      return {
        id: `${r.id}-d${String(deliveries.length)}-l${String(index)}`,
        product: PRODUCTS[item.condom]?.name ?? 'Condoms',
        category: item.category,
        quantity: item.quantity,
        pieces: item.quantity * item.perUnit,
        acknowledged_pieces: null,
        acknowledged_at: null,
      };
    }),
  };
  state.deliveries.set(r.id, [...deliveries, delivery]);
  if (reference) state.deliveryRefs.add(reference);
  addReportEvent(r, {
    action: 'delivered',
    data: { lines: delivery.lines.map(({ category, pieces }) => ({ category, pieces })) },
    created_at: delivery.created_at,
  });
  r.status = statusOf(r);
  return ok(r, 201);
}

function rejectReport(r: Report, reason: string, hours = 0): void {
  r.rejected_at = hoursAgo(hours);
  r.rejected_by = 'Sarah Nakato';
  r.rejection_reason = reason;
  r.status = statusOf(r);
  addReportEvent(r, { action: 'rejected', data: { reason }, created_at: r.rejected_at });
}

function stockoutDetail(r: Report): Reply {
  return ok({
    ...r,
    deliveries: state.deliveries.get(r.id) ?? [],
    events: state.reportEvents.get(r.id) ?? [],
  });
}

/**
 * `POST /orders/stockouts/:id/rejection`: the district rejects a request it will not supply, with a
 * reason, before any stock has gone. Rejecting it again returns it unchanged.
 */
function rejectStockout(r: Report, body: Body): Reply {
  const reason = text(body.reason);
  if (!reason) {
    return fail(422, 'say why the request is rejected', {
      reason: 'say why the request is rejected',
    });
  }
  if (reason.length > 1000) {
    return fail(422, 'reason must be at most 1000 characters', {
      reason: 'reason must be at most 1000 characters',
    });
  }
  if (r.status === 'rejected') return stockoutDetail(r);
  if (r.status === 'fulfilled') return fail(409, 'this notification is already fulfilled');
  if ((state.deliveries.get(r.id) ?? []).length > 0) {
    return fail(409, 'stock was already sent for this request, so it can no longer be rejected');
  }
  rejectReport(r, reason);
  return stockoutDetail(r);
}

function inbox(method: string, parts: string[], query: URLSearchParams): Reply {
  const [, target, action] = parts;
  if (method === 'GET' && target === undefined) {
    const unread = query.get('unread') === 'true';
    const limit = Math.min(Number(query.get('limit') ?? 50) || 50, 100);
    return ok(state.notifications.filter((n) => !unread || n.read_at === null).slice(0, limit));
  }
  if (method === 'GET' && target === 'unread-count') {
    return ok({ unread: state.notifications.filter((n) => n.read_at === null).length });
  }
  if (method === 'POST' && target === 'read-all') {
    const unread = state.notifications.filter((n) => n.read_at === null);
    for (const n of unread) n.read_at = new Date().toISOString();
    return ok({ marked: unread.length });
  }
  if (method === 'POST' && target && action === 'read') {
    const found = state.notifications.find((n) => n.id === target);
    if (!found) return fail(404, 'notification not found');
    found.read_at ??= new Date().toISOString();
    return ok(null);
  }
  return fail(404, 'Not found');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STOCKOUT_STATUSES = new Set<string>([
  'awaiting_supply',
  'awaiting_acknowledgement',
  'partly_received',
  'fulfilled',
  'rejected',
]);
const ORDER_STATUSES = new Set<string>([
  'pending',
  'fulfilled',
  'queued',
  'reviewed',
  'on_hold',
  'confirmed',
  'rejected',
  'dispatched',
  'received',
  'delivered',
]);

/** The district a store is in, as `GET /locations/stores` gives it; null for a national warehouse. */
const districtOfStore = (storeId: string): string | null =>
  MOCK_STORES.find((store) => store.id === storeId)?.district_id ?? null;

/** The search in `q`, lower-cased ("" for none), or null when longer than the API allows. */
function searchParam(query: URLSearchParams): string | null {
  const search = (query.get('q') ?? '').trim();
  return search.length > 100 ? null : search.toLowerCase();
}

/** Reads a UUID filter, `undefined` when absent and `null` when malformed. */
function uuidParam(query: URLSearchParams, name: string): string | null | undefined {
  const raw = query.get(name);
  if (!raw) return undefined;
  return UUID.test(raw) ? raw : null;
}

/**
 * `GET /orders/stockouts`: as the Go API, filtered by `hot_spot_id`, `district_id` (the hotspot's
 * district) and `status`, each report with its district and the pieces delivered and acknowledged.
 */
function listStockouts(query: URLSearchParams, page: <T>(items: T[]) => T[]): Reply {
  const hotSpot = uuidParam(query, 'hot_spot_id');
  const district = uuidParam(query, 'district_id');
  if (hotSpot === null) return fail(400, 'hot_spot_id must be a UUID');
  if (district === null) return fail(400, 'district_id must be a UUID');
  const statuses = query.get('status')?.split(',') ?? [];
  if (statuses.some((status) => !STOCKOUT_STATUSES.has(status))) {
    return fail(
      400,
      'status must be awaiting_supply, awaiting_acknowledgement, partly_received, fulfilled or rejected, separated by commas',
    );
  }
  const search = searchParam(query);
  if (search === null) return fail(400, 'q must be at most 100 characters');
  const rows = state.reports
    .map((r) => {
      const lines = (state.deliveries.get(r.id) ?? []).flatMap((delivery) => delivery.lines);
      const sum = (category: 'male' | 'female', acknowledged: boolean) =>
        lines
          .filter((line) => line.category === category)
          .reduce(
            (total, line) => total + (acknowledged ? (line.acknowledged_pieces ?? 0) : line.pieces),
            0,
          );
      return {
        ...r,
        district_id: districtOfStore(r.district_store_id),
        delivered_male_pieces: sum('male', false),
        delivered_female_pieces: sum('female', false),
        received_male_pieces: sum('male', true),
        received_female_pieces: sum('female', true),
      };
    })
    .filter(
      (r) =>
        (!hotSpot || r.hot_spot_id === hotSpot) &&
        (!district || r.district_id === district) &&
        (statuses.length === 0 || statuses.includes(r.status)) &&
        (!search ||
          [r.hot_spot.name, r.hot_spot.village, r.hot_spot.subcounty, r.hot_spot.district].some(
            (text) => text?.toLowerCase().includes(search),
          )),
    );
  return ok(page(rows));
}

/**
 * `GET /orders`: as the Go API, filtered by several `status`es separated by commas, `type`
 * (`warehouse_request`: a district's orders to NMS or JMS), `district_id` (the district of the store
 * ordering) and `warehouse_store_id`.
 */
function listOrders(query: URLSearchParams, page: <T>(items: T[]) => T[]): Reply {
  const type = query.get('type');
  if (type && type !== 'warehouse_request') return fail(400, 'type must be warehouse_request');
  const statuses = query.get('status')?.split(',') ?? [];
  if (statuses.some((status) => !ORDER_STATUSES.has(status))) {
    return fail(400, 'status must be order statuses separated by commas, such as queued,reviewed');
  }
  const district = uuidParam(query, 'district_id');
  const warehouse = uuidParam(query, 'warehouse_store_id');
  if (district === null) return fail(400, 'district_id must be a UUID');
  if (warehouse === null) return fail(400, 'warehouse_store_id must be a UUID');
  const search = searchParam(query);
  if (search === null) return fail(400, 'q must be at most 100 characters');
  const storeName = (id: string) =>
    MOCK_STORES.find((store) => store.id === id)?.name.toLowerCase() ?? '';
  const rows = state.orders.filter(
    (order) =>
      (statuses.length === 0 || statuses.includes(order.order_status)) &&
      // The mock holds warehouse orders only: none for a hotspot, pending or fulfilled.
      (!type || NATIONAL.has(order.ordered_from_store_id)) &&
      (!district || districtOfStore(order.ordered_for_store_id) === district) &&
      (!warehouse || order.ordered_from_store_id === warehouse) &&
      (!search || storeName(order.ordered_for_store_id).includes(search)),
  );
  return ok(page(rows).map(withShipment));
}

/** When an order last reached `status`, from its history; null if it never did. */
function reachedAt(orderId: string, status: Status): string | null {
  const times = state.events
    .filter((event) => event.order_id === orderId && event.status === status)
    .map((event) => event.created_at)
    .sort();
  return times.at(-1) ?? null;
}

/** An order as the list and `GET /orders/:id` give it: with when it was dispatched and received. */
const withShipment = (order: Order) => ({
  ...order,
  dispatched_at: reachedAt(order.id, 'dispatched'),
  received_at: reachedAt(order.id, 'received'),
});

type DistributionLine = ReturnType<typeof distributionLines>[number];

/** Every delivery line to a hotspot, newest first, as `GET /orders/hotspot-deliveries` gives them. */
function distributionLines() {
  const storeName = (id: string) => MOCK_STORES.find((store) => store.id === id)?.name ?? '';
  return state.reports
    .flatMap((r) =>
      (state.deliveries.get(r.id) ?? []).flatMap((delivery) =>
        delivery.lines.map((line) => ({
          id: line.id,
          delivery_id: delivery.id,
          stockout_report_id: r.id,
          delivered_at: delivery.created_at,
          hot_spot_id: r.hot_spot_id,
          hot_spot: r.hot_spot.name,
          village: r.hot_spot.village,
          subcounty: r.hot_spot.subcounty,
          district_id: districtOfStore(r.district_store_id),
          district: r.hot_spot.district,
          district_store_id: r.district_store_id,
          district_store: storeName(r.district_store_id),
          category: line.category,
          product: line.product,
          unit: line.quantity === line.pieces ? 'Piece' : 'Box',
          quantity: line.quantity,
          pieces: line.pieces,
          sent_by: 'Grace Nakato',
          rider: delivery.rider?.name ?? null,
          rider_phone: delivery.rider?.phone ?? null,
          acknowledged_pieces: line.acknowledged_pieces,
          acknowledged_at: line.acknowledged_at,
        })),
      ),
    )
    .sort((a, b) => b.delivered_at.localeCompare(a.delivered_at));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The delivery lines `GET /orders/hotspot-deliveries` and its `/summary` cover: filtered by
 * `district_id`, `category`, `from` and `to` (dates, both inclusive) and `q`; or a 400 reply.
 */
function filteredDistributions(query: URLSearchParams): DistributionLine[] | Reply {
  const district = uuidParam(query, 'district_id');
  if (district === null) return fail(400, 'district_id must be a UUID');
  const category = query.get('category');
  if (category && category !== 'male' && category !== 'female') {
    return fail(400, 'category must be male or female');
  }
  const from = query.get('from');
  const to = query.get('to');
  for (const [name, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (value && !DATE.test(value)) return fail(400, `${name} must be a YYYY-MM-DD date`);
  }
  if (from && to && from > to) return fail(400, 'from must not be after to');
  const search = searchParam(query);
  if (search === null) return fail(400, 'q must be at most 100 characters');
  const day = (at: string) => at.slice(0, 10);
  return distributionLines().filter(
    (line) =>
      (!district || line.district_id === district) &&
      (!category || line.category === category) &&
      (!from || day(line.delivered_at) >= from) &&
      (!to || day(line.delivered_at) <= to) &&
      (!search ||
        [line.hot_spot, line.village, line.subcounty, line.district, line.product, line.rider].some(
          (text) => text?.toLowerCase().includes(search),
        )),
  );
}

function distributionSummary(query: URLSearchParams): Reply {
  const lines = filteredDistributions(query);
  if (!Array.isArray(lines)) return lines;
  const sum = (pick: (line: DistributionLine) => number) =>
    lines.reduce((total, line) => total + pick(line), 0);
  return ok({
    deliveries: new Set(lines.map((line) => line.delivery_id)).size,
    hotspots: new Set(lines.map((line) => line.hot_spot_id)).size,
    pieces: sum((line) => line.pieces),
    male_pieces: sum((line) => (line.category === 'male' ? line.pieces : 0)),
    female_pieces: sum((line) => (line.category === 'female' ? line.pieces : 0)),
    acknowledged_pieces: sum((line) => line.acknowledged_pieces ?? 0),
    unacknowledged_lines: lines.filter((line) => line.acknowledged_at === null).length,
  });
}

/** Answers `/orders…` and `/notifications…`, or returns null for any other path. */
export function handleDcfp(
  method: string,
  parts: string[],
  body: Body,
  query: URLSearchParams,
): Reply | null {
  const [resource, target, segment, action] = parts;
  if (resource === 'notifications') return inbox(method, parts, query);
  if (resource !== 'orders') return null;
  // Lists page as the Go API does (limit default 50, at most 100), so clients reading every page stop.
  const page = <T,>(items: T[]): T[] => {
    const limit = Math.min(Math.max(Number(query.get('limit') ?? 50) || 50, 1), 100);
    const offset = Math.max(Number(query.get('offset') ?? 0) || 0, 0);
    return items.slice(offset, offset + limit);
  };
  if (target === undefined)
    return method === 'GET' ? listOrders(query, page) : fail(405, 'Method not allowed');
  if (target === 'stockouts') {
    if (segment === undefined) {
      if (method === 'GET') return listStockouts(query, page);
      if (method === 'POST') return reportStockout(body);
      return fail(405, 'Method not allowed');
    }
    const r = state.reports.find((candidate) => candidate.id === segment);
    if (!r) return fail(404, 'stockout report not found');
    if (method === 'GET' && action === undefined) return stockoutDetail(r);
    if (method === 'POST' && action === 'deliveries') return deliverToHotspot(r, body);
    if (method === 'POST' && action === 'rejection') return rejectStockout(r, body);
    if (method === 'GET' && action === 'riders') return ok(riders());
    return fail(405, 'Method not allowed');
  }
  if (target === 'hotspot-deliveries' && method === 'GET') {
    if (segment === 'summary') return distributionSummary(query);
    if (segment !== undefined) return fail(404, 'not found');
    const lines = filteredDistributions(query);
    return Array.isArray(lines) ? ok(page(lines)) : lines;
  }
  if (target === 'warehouse-requests' && method === 'POST') return placeWarehouseOrder(body);
  if (target === 'district-dispatches' && method === 'POST') return districtDispatch(body);
  const found = state.orders.find((candidate) => candidate.id === target);
  if (!found) return fail(404, 'order not found');
  if (method === 'GET' && segment === undefined) return ok(withShipment(found));
  if (method === 'GET' && segment === 'events') {
    return ok(state.events.filter((event) => event.order_id === found.id).reverse());
  }
  if (method === 'POST' && segment === 'actions') {
    switch (action) {
      case 'review':
        return review(found, body);
      case 'check-stock':
        return checkStock(found);
      case 'reject':
        return reject(found, body);
      case 'dispatch':
        return dispatch(found, body);
      case 'receive':
        return receive(found, body);
    }
    return fail(404, 'unknown order action');
  }
  return fail(404, 'Not found');
}
