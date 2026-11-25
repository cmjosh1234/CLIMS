import {
  ChartColumn,
  ClipboardCheck,
  ClipboardList,
  HeartPulse,
  Inbox,
  Landmark,
  LayoutDashboard,
  MapPin,
  Package,
  ShieldCheck,
  Store,
  Tags,
  Truck,
  Users,
  Warehouse,
} from 'lucide-react';

import type { NavItem, Workspace } from './navigation';
import { HOME_PATH } from './paths';

/*
 * Every signed-in screen, by workspace. This table drives the sidebar, the
 * heading band (title, description, tabs), the loading skeleton
 * and each page's browser title. The screens themselves are the `page.tsx`
 * files under `src/app/(app)`: a page missing from this table fails the
 * build, and a test fails if the table names a path that has no page.
 */

const DESCRIPTIONS = {
  hotspotMap: 'Where hotspots are. Select a marker to see its contact person and status.',
} as const;

function dashboard(path: string, title: string, description: string): NavItem {
  return {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    pages: [{ path, tab: 'Dashboard', title, description, layout: 'dashboard' }],
  };
}

/** A reporter's monthly reports (Phase 8): the list and one report. */
/** Consumption from the Go API: how often hotspots or districts ask for stock, and what reaches them. */
function consumption(path: string, description: string): NavItem {
  return {
    id: 'reports',
    label: 'Reports',
    icon: ClipboardCheck,
    pages: [
      {
        path,
        tab: 'Consumption',
        title: 'Consumption',
        description,
        layout: 'table',
        permission: 'reports:read',
      },
    ],
  };
}

/**
 * Programme reports from the Go API: notification fulfilment, warehouse
 * requests, stock, expiry, HMIS 105 and approved versions, with downloads.
 */
function programmeReports(path: string, description: string): NavItem {
  return {
    id: 'programme-reports',
    label: 'Analytics',
    icon: ChartColumn,
    pages: [
      {
        path,
        tab: 'Analytics',
        title: 'Reports and analytics',
        description,
        layout: 'table',
        permission: 'reports:read',
      },
    ],
  };
}

/**
 * The condom catalogue (products and the types, brands and units they use). It
 * is national master data, so MOH and the warehouse workspace show the same
 * screens; who may change it follows `catalogue:manage`, set per role.
 */
function catalogue(path: string): NavItem {
  return {
    id: 'catalogue',
    label: 'Product catalogue',
    icon: Tags,
    pages: [
      {
        path,
        tab: 'Condoms',
        title: 'Product catalogue',
        description:
          'Condom products, each a brand, category and type in one unit. Orders and stock pick from the active ones.',
        layout: 'table',
      },
      {
        path: `${path}/types`,
        tab: 'Types',
        title: 'Product types',
        description:
          'How condom products reach people, such as free public-sector supply, social marketing or commercial sale.',
        layout: 'table',
      },
      {
        path: `${path}/brands`,
        tab: 'Brands',
        title: 'Brands',
        description: 'Brands condom products are distributed or sold under.',
        layout: 'table',
      },
      {
        path: `${path}/units`,
        tab: 'Units of measure',
        title: 'Units of measure',
        description:
          'Units condoms are packed and counted in. Each product says how many condoms its unit holds.',
        layout: 'table',
      },
    ],
  };
}

