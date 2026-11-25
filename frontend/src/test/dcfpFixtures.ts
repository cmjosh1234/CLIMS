import type { Order, StockoutReport, Warehouse } from '@/features/dcfp/api';
import type { Lookup, Product } from '@/features/catalogue/api';

import type { FakeReply } from './fakeAdapter';

/* Go API shapes for the DCFP screens: stockout reports, warehouse orders and their lookups. */

const envelope = (data: unknown) => ({ success: true, data });

export const NMS: Warehouse = {
  id: 'w-nms',
  code: 'nms',
  name: 'National Medical Stores',
  store_type: 'national',
};
export const JMS: Warehouse = {
  id: 'w-jms',
  code: 'jms',
  name: 'Joint Medical Store',
  store_type: 'national',
};
export const DISTRICT_STORE = 'store-kampala';

const stamp = '2026-11-01T08:00:00Z';

export const FEMALE: Product = {
  id: 'p-female',
  category: 'female',
  type: { id: 't-free', name: 'Free' },
  brand: { id: 'b1', name: 'Engabu' },
  unit: { id: 'u-box', name: 'box' },
  pieces_per_unit: 100,
  active: true,
  in_use: true,
  created_at: stamp,
  updated_at: stamp,
};

/** A legacy product with no unit, so an order for it has to name one. */
export const UNITLESS: Product = {
  ...FEMALE,
  id: 'p-unitless',
  category: 'male',
  brand: { id: 'b2', name: 'Lifeguard' },
  unit: null,
};

export const BOX: Lookup = {
  id: 'u-box',
  name: 'box',
  note: null,
  active: true,
  in_use: true,
  product_count: 1,
  created_at: stamp,
  updated_at: stamp,
};

export function aReport(overrides: Partial<StockoutReport> = {}): StockoutReport {
  return {
    id: 'r1',
    hot_spot_id: 'h1',
    hot_spot: {
      name: 'Kisenyi Landing',
      village: 'Kisenyi',
      subcounty: 'Central',
      district: 'Kampala',
      contact_name: 'Peter Okello',
      contact_phone: '0700123456',
    },
    condom_id: null,
    selection: 'female',
    product: 'female condoms',
    district_store_id: DISTRICT_STORE,
    reported_by_id: 'u-vht',
    reported_by: 'Grace Nakato',
    comment: 'Dispenser empty since Monday',
    created_at: '2026-11-21T07:00:00Z',
    ...overrides,
  };
}

export function anOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    condom_id: FEMALE.id,
    condom_category: 'female',
    quantity_needed: 500,
    quantity_approved: null,
    quantity_issued: null,
    quantity_received: null,
    order_status: 'queued',
    order_date: '2026-11-21',
    ordered_by_id: 'u-dcfp',
    ordered_for_store_id: DISTRICT_STORE,
    ordered_from_store_id: NMS.id,
    unit_of_measure_id: BOX.id,
    comment: null,
    discrepancy_note: null,
    rejection_reason: null,
    waybill_number: null,
    vehicle_registration: null,
    driver_name: null,
    driver_phone: null,
    unrequested: false,
    hot_spot_id: null,
    created_at: '2026-11-21T08:00:00Z',
    updated_at: '2026-11-21T08:00:00Z',
    dispatched_at: null,
    received_at: null,
    ...overrides,
  };
}

interface DcfpData {
  reports?: StockoutReport[];
  orders?: Order[];
  products?: Product[];
}

type Answer = Exclude<FakeReply, (...args: never[]) => unknown>;

/**
 * Answers the DCFP screens' requests by path. Writes default to an empty success; pass
 * `writes` keyed by "METHOD /path" to script them.
 */
export function dcfpApi(data: DcfpData = {}, writes: Record<string, Answer> = {}) {
  return (request: { method: string; url: string }): Answer => {
    const [path = ''] = request.url.split('?');
    if (request.method !== 'GET') {
      return writes[`${request.method} ${path}`] ?? { status: 200, body: envelope(anOrder()) };
    }
    const orders = data.orders ?? [];
    const order = /^\/orders\/([^/]+)/.exec(path);
    if (path === '/orders/stockouts') return { status: 200, body: envelope(data.reports ?? []) };
    if (path === '/orders') return { status: 200, body: envelope(orders) };
    if (order && path.endsWith('/events')) return { status: 200, body: envelope([]) };
    if (order) {
      const found = orders.find((candidate) => candidate.id === order[1]);
      return found
        ? { status: 200, body: envelope(found) }
        : { status: 404, body: { success: false, message: 'order not found' } };
    }
    if (path === '/locations/stores') return { status: 200, body: envelope([NMS, JMS]) };
    if (path === '/catalogue/products') {
      return { status: 200, body: envelope(data.products ?? [FEMALE, UNITLESS]) };
    }
    if (path === '/catalogue/units') return { status: 200, body: envelope([BOX]) };
    return { status: 200, body: envelope([]) };
  };
}