export const workspaces: readonly Workspace[] = [
  {
    id: 'moh',
    label: 'Ministry of Health',
    icon: Landmark,
    basePath: HOME_PATH,
    sections: [
      {
        label: 'Overview',
        // MOH's home is Analytics: what needs watching and the national overview, then every
        // report as a tab. It replaced a separate dashboard that showed the same overview.
        items: [
          programmeReports(
            HOME_PATH,
            'National analytics: stockout requests, warehouse orders, stock, expiry, hotspot coverage and HMIS 105, with filters, PDF, CSV and Excel downloads and approved versions.',
          ),
        ],
      },
      {
        label: 'Oversight',
        items: [
          {
            id: 'orders',
            label: 'Orders',
            icon: ClipboardList,
            pages: [
              {
                path: '/moh/orders',
                tab: 'Hotspot requests',
                title: 'Orders',
                description:
                  'Every hotspot stockout request in the country, and how its district answered it. Read-only.',
                layout: 'table',
                permission: 'orders:read',
              },
              {
                path: '/moh/orders/warehouse',
                tab: 'District orders',
                title: 'Orders',
                description:
                  'District store orders to NMS and JMS, from request to receipt. Read-only.',
                layout: 'table',
                permission: 'orders:read',
              },
            ],
            details: [
              { path: '/moh/orders/[id]', label: 'Hotspot request', layout: 'stockout' },
              { path: '/moh/orders/warehouse/[id]', label: 'District order', layout: 'detail' },
            ],
          },
          consumption(
            '/moh/reports',
            'How often hotspots and districts ask for stock, and what reaches them, by hotspot, district and warehouse.',
          ),
          // Where stock went: district stores to hotspots, and NMS and JMS to district stores.
          {
            id: 'distribution',
            label: 'Distribution',
            icon: Truck,
            pages: [
              {
                path: '/moh/distribution',
                tab: 'To hotspots',
                title: 'Condom distribution',
                description:
                  'Condoms district stores delivered to hotspots, by product, place and who carried them, and what each hotspot confirmed receiving. Read-only.',
                layout: 'table',
                permission: 'orders:read',
              },
              {
                path: '/moh/distribution/warehouses',
                tab: 'From NMS and JMS',
                title: 'Condom distribution',
                description:
                  'Stock NMS and JMS sent to district stores, on the way or received, including stock sent before a district ordered. Read-only.',
                layout: 'table',
                permission: 'orders:read',
              },
            ],
          },
          {
            id: 'hotspots',
            label: 'Hotspots',
            icon: MapPin,
            pages: [
              {
                path: '/moh/hotspots',
                tab: 'List',
                title: 'Hotspots',
                description:
                  'Every hotspot in the country, or in the district you choose, with its review status and manager.',
                layout: 'table',
                permission: 'hotspots:read',
              },
              {
                path: '/moh/hotspot-map',
                tab: 'Map',
                title: 'Hotspot map',
                description: DESCRIPTIONS.hotspotMap,
                layout: 'dashboard',
              },
            ],
            details: [{ path: '/moh/hotspots/[id]', label: 'Hotspot', layout: 'detail' }],
          },
        ],
      },
      {
        label: 'Administration',
        items: [
          {
            id: 'users',
            label: 'Users & access',
            icon: Users,
            pages: [
              {
                path: '/moh/users',
                tab: 'Users',
                title: 'User management',
                description: 'Everyone who can sign in to CLIMS, and the roles they hold.',
                layout: 'table',
                permission: 'users:read',
              },
              {
                path: '/moh/users/roles',
                tab: 'Roles & permissions',
                title: 'Roles & permissions',
                description: 'What each role can see and do. A user can hold more than one role.',
                layout: 'detail',
                permission: 'roles:read',
              },
            ],
          },
          catalogue('/moh/catalogue'),
          {
            id: 'locations',
            label: 'Stores & locations',
            icon: Store,
            pages: [
              {
                path: '/moh/stores',
                tab: 'Stores',
                title: 'Stores',
                description: 'Stock-holding points: national warehouses and district stores.',
                layout: 'table',
              },
              {
                path: '/moh/stores/geography',
                tab: 'Geography',
                title: 'Geography',
                description: 'Regions, districts, sub-counties and facilities, synced from DHIS2.',
                layout: 'detail',
              },
            ],
          },
          {
            id: 'audit',
            label: 'Audit',
            icon: ShieldCheck,
            pages: [
              {
                path: '/moh/audit',
                tab: 'Audit log',
                title: 'Audit log',
                description:
                  'Sign-ins, account changes and every change to records: who, what, when and from where.',
                layout: 'table',
                permission: 'audit:read',
              },
              {
                path: '/moh/audit/sync-log',
                tab: 'Sync log',
                title: 'Sync log',
                description:
                  'What field phones report about sending the actions their users saved, online or offline.',
                layout: 'table',
                permission: 'sync_logs:read',
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'dcfp',
    label: 'District focal person',
    icon: HeartPulse,
    basePath: '/dcfp',
    sections: [
      {
        label: 'Overview',
        items: [
          dashboard(
            '/dcfp',
            'District dashboard',
            'What needs your attention in the district today, in the order it needs doing.',
          ),
        ],
      },
      {
        label: 'Fulfilment',
        items: [
          {
            id: 'stockouts',
            label: 'Stockouts',
            icon: Inbox,
            pages: [
              {
                path: '/dcfp/stockouts',
                tab: 'Stockouts',
                title: 'Stockout notifications',
                description:
                  'Hotspots that have run out. Open one to send stock from your district store or reject it with a reason, and order more from NMS or JMS.',
                layout: 'table',
              },
            ],
            details: [
              { path: '/dcfp/stockouts/[id]', label: 'Stockout request', layout: 'stockout' },
            ],
          },
          {
            id: 'restock',
            label: 'Restock',
            icon: Warehouse,
            pages: [
              {
                path: '/dcfp/restock',
                tab: 'Warehouse orders',
                title: 'Restock',
                description:
                  'Condoms ordered from NMS or JMS, and consignments waiting to be received.',
                layout: 'table',
              },
              {
                path: '/dcfp/restock/store',
                tab: 'District store',
                title: 'Restock',
                description:
                  'Condoms in the district store, by batch, and every movement in and out.',
                layout: 'table',
              },
            ],
            // `new` is listed before `[id]`: a fixed segment wins, as it does in the router.
            details: [
              { path: '/dcfp/restock/new', label: 'New warehouse order', layout: 'form' },
              { path: '/dcfp/restock/[id]', label: 'Warehouse order', layout: 'detail' },
            ],
          },
        ],
      },
      {
        label: 'Network',
        items: [
          {
            id: 'hotspots',
            label: 'Hotspots',
            icon: MapPin,
            pages: [
              {
                path: '/dcfp/hotspots',
                tab: 'List',
                title: 'Hotspots',
                description:
                  'Hotspots in your district. Review the ones VHTs submit, then activate or reject each with a comment.',
                layout: 'table',
                permission: 'hotspots:read',
              },
              {
                path: '/dcfp/hotspot-map',
                tab: 'Map',
                title: 'Hotspot map',
                description: DESCRIPTIONS.hotspotMap,
                layout: 'dashboard',
                permission: 'hotspots:read',
              },
            ],
            details: [{ path: '/dcfp/hotspots/[id]', label: 'Hotspot', layout: 'detail' }],
          },
          {
            id: 'field-users',
            label: 'Field users',
            icon: Users,
            pages: [
              {
                path: '/dcfp/users',
                tab: 'Field users',
                title: 'Field users',
                description:
                  'VHTs, hotspot managers and delivery agents who work in your district, and where each one works.',
                layout: 'table',
                permission: 'users:district_read',
              },
            ],
          },
        ],
      },
      {
        label: 'Reporting',
        items: [
          consumption(
            '/dcfp/reports',
            "How often your district's hotspots ask for stock, and what you deliver and they confirm.",
          ),
          programmeReports(
            '/dcfp/programme-reports',
            "Your district's analytics: stockout requests, warehouse orders, stock, expiry, hotspot coverage and HMIS 105, with filters and PDF, CSV and Excel downloads.",
          ),
        ],
      },
    ],
  },
  {
    // NMS and JMS are stores this one workspace switches between (`?store=`), not role areas.
    id: 'warehouse',
    label: 'Warehouse',
    icon: Warehouse,
    basePath: '/warehouse',
    sections: [
      {
        label: 'Overview',
        items: [
          dashboard(
            '/warehouse',
            'Warehouse dashboard',
            'District orders waiting on this warehouse, and batches to dispatch first or write off.',
          ),
        ],
      },
      {
        label: 'Fulfilment',
        items: [
          {
            id: 'requests',
            label: 'District requests',
            icon: Inbox,
            pages: [
              {
                path: '/warehouse/requests',
                tab: 'Requests',
                title: 'District requests',
                description:
                  'Stock orders from district stores. Approve or reject each one, then dispatch it.',
                layout: 'table',
              },
            ],
            details: [
              { path: '/warehouse/requests/[id]', label: 'District request', layout: 'detail' },
            ],
          },
        ],
      },
      {
        label: 'Inventory',
        items: [
          {
            id: 'stock',
            label: 'Stock',
            icon: Package,
            pages: [
              {
                path: '/warehouse/stock',
                tab: 'Stock',
                title: 'Warehouse stock',
                description:
                  'What the warehouse holds, what went out and what is waiting; register stock, or dispatch it to a district before it orders.',
                layout: 'table',
              },
            ],
          },
          catalogue('/warehouse/catalogue'),
        ],
      },
      {
        label: 'Reporting',
        items: [
          consumption(
            '/warehouse/reports',
            'How often districts order from the warehouse, and what is issued and received.',
          ),
          programmeReports(
            '/warehouse/programme-reports',
            "The warehouse's analytics: district orders, stock flow and coverage, and expiry risk, with filters and PDF, CSV and Excel downloads.",
          ),
        ],
      },
    ],
  },
  // VHTs, hotspot managers and delivery agents have no workspace: they use the mobile app only.
];
