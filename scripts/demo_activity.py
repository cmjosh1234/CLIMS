#!/usr/bin/env python3
"""Generate about a year of demo stock activity for the reports and analytics screens.

Reads the reference document printed by scripts/demo_activity_refs.sql and prints SQL that adds, in
one transaction, a simulated year of the programme as the app itself would have recorded it:

* NMS and JMS receive consignments into batches with expiry dates;
* district stores order from them, and each order is reviewed, stock-checked (reserved or put on
  hold), dispatched first-expiry-first-out with transport details, and received, sometimes short;
* hotspot managers raise stockout requests (with repeats), DCFPs deliver from district batches or
  reject, and managers acknowledge what arrived;
* quarterly stock counts adjust balances, and phones report their sync log.

Stock never goes negative, every balance equals its ledger and its batches, and the newest steps
are left open (queued, on hold, in transit, awaiting acknowledgement). Every row written has an id
starting with ``de300000-``, which is how scripts/demo_activity_remove.sql removes them again.

    python3 scripts/demo_activity.py refs.json [--seed N] [--months N] > demo.sql
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import random
import string
import sys
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta, timezone

PREFIX = 0xDE300000
EAT = timezone(timedelta(hours=3), "EAT")
RULE_VERSION = "reporting-requirements-0.2-draft"

SEASON = {
    1: 1.05,
    2: 0.85,
    3: 0.95,
    4: 1.15,
    5: 0.95,
    6: 1.0,
    7: 1.05,
    8: 1.15,
    9: 0.95,
    10: 1.0,
    11: 1.1,
    12: 1.35,
}

RAISE_COMMENTS = [
    "Dispenser empty since this morning.",
    "Male dispenser empty after the weekend.",
    "Out of female condoms, clients are asking.",
    "Both dispensers empty.",
    "Busy weekend coming, please bring more.",
    "Only a few pieces left in the last box.",
    "Refilled the dispenser from our last box; nothing left in store.",
    "Clients asking for female condoms every evening.",
    "Football match on Saturday, we expect a crowd.",
]
REPEAT_COMMENTS = [
    "Still waiting, dispenser is empty.",
    "Please deliver, clients are asking.",
    "Reminder: we reported this earlier in the week.",
    None,
]
REJECT_REASONS = [
    "Hotspot is closed for renovation; supply resumes when it reopens.",
    "Duplicate request: this hotspot was supplied two days ago.",
    "Venue no longer operating; flagged for deactivation.",
    "Dispenser was still more than half full at the last visit.",
]
NO_STOCK_REASON = "District store has no stock of this type; the NMS delivery is still pending."
ORDER_COMMENTS = [
    "Stock for the next quarter.",
    "Stock is below two months; please process urgently.",
    "Festive season ahead, hotspots are reporting more often.",
    "Includes stock for hotspots mapped this month.",
    "Regular replenishment.",
]
ORDER_REJECTIONS = [
    "Duplicate of a request already in process for this district.",
    "Quantity is above the district's quarterly allocation; reorder a smaller quantity.",
    "Please order this category from the other warehouse this quarter.",
]
DISCREPANCIES = [
    "Two cartons water-damaged in transit.",
    "Short by one carton on count; the waybill shows the full quantity.",
    "Cartons crushed during offloading; damaged pieces set aside.",
]
DRIVERS = [
    "Okello Moses",
    "Ssemakula Ivan",
    "Mugisha Robert",
    "Wasswa Henry",
    "Opio Patrick",
    "Kato Joseph",
    "Tumusiime Allan",
    "Byaruhanga Peter",
    "Lubega Ronald",
    "Ochieng Denis",
]
FUNDERS = ["UNFPA consignment", "Government of Uganda procurement", "Global Fund consignment"]
SHORT_DATED = "Short-dated batch sent where it will be used within weeks; recipient informed."


def utc_text(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S.%f+00")


def iso_z(t: datetime) -> str:
    return t.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def naive_utc(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")


def eat_day(t: datetime) -> date:
    return t.astimezone(EAT).date()


def add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    year, month = d.year + y, m + 1
    days = [
        31,
        29 if year % 4 == 0 and (year % 100 or year % 400 == 0) else 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ][month - 1]
    return date(year, month, min(d.day, days))


def round_to(value: float, step: int, minimum: int) -> int:
    return max(minimum, int(math.ceil(value / step)) * step)


@dataclass
class Product:
    id: str
    category: str
    unit_id: str
    per_unit: int
    label: str
    commercial: bool

    @property
    def code(self) -> str:
        return "".join(w[0] for w in self.label.split() if w)[:2].upper() or "CD"


@dataclass
class Lot:
    id: str
    number: str | None
    expiry: date | None
    on_hand: int
    created: datetime
    hold: bool = False  # quarantined in the demo: never issued, so expired stock stays visible


@dataclass
class Holding:
    store_id: str
    product: Product
    lots: dict = field(default_factory=dict)
    on_hand: int = 0  # the demo's part of the balance
    reserved: int = 0
    first: datetime | None = None

    def usable(self, today: date) -> int:
        good = sum(
            lot.on_hand
            for lot in self.lots.values()
            if not lot.hold and (lot.expiry is None or lot.expiry >= today)
        )
        return good - self.reserved


@dataclass
class Store:
    id: str
    name: str
    kind: str  # national or district
    staff: list
    code: str = ""
    riders: list = field(default_factory=list)
    hotspots: list = field(default_factory=list)
    holdings: dict = field(default_factory=dict)
    active_hotspots: int = 0
    open_order: dict = field(default_factory=dict)
    issued: list = field(default_factory=list)  # (time, category, units) going out
    response_hours: float = 36.0
    jms_share: float = 0.2
    target: float = 3.5  # months of issues a DCFP orders up to
    last_check: datetime | None = None
    last_order: datetime | None = None
    waiting: list = field(default_factory=list)  # orders on hold at a warehouse
    inbound: dict = field(default_factory=dict)  # product id -> units on the way to a warehouse


@dataclass
class Hotspot:
    id: str
    manager: str
    store: Store
    rate: float
    male: tuple
    female: tuple
    female_bias: float
    open: Report | None = None


@dataclass
class Report:
    id: str
    hotspot: Hotspot
    selection: str
    created: datetime
    comment: str | None
    repeat_count: int = 0
    last_reported: datetime | None = None
    fulfilled: datetime | None = None
    rejected: datetime | None = None
    rejected_by: str | None = None
    reason: str | None = None
    sent: set = field(default_factory=set)  # categories with a delivery not acknowledged as zero
    acked: set = field(default_factory=set)  # categories acknowledged with pieces
    pending: bool = False  # a delivery attempt is scheduled

    def needs(self) -> list:
        cats = ["male", "female"] if self.selection == "both" else [self.selection]
        return [c for c in cats if c not in self.sent]


class Demo:
    def __init__(self, refs: dict, seed: int, months: int, now: datetime):
        self.rng = random.Random(seed)
        self.end = now
        first = now.astimezone(EAT).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        self.start = datetime.combine(add_months(first.date(), -months), datetime.min.time(), EAT)
        self.span = (self.end - self.start).total_seconds()
        self.queue: list = []
        self.seq = 0
        self.rows: dict[str, list] = {name: [] for name, _ in TABLES}
        self.batch_seq = 0
        self.waybill_seq = 0

        self.products = [Product(**p) for p in refs["products"]]
        if not self.products:
            sys.exit("No active product with a category and catalogue unit; nothing to simulate.")
        by_code = {w["code"]: w for w in refs["warehouses"] if w["staff"]}
        if not by_code:
            sys.exit("No national warehouse has staff with orders:process; nothing to simulate.")
        self.warehouses = []
        for code, w in by_code.items():
            store = Store(w["id"], w["name"], "national", w["staff"], code=code)
            self.warehouses.append(store)
        self.nms = by_code.get("nms") and self.find(by_code["nms"]["id"]) or self.warehouses[0]
        self.jms = by_code.get("jms") and self.find(by_code["jms"]["id"]) or self.warehouses[-1]
        self.supplies = {}
        for wh in self.warehouses:
            for cat in ("male", "female"):
                options = [p for p in self.products if p.category == cat]
                if not options:
                    continue
                if cat == "male" and len(options) > 1:
                    want_commercial = wh is self.jms and wh is not self.nms
                    options.sort(key=lambda p: p.commercial != want_commercial)
                self.supplies[(wh.id, cat)] = options[0]

        self.districts = []
        self.hotspots = []
        for d in refs["districts"]:
            if not d["hotspots"] and d["active_hotspots"] == 0:
                continue
            store = Store(
                d["id"],
                d["name"],
                "district",
                d["dcfps"],
                riders=d["riders"],
                active_hotspots=d["active_hotspots"],
            )
            store.response_hours = (
                self.rng.uniform(18, 30)
                if len(d["hotspots"]) > 50
                else (
                    self.rng.uniform(30, 60)
                    if len(d["hotspots"]) > 10
                    else self.rng.uniform(36, 96)
                )
            )
            store.jms_share = self.rng.choice([0.1, 0.15, 0.25, 0.35])
            store.target = self.rng.uniform(3.0, 4.2)
            for h in d["hotspots"]:
                size = self.rng.choices(["small", "medium", "large"], [0.45, 0.4, 0.15])[0]
                male = {"small": (2, 4), "medium": (5, 10), "large": (12, 20)}[size]
                female = {"small": (2, 4), "medium": (4, 8), "large": (8, 15)}[size]
                spot = Hotspot(
                    h["id"],
                    h["manager"],
                    store,
                    self.rng.lognormvariate(0, 0.45),
                    male,
                    female,
                    self.rng.uniform(0.6, 1.6),
                )
                store.hotspots.append(spot)
                self.hotspots.append(spot)
            self.districts.append(store)
        if not self.districts:
            sys.exit("No district store with a DCFP is free for demo data; nothing to simulate.")

    # ---- plumbing -------------------------------------------------------------------------

    def find(self, store_id: str) -> Store:
        return next(w for w in self.warehouses if w.id == store_id)

    def new_id(self) -> str:
        value = (PREFIX << 96) | self.rng.getrandbits(96)
        value = (value & ~(0xF << 76)) | (0x4 << 76)
        value = (value & ~(0x3 << 62)) | (0x2 << 62)
        return str(uuid.UUID(int=value))

    def at(self, when: datetime, fn, *args) -> None:
        if when < self.end:
            heapq.heappush(self.queue, (when, self.seq, fn, args))
            self.seq += 1

    def frac(self, t: datetime) -> float:
        return min(max((t - self.start).total_seconds() / self.span, 0.0), 1.0)

    def working(self, t: datetime) -> datetime:
        """The first working moment at or after t (EAT, Mon-Fri 8-17:30, Sat 8-13)."""
        local = t.astimezone(EAT)
        for _ in range(10):
            close = 13 if local.weekday() == 5 else 17.5
            hour = local.hour + local.minute / 60
            if local.weekday() < 6 and 8 <= hour < close:
                return local
            if local.weekday() < 6 and hour < 8:
                local = local.replace(hour=8, minute=0) + timedelta(
                    minutes=self.rng.randint(0, 150)
                )
                return local
            local = (local + timedelta(days=1)).replace(hour=8, minute=0)
            local += timedelta(minutes=self.rng.randint(0, 150))
            if local.weekday() < 6:
                return local
        return local

    def holding(self, store: Store, product: Product) -> Holding:
        h = store.holdings.get(product.id)
        if h is None:
            h = store.holdings[product.id] = Holding(store.id, product)
        return h

    def batch_number(self, product: Product, received: date) -> str:
        self.batch_seq += 1
        return f"{product.code}{received:%y%m}-{self.rng.randint(100, 999)}{self.batch_seq % 10}"

    def move(
        self,
        store: Store,
        product: Product,
        reason: str,
        units: int,
        when: datetime,
        actor: str,
        order: str | None = None,
        delivery: str | None = None,
        lot: Lot | None = None,
        note: str | None = None,
    ) -> None:
        h = self.holding(store, product)
        h.on_hand += units
        h.first = h.first or when
        assert h.on_hand >= 0, (store.name, product.label, reason)
        self.rows["inventory_movements"].append(
            (
                self.new_id(),
                store.id,
                product.id,
                product.unit_id,
                reason,
                units,
                h.on_hand,
                order,
                actor,
                note,
                utc_text(when),
                delivery,
                lot.id if lot else None,
            )
        )

    def add_lot(
        self,
        store: Store,
        product: Product,
        number: str | None,
        expiry: date | None,
        units: int,
        when: datetime,
        hold: bool = False,
    ) -> Lot:
        h = self.holding(store, product)
        key = (number, expiry)
        lot = h.lots.get(key)
        if lot is None:
            lot = h.lots[key] = Lot(self.new_id(), number, expiry, 0, when, hold)
        lot.on_hand += units
        return lot

    def take(self, store: Store, product: Product, units: int, when: datetime):
        """First expiry first out, unknown expiry last, expired and held batches never."""
        today = eat_day(when)
        h = self.holding(store, product)
        lots = sorted(
            (
                lot
                for lot in h.lots.values()
                if lot.on_hand > 0 and not lot.hold and (lot.expiry is None or lot.expiry >= today)
            ),
            key=lambda lot: (lot.expiry is None, lot.expiry or date.max, lot.created),
        )
        if sum(lot.on_hand for lot in lots) < units:
            return None
        taken, left = [], units
        for lot in lots:
            if left == 0:
                break
            q = min(left, lot.on_hand)
            lot.on_hand -= q
            left -= q
            days = (lot.expiry - today).days if lot.expiry else None
            near = lot.expiry is not None and lot.expiry < add_months(today, 1)
            taken.append((lot, q, days, near))
        return taken

    def ship(
        self,
        taken,
        when: datetime,
        actor: str,
        order: str | None = None,
        line: str | None = None,
        delivery: str | None = None,
    ) -> None:
        for lot, q, days, near in taken:
            self.rows["shipment_batches"].append(
                (self.new_id(), order, line, lot.number, lot.expiry, q, days, utc_text(when))
            )
            if near:
                self.rows["expiry_exceptions"].append(
                    (
                        self.new_id(),
                        lot.id,
                        order,
                        delivery,
                        actor,
                        SHORT_DATED,
                        q,
                        lot.expiry,
                        days,
                        RULE_VERSION,
                        utc_text(when),
                    )
                )

    def sync(self, user: str, action: str, when: datetime, record: str) -> None:
        """A phone's sync log entry for an action it sent; only the last two months are kept."""
        if when < self.end - timedelta(days=60):
            return
        rng = self.rng
        offline = timedelta(minutes=rng.randint(0, 20))
        if rng.random() < 0.1:
            offline = timedelta(hours=rng.uniform(1, 30))
        queued = when - offline
        status, error, http = "sent", None, 201
        if rng.random() < 0.02:
            status, http = "refused", 409
            error = rng.choice(
                [
                    "The hotspot already has an open request.",
                    "This delivery was already acknowledged.",
                ]
            )
        elif when > self.end - timedelta(days=2) and rng.random() < 0.08:
            status, http, error = rng.choice(["waiting", "retrying"]), None, "Network unavailable"
        attempts = []
        if offline > timedelta(hours=1):
            attempts.append(
                {
                    "at": iso_z(queued + offline / 2),
                    "http_status": None,
                    "error": "Network unavailable",
                }
            )
        if status not in ("waiting",):
            attempts.append(
                {
                    "at": iso_z(when),
                    "http_status": http,
                    "error": error if status != "sent" else None,
                }
            )
        changed = when if status in ("sent", "refused") else queued
        entry = "".join(rng.choices(string.ascii_letters + string.digits + "_-", k=21))
        version = "2.4.0" if when > self.end - timedelta(days=12) else "2.3.0"
        ios = rng.random() < 0.08
        self.rows["mobile_sync_log"].append(
            (
                self.new_id(),
                user,
                None,
                entry,
                action,
                status,
                record if status == "sent" else None,
                utc_text(queued),
                utc_text(changed),
                len(attempts),
                json.dumps(attempts),
                error,
                "ios" if ios else "android",
                rng.choice(["17.6", "18.1"]) if ios else rng.choice(["12", "13", "14"]),
                version,
                utc_text(max(changed, queued)),
            )
        )

    # ---- warehouses ------------------------------------------------------------------------

    def open_warehouses(self) -> None:
        t = self.start + timedelta(hours=9)
        today = eat_day(t)
        plan = {
            (self.nms.id, "male"): [(900_000, 16), (1_200_000, 30)],
            (self.nms.id, "female"): [(60_000, 13), (90_000, 28)],
            (self.jms.id, "male"): [(200_000, 20)],
            (self.jms.id, "female"): [(40_000, 26)],
        }
        for (store_id, cat), lots in plan.items():
            product = self.supplies.get((store_id, cat))
            if product is None:
                continue
            wh = self.find(store_id)
            for units, months in lots:
                lot = self.add_lot(
                    wh,
                    product,
                    self.batch_number(product, today),
                    add_months(today, months),
                    units,
                    t,
                )
                self.move(
                    wh,
                    product,
                    "opening",
                    units,
                    t,
                    wh.staff[0],
                    lot=lot,
                    note="Opening balance at go-live",
                )
                t += timedelta(minutes=7)
        # A quarantined JMS batch that expired, part written off after the last count.
        product = self.supplies.get((self.jms.id, "male"))
        if product:
            expiry = eat_day(self.end) - timedelta(days=25)
            lot = self.add_lot(
                self.jms, product, f"{product.code}2310-QA", expiry, 12_000, t, hold=True
            )
            self.move(
                self.jms,
                product,
                "opening",
                12_000,
                t,
                self.jms.staff[0],
                lot=lot,
                note="Opening balance at go-live (quarantined pending quality check)",
            )
            when = self.working(self.end - timedelta(days=10))
            if when < self.end:
                lot.on_hand -= 2_400
                self.move(
                    self.jms,
                    product,
                    "adjustment",
                    -2_400,
                    when,
                    self.jms.staff[0],
                    lot=lot,
                    note="Water-damaged cartons written off after the count",
                )
        for wh in self.warehouses:
            for cat in ("male", "female"):
                if (wh.id, cat) in self.supplies:
                    self.at(self.start + timedelta(days=1, hours=9), self.check_warehouse, wh, cat)
        self.at(self.working(self.end - timedelta(days=25)), self.receive_short_dated)

    def receive_short_dated(self) -> None:
        """A short-dated female consignment: every issue from it needs a documented exception."""
        product = self.supplies.get((self.nms.id, "female"))
        if product is None:
            return
        t = self.now
        lot = self.add_lot(
            self.nms,
            product,
            self.batch_number(product, eat_day(t)),
            eat_day(self.end) + timedelta(days=6),
            8_000,
            t,
        )
        self.move(
            self.nms,
            product,
            "receipt",
            8_000,
            t,
            self.rng.choice(self.nms.staff),
            lot=lot,
            note="Short-dated donation, cleared for immediate distribution",
        )

    def warehouse_ami(self, wh: Store, cat: str, t: datetime) -> float:
        recent = sum(u for when, c, u in wh.issued if c == cat and when > t - timedelta(days=90))
        days = min((t - self.start).days, 90)
        expected = sum(self.district_expected(d, cat) for d in self.districts) * (
            1 - self.share(cat) if wh is self.nms else self.share(cat)
        )
        if days < 60:
            return max(expected, 1)
        return max(recent / (days / 30.4), expected * 0.3, 1)

    def share(self, cat: str) -> float:
        if not self.districts or self.nms is self.jms:
            return 0.0
        return (
            sum(d.jms_share for d in self.districts)
            / len(self.districts)
            * (1 if cat == "male" else 0.6)
        )

    def check_warehouse(self, wh: Store, cat: str) -> None:
        t = self.now
        product = self.supplies[(wh.id, cat)]
        h = self.holding(wh, product)
        ami = self.warehouse_ami(wh, cat, t)
        if h.usable(eat_day(t)) + wh.inbound.get(product.id, 0) < 4 * ami:
            step = 50_000 if cat == "male" else 10_000
            units = round_to(9 * ami, step, 4 * step)
            wh.inbound[product.id] = wh.inbound.get(product.id, 0) + units
            self.at(
                self.working(t + timedelta(days=self.rng.uniform(14, 40))),
                self.receive_consignment,
                wh,
                product,
                units,
            )
        self.at(t + timedelta(days=1), self.check_warehouse, wh, cat)

    def receive_consignment(self, wh: Store, product: Product, units: int) -> None:
        t = self.now
        today = eat_day(t)
        wh.inbound[product.id] -= units
        months = self.rng.randint(30, 40) if self.rng.random() < 0.7 else self.rng.randint(14, 20)
        parts = [units] if units < 400_000 else [units // 2, units - units // 2]
        for part in parts:
            lot = self.add_lot(
                wh,
                product,
                self.batch_number(product, today),
                add_months(today, months + self.rng.randint(0, 2)),
                part,
                t,
            )
            self.move(
                wh,
                product,
                "receipt",
                part,
                t,
                self.rng.choice(wh.staff),
                lot=lot,
                note=self.rng.choice(FUNDERS),
            )
        waiting, wh.waiting = wh.waiting, []
        for order in waiting:
            self.at(t + timedelta(minutes=self.rng.randint(30, 600)), self.check_stock, order)

    # ---- district orders -------------------------------------------------------------------

    def district_expected(self, d: Store, cat: str) -> float:
        if not d.hotspots:
            base = max(d.active_hotspots, 20)
            return base * (60 if cat == "male" else 4)
        total = 0.0
        for h in d.hotspots:
            share = 0.83 if cat == "male" else 0.5 * h.female_bias
            low, high = h.male if cat == "male" else h.female
            size = (low + high) / 2 * (144 if cat == "male" else 20)
            total += h.rate * 30.4 / 30 * share * size
        return total

    def district_ami(self, d: Store, cat: str, t: datetime) -> float:
        expected = self.district_expected(d, cat) * (0.8 + 0.4 * self.frac(t))
        days = min((t - self.start).days, 90)
        if days < 45 or not d.hotspots:
            return max(expected, 1)
        recent = sum(u for when, c, u in d.issued if c == cat and when > t - timedelta(days=90))
        return max(recent / (days / 30.4), expected * 0.3, 1)

    def open_districts(self) -> None:
        for d in self.districts:
            t = self.start + timedelta(hours=self.rng.uniform(9, 16))
            today = eat_day(t)
            for cat in ("male", "female"):
                product = next(
                    (p for p in self.products if p.category == cat and not p.commercial), None
                ) or next((p for p in self.products if p.category == cat), None)
                if product is None:
                    continue
                units = round_to(
                    self.district_expected(d, cat) * self.rng.uniform(0.6, 1.6), 100, 100
                )
                known = units if self.rng.random() < 0.6 else int(units * 0.7)
                lot = self.add_lot(
                    d,
                    product,
                    self.batch_number(product, today - timedelta(days=200)),
                    today + timedelta(days=self.rng.randint(150, 330)),
                    known,
                    t,
                )
                self.move(
                    d,
                    product,
                    "opening",
                    known,
                    t,
                    d.staff[0],
                    lot=lot,
                    note="Opening balance counted at go-live",
                )
                if units > known:
                    lot = self.add_lot(d, product, None, None, units - known, t)
                    self.move(
                        d,
                        product,
                        "opening",
                        units - known,
                        t,
                        d.staff[0],
                        lot=lot,
                        note="Opening balance: cartons without batch labels",
                    )
                d.open_order[cat] = None
            weekday = self.rng.randint(0, 4)
            first = self.start + timedelta(days=(weekday - self.start.weekday()) % 7 + 7, hours=10)
            self.at(first, self.review_stock, d, True)

    def review_stock(self, d: Store, scheduled: bool) -> None:
        t = self.working(self.now)
        if t >= self.end or (
            not scheduled and d.last_check and t - d.last_check < timedelta(days=5)
        ):
            return
        d.last_check = t
        today = eat_day(t)
        for cat in ("male", "female"):
            if d.open_order.get(cat) or not any(p.category == cat for p in self.products):
                continue
            ami = self.district_ami(d, cat, t)
            position = sum(
                h.usable(today) for h in d.holdings.values() if h.product.category == cat
            )
            step = 1_000 if cat == "male" else 100
            if not d.hotspots:
                # Districts without hotspot managers order on a schedule, about every quarter.
                if d.last_order and t - d.last_order < timedelta(days=self.rng.uniform(80, 100)):
                    continue
                units = round_to(ami * self.rng.uniform(0.8, 1.2), step, 2 * step)
            elif position >= 2 * ami:
                continue
            else:
                units = round_to(d.target * ami - max(position, 0), step, 2 * step)
            self.create_order(d, cat, units, t)
        if scheduled:
            self.at(self.now + timedelta(days=14), self.review_stock, d, True)

    def create_order(self, d: Store, cat: str, units: int, t: datetime) -> None:
        wh = (
            self.jms
            if self.rng.random() < (d.jms_share if cat == "male" else d.jms_share * 0.6)
            else self.nms
        )
        if (wh.id, cat) not in self.supplies:
            wh = self.nms
        order = {
            "id": self.new_id(),
            "store": d,
            "wh": wh,
            "cat": cat,
            "needed": units,
            "by": self.rng.choice(d.staff),
            "created": t,
            "status": "queued",
            "updated": t,
            "comment": self.rng.choice(ORDER_COMMENTS) if self.rng.random() < 0.35 else None,
            "product": None,
            "approved": None,
            "issued": None,
            "received": None,
            "handled": None,
            "reason": None,
            "note": None,
            "transport": (None,) * 4,
            "unrequested": False,
        }
        d.open_order[cat] = order
        d.last_order = t
        self.orders.append(order)
        self.event(order, order["by"], "replenishment_requested", "queued", units, t)
        self.at(
            self.working(t + timedelta(hours=self.rng.uniform(4, 72))), self.review_order, order
        )

    def event(self, order: dict, actor: str, action: str, status: str, qty, t: datetime) -> None:
        order["status"], order["updated"] = status, t
        self.rows["order_events"].append(
            (self.new_id(), order["id"], actor, action, status, utc_text(t), qty)
        )

    def review_order(self, order: dict) -> None:
        t = self.now
        staff = self.rng.choice(order["wh"].staff)
        if self.rng.random() < 0.05:
            order["reason"] = self.rng.choice(ORDER_REJECTIONS)
            self.event(order, staff, "reject", "rejected", order["needed"], t)
            order["store"].open_order[order["cat"]] = None
            self.at(
                t + timedelta(days=self.rng.uniform(1, 3)), self.review_stock, order["store"], False
            )
            return
        step = 1_000 if order["cat"] == "male" else 100
        approved = order["needed"]
        if self.rng.random() < 0.15:
            approved = min(approved, round_to(approved * self.rng.uniform(0.6, 0.9), step, step))
        order["approved"] = approved
        order["product"] = self.supplies[(order["wh"].id, order["cat"])]
        self.event(order, staff, "review", "reviewed", approved, t)
        self.at(t + timedelta(minutes=self.rng.randint(2, 40)), self.check_stock, order)

    def check_stock(self, order: dict) -> None:
        t = self.now
        wh, product = order["wh"], order["product"]
        h = self.holding(wh, product)
        staff = self.rng.choice(wh.staff)
        if h.usable(eat_day(t)) >= order["approved"]:
            h.reserved += order["approved"]
            self.event(order, staff, "check-stock", "confirmed", order["needed"], t)
            self.at(
                self.working(t + timedelta(days=self.rng.uniform(0.5, 5))), self.dispatch, order
            )
        else:
            if order["status"] != "on_hold":
                self.event(order, staff, "check-stock", "on_hold", order["needed"], t)
            wh.waiting.append(order)

    def transport(self, wh: Store, t: datetime) -> tuple:
        self.waybill_seq += 1
        letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"
        plate = (
            f"U{self.rng.choice('ABD')}{self.rng.choice(letters)} "
            f"{self.rng.randint(100, 999)}{self.rng.choice(letters)}"
        )
        phone = f"0790 {self.rng.randint(0, 999):03d} {self.rng.randint(0, 999):03d}"
        return (
            f"{wh.code.upper()}-WB-{t:%y%m}-{self.waybill_seq:04d}",
            plate,
            self.rng.choice(DRIVERS),
            phone,
        )

    def dispatch(self, order: dict) -> None:
        t = self.now
        wh, product = order["wh"], order["product"]
        h = self.holding(wh, product)
        issued = order["approved"]
        if self.rng.random() < 0.05:
            step = 1_000 if order["cat"] == "male" else 100
            issued = min(issued, round_to(issued * self.rng.uniform(0.8, 0.95), step, step))
        taken = self.take(wh, product, issued, t)
        if taken is None:  # held batches only; wait for the next consignment
            self.at(t + timedelta(days=3), self.dispatch, order)
            return
        staff = self.rng.choice(wh.staff)
        h.reserved -= order["approved"]
        self.move(wh, product, "dispatch", -issued, t, staff, order=order["id"])
        self.ship(taken, t, staff, order=order["id"])
        wh.issued.append((t, order["cat"], issued))
        order.update(issued=issued, handled=staff, transport=self.transport(wh, t), shipped=taken)
        self.event(order, staff, "dispatch", "dispatched", issued, t)
        days = self.rng.uniform(0.5, 2.5) if order["store"].hotspots else self.rng.uniform(1.5, 7)
        self.at(self.working(t + timedelta(days=days)), self.receive_order, order)

    def receive_order(self, order: dict) -> None:
        t = self.now
        d, product = order["store"], order["product"]
        issued = order["issued"]
        received = issued
        if self.rng.random() < 0.07:
            received = max(0, issued - round_to(issued * self.rng.uniform(0.005, 0.03), 10, 10))
            order["note"] = self.rng.choice(DISCREPANCIES)
        actor = self.rng.choice(d.staff)
        left = received
        for lot, q, _days, _near in order["shipped"]:
            if left == 0:
                break
            part = min(left, q)
            self.add_lot(d, product, lot.number, lot.expiry, part, t)
            left -= part
        if received:
            # One ledger line for the receipt, as the app records it.
            self.move(d, product, "order_receipt", received, t, actor, order=order["id"])
        order["received"] = received
        self.event(order, actor, "receive", "received", received, t)
        if d.open_order.get(order["cat"]) is order:
            d.open_order[order["cat"]] = None

    def push_allocation(self, d: Store, note: str) -> None:
        """An unrequested district dispatch: the warehouse sends stock before the district asks."""
        when = self.now
        product = self.supplies.get((self.nms.id, "male"))
        if product is None:
            return
        units = round_to(self.district_expected(d, "male") * 1.5, 1_000, 5_000)
        taken = self.take(self.nms, product, units, when)
        if taken is None:
            return
        staff = self.rng.choice(self.nms.staff)
        order = {
            "id": self.new_id(),
            "store": d,
            "wh": self.nms,
            "cat": "male",
            "needed": units,
            "by": staff,
            "created": when,
            "status": "dispatched",
            "updated": when,
            "comment": note,
            "product": product,
            "approved": units,
            "issued": units,
            "received": None,
            "handled": staff,
            "reason": None,
            "note": None,
            "transport": self.transport(self.nms, when),
            "unrequested": True,
            "shipped": taken,
        }
        self.orders.append(order)
        self.move(self.nms, product, "dispatch", -units, when, staff, order=order["id"])
        self.ship(taken, when, staff, order=order["id"])
        self.nms.issued.append((when, "male", units))
        self.event(order, staff, "dispatch", "dispatched", units, when)
        self.at(
            self.working(when + timedelta(days=self.rng.uniform(1, 4))), self.receive_order, order
        )

    # ---- hotspots --------------------------------------------------------------------------

    def schedule_hotspots(self) -> None:
        go_live = self.start + timedelta(days=7)
        for h in self.hotspots:
            peak = h.rate / 30 * 1.35 * 1.25
            t = go_live
            while True:
                t += timedelta(days=self.rng.expovariate(peak))
                if t >= self.end:
                    break
                rate = h.rate / 30 * SEASON[t.astimezone(EAT).month] * (0.75 + 0.5 * self.frac(t))
                if self.rng.random() < rate / peak:
                    local = t.astimezone(EAT)
                    hour = self.rng.choices(
                        [
                            self.rng.uniform(7, 10),
                            self.rng.uniform(10, 16),
                            self.rng.uniform(16, 23),
                        ],
                        [0.15, 0.25, 0.6],
                    )[0]
                    when = local.replace(
                        hour=int(hour), minute=int(hour % 1 * 60), second=self.rng.randint(0, 59)
                    )
                    self.at(when, self.raise_stockout, h)

    def pick_selection(self, h: Hotspot) -> str:
        weights = [0.5, 0.33 * min(h.female_bias, 1.3), 0.17 * h.female_bias]
        return self.rng.choices(["male", "both", "female"], weights)[0]

    def raise_stockout(self, h: Hotspot) -> None:
        t = self.now
        selection = self.pick_selection(h)
        if h.open is not None:
            # Waiting for stock, the manager reports again; with stock delivered, they acknowledge.
            if h.open.needs() or h.open.pending:
                self.repeat(h.open, selection, t)
            return
        comment = self.rng.choice(RAISE_COMMENTS) if self.rng.random() < 0.55 else None
        report = Report(self.new_id(), h, selection, t, comment, last_reported=t)
        h.open = report
        self.reports.append(report)
        self.report_event(report, h.manager, "raised", selection, {"comment": comment}, t)
        self.sync(h.manager, "stockout", t, report.id)
        self.schedule_delivery(report, t, first=True)

    def repeat(self, report: Report, selection: str, t: datetime) -> None:
        combined = (
            report.selection
            if selection == report.selection
            else ("both" if report.selection != "both" else "both")
        )
        action = "repeated" if combined == report.selection else "selection_changed"
        data = {
            "from": report.selection,
            "reported": selection,
            "comment": self.rng.choice(REPEAT_COMMENTS),
        }
        report.selection = combined
        report.repeat_count += 1
        report.last_reported = t
        self.report_event(report, report.hotspot.manager, action, combined, data, t)
        self.sync(report.hotspot.manager, "stockout", t, report.id)
        if report.needs() and not report.pending:
            self.schedule_delivery(report, t, first=False)

    def report_event(
        self, report: Report, actor: str, action: str, selection: str, data: dict, t: datetime
    ) -> None:
        self.rows["stockout_report_events"].append(
            (self.new_id(), report.id, actor, action, selection, json.dumps(data), utc_text(t))
        )

    def schedule_delivery(self, report: Report, t: datetime, first: bool) -> None:
        d = report.hotspot.store
        improvement = 1.4 - 0.75 * self.frac(t)
        hours = d.response_hours * improvement * self.rng.lognormvariate(0, 0.7)
        if not first:
            hours = self.rng.uniform(20, 120)
        report.pending = True
        self.at(self.working(t + timedelta(hours=hours)), self.deliver, report)

    def deliver(self, report: Report) -> None:
        t = self.now
        report.pending = False
        if report.fulfilled or report.rejected:
            return
        h, d = report.hotspot, report.hotspot.store
        dcfp = self.rng.choice(d.staff)
        if not report.sent and t - report.created < timedelta(days=3) and self.rng.random() < 0.035:
            self.reject(report, dcfp, self.rng.choice(REJECT_REASONS), t)
            return
        today = eat_day(t)
        lines = []
        for cat in report.needs():
            low, high = h.male if cat == "male" else h.female
            box = 144 if cat == "male" else 20
            want = self.rng.randint(low, high) * box
            options = sorted(
                (x for x in d.holdings.values() if x.product.category == cat),
                key=lambda x: (x.product.commercial, -x.usable(today)),
            )
            for holding in options:
                available = holding.usable(today)
                if available >= want:
                    lines.append((cat, holding.product, want))
                    break
                if available >= want // 2 and available >= box:
                    lines.append((cat, holding.product, available // box * box))
                    break
        if not lines:
            waited = t - report.created
            if not report.sent and waited > timedelta(days=25) and self.rng.random() < 0.5:
                self.reject(report, dcfp, NO_STOCK_REASON, t)
                return
            if t - report.last_reported > timedelta(days=3) and self.rng.random() < 0.6:
                when = report.last_reported + timedelta(days=self.rng.uniform(2.5, 3.5))
                if when < t:
                    self.repeat(report, report.selection, when)
            self.review_stock(d, False)
            report.pending = True
            self.at(self.working(t + timedelta(days=self.rng.uniform(1, 2))), self.deliver, report)
            return
        delivery = self.new_id()
        rider = self.rng.choice(d.riders) if d.riders and self.rng.random() < 0.5 else None
        note = self.rng.choice(
            ["Delivered by boda boda.", "Handed to the bar manager.", None, None]
        )
        self.rows["hotspot_deliveries"].append(
            (delivery, report.id, d.id, dcfp, note, None, utc_text(t), rider)
        )
        summary, made = [], []
        for cat, product, units in lines:
            taken = self.take(d, product, units, t)
            line = self.new_id()
            pieces = units * product.per_unit
            made.append(
                {
                    "id": line,
                    "category": cat,
                    "product": product,
                    "units": units,
                    "pieces": pieces,
                    "acked": None,
                    "by": None,
                    "at": None,
                }
            )
            self.ship(taken, t, dcfp, line=line, delivery=delivery)
            self.move(d, product, "hotspot_delivery", -units, t, dcfp, delivery=delivery)
            d.issued.append((t, cat, units))
            summary.append({"category": cat, "pieces": pieces})
            report.sent.add(cat)
        self.deliveries.append((delivery, made))
        self.report_event(
            report,
            dcfp,
            "delivered",
            report.selection,
            {"delivery_id": delivery, "lines": summary},
            t,
        )
        delay = timedelta(hours=self.rng.lognormvariate(math.log(2.5), 1.3))
        if self.rng.random() < 0.06:
            delay += timedelta(days=self.rng.uniform(3, 14))
        self.at(t + delay, self.acknowledge, report, made)
        if report.needs():
            self.schedule_delivery(report, t, first=False)
        if any(
            x.usable(today) < 0.75 * self.district_ami(d, x.product.category, t)
            for x in d.holdings.values()
        ):
            self.review_stock(d, False)

    def reject(self, report: Report, dcfp: str, reason: str, t: datetime) -> None:
        report.rejected, report.rejected_by, report.reason = t, dcfp, reason
        report.hotspot.open = None
        self.report_event(report, dcfp, "rejected", report.selection, {"reason": reason}, t)

    def acknowledge(self, report: Report, lines: list) -> None:
        t = self.now
        manager = report.hotspot.manager
        recorded = []
        for line in lines:
            pieces = line["pieces"]
            roll = self.rng.random()
            if roll < 0.01:
                pieces = 0
            elif roll < 0.07:
                box = 144 if line["category"] == "male" else 20
                pieces = max(pieces - box * self.rng.randint(1, 2), 0)
            line.update(acked=pieces, by=manager, at=t)
            recorded.append({"line_id": line["id"], "category": line["category"], "pieces": pieces})
            if pieces > 0:
                report.acked.add(line["category"])
            else:
                report.sent.discard(line["category"])
        self.report_event(report, manager, "acknowledged", report.selection, {"lines": recorded}, t)
        self.sync(manager, "acknowledge", t, report.id)
        cats = ["male", "female"] if report.selection == "both" else [report.selection]
        if report.fulfilled is None and all(c in report.acked for c in cats):
            report.fulfilled = t
            report.hotspot.open = None
        elif report.needs() and not report.pending:
            self.schedule_delivery(report, t, first=False)

    # ---- counts ----------------------------------------------------------------------------

    def schedule_counts(self) -> None:
        month = add_months(self.start.date(), 3)
        while True:
            day = add_months(month, 0) - timedelta(days=1)
            when = datetime.combine(day, datetime.min.time(), EAT) + timedelta(hours=15)
            if when >= self.end:
                break
            for store in self.warehouses + self.districts:
                self.at(
                    self.working(when + timedelta(hours=self.rng.uniform(0, 30))), self.count, store
                )
            month = add_months(month, 3)

    def count(self, store: Store) -> None:
        t = self.now
        for h in store.holdings.values():
            lots = [lot for lot in h.lots.values() if lot.on_hand > 0 and not lot.hold]
            if not lots or self.rng.random() < 0.55:
                continue
            lot = max(lots, key=lambda lot: lot.on_hand)
            change = int(lot.on_hand * self.rng.uniform(-0.004, 0.0015))
            if change == 0 or h.usable(eat_day(t)) + change < 0 or lot.on_hand + change < 0:
                continue
            lot.on_hand += change
            note = (
                "Quarterly physical count"
                if change > 0
                else "Quarterly physical count: damaged or missing cartons"
            )
            self.move(
                store,
                h.product,
                "adjustment",
                change,
                t,
                self.rng.choice(store.staff),
                lot=lot,
                note=note,
            )

    # ---- run -------------------------------------------------------------------------------

    def run(self) -> None:
        self.orders: list = []
        self.reports: list = []
        self.deliveries: list = []
        self.open_warehouses()
        self.open_districts()
        self.schedule_hotspots()
        self.schedule_counts()
        movers = [d for d in self.districts if d.hotspots]
        for d in self.rng.sample(movers, min(3, len(movers))):
            when = self.working(self.start + timedelta(days=self.rng.randint(230, 260)))
            self.at(when, self.push_allocation, d, "Extra allocation for the mid-year campaign")
        for d in self.rng.sample(movers, min(3, len(movers))):
            when = self.working(self.end - timedelta(days=self.rng.uniform(2, 5)))
            self.at(when, self.push_allocation, d, "Allocation ahead of World AIDS Day")
        while self.queue:
            self.now, _, fn, args = heapq.heappop(self.queue)
            fn(*args)
        self.collect()

    def collect(self) -> None:
        rows = self.rows
        for o in self.orders:
            product = o["product"]
            waybill, plate, driver, phone = o["transport"]
            rows["orders"].append(
                (
                    o["id"],
                    product.id if product else None,
                    o["needed"],
                    o["issued"],
                    o["status"],
                    eat_day(o["created"]),
                    o["by"],
                    o["handled"],
                    o["store"].id,
                    o["wh"].id,
                    product.unit_id if product else None,
                    o["comment"],
                    naive_utc(o["created"]),
                    naive_utc(o["updated"]),
                    o["received"],
                    o["note"],
                    o["approved"],
                    o["cat"],
                    o["reason"] if o["status"] == "rejected" else None,
                    waybill,
                    plate,
                    driver,
                    phone,
                    o["unrequested"],
                )
            )
        for r in self.reports:
            rows["stockout_reports"].append(
                (
                    r.id,
                    r.hotspot.id,
                    r.hotspot.store.id,
                    r.hotspot.manager,
                    r.comment,
                    utc_text(r.created),
                    None,
                    r.selection,
                    r.repeat_count,
                    utc_text(r.last_reported),
                    r.fulfilled and utc_text(r.fulfilled),
                    r.rejected and utc_text(r.rejected),
                    r.rejected_by,
                    r.reason,
                )
            )
        for delivery, lines in self.deliveries:
            for line in lines:
                p = line["product"]
                rows["hotspot_delivery_lines"].append(
                    (
                        line["id"],
                        delivery,
                        line["category"],
                        p.id,
                        p.unit_id,
                        line["units"],
                        line["pieces"],
                        line["acked"],
                        line["by"],
                        line["at"] and utc_text(line["at"]),
                    )
                )
        stock = []
        for store in self.warehouses + self.districts:
            for h in store.holdings.values():
                if h.first is None:
                    continue
                stock.append(
                    (
                        self.new_id(),
                        store.id,
                        h.product.id,
                        h.product.unit_id,
                        h.on_hand,
                        h.reserved,
                        utc_text(h.first),
                    )
                )
                for lot in h.lots.values():
                    rows["stock_batches"].append(
                        (
                            lot.id,
                            store.id,
                            h.product.id,
                            h.product.unit_id,
                            lot.number,
                            lot.expiry,
                            lot.on_hand,
                            utc_text(lot.created),
                            utc_text(lot.created),
                        )
                    )
                assert h.on_hand == sum(lot.on_hand for lot in h.lots.values()), (
                    store.name,
                    h.product.label,
                )
        self.stock = stock


TABLES = [
    (
        "stock_batches",
        "id, store_id, condom_id, unit_of_measure_id, batch_number, expiry_date, "
        "on_hand, created_at, updated_at",
    ),
    (
        "orders",
        "id, condom_id, quantity_needed, quantity_issued, order_status, order_date, "
        "ordered_by_id, handled_by_id, ordered_for_store_id, ordered_from_store_id, "
        "unit_of_measure_id, comment, created_at, updated_at, quantity_received, "
        "discrepancy_note, quantity_approved, condom_category, rejection_reason, "
        "waybill_number, vehicle_registration, driver_name, driver_phone, unrequested",
    ),
    ("order_events", "id, order_id, actor_id, action, status, created_at, quantity"),
    (
        "stockout_reports",
        "id, hot_spot_id, district_store_id, reported_by_id, comment, created_at, "
        "condom_id, selection, repeat_count, last_reported_at, fulfilled_at, "
        "rejected_at, rejected_by_id, rejection_reason",
    ),
    ("stockout_report_events", "id, report_id, actor_id, action, selection, data, created_at"),
    (
        "hotspot_deliveries",
        "id, stockout_report_id, district_store_id, delivered_by_id, note, "
        "client_reference, created_at, rider_id",
    ),
    (
        "hotspot_delivery_lines",
        "id, delivery_id, category, condom_id, unit_of_measure_id, quantity, "
        "pieces, acknowledged_pieces, acknowledged_by_id, acknowledged_at",
    ),
    (
        "inventory_movements",
        "id, store_id, condom_id, unit_of_measure_id, reason, quantity, "
        "on_hand_after, order_id, actor_id, note, created_at, "
        "hotspot_delivery_id, stock_batch_id",
    ),
    (
        "shipment_batches",
        "id, order_id, hotspot_delivery_line_id, batch_number, expiry_date, "
        "quantity, days_remaining, created_at",
    ),
    (
        "expiry_exceptions",
        "id, stock_batch_id, order_id, hotspot_delivery_id, authorized_by_id, "
        "reason, quantity, expiry_date, days_remaining, rule_version, created_at",
    ),
    (
        "mobile_sync_log",
        "id, user_id, session_id, client_entry_id, action, status, "
        "server_record_id, queued_at, changed_at, attempt_count, attempts, "
        "last_error, platform, os_version, app_version, received_at",
    ),
]


def literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, date):
        return f"'{value.isoformat()}'"
    return "'" + str(value).replace("'", "''") + "'"


def emit(out, table: str, columns: str, rows: list) -> None:
    for i in range(0, len(rows), 500):
        chunk = rows[i : i + 500]
        out.write(f"INSERT INTO {table} ({columns}) VALUES\n")
        out.write(",\n".join("(" + ", ".join(literal(v) for v in row) + ")" for row in chunk))
        out.write(";\n")


def write_sql(demo: Demo, out) -> None:
    out.write(f"""-- Demo activity generated by scripts/demo_activity.py on {demo.end:%Y-%m-%d %H:%M} UTC.
-- Remove it with scripts/demo_activity_remove.sql (make db-demo-remove).
BEGIN;
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM inventory_movements WHERE id::text LIKE 'de300000-%')
		OR EXISTS (SELECT 1 FROM orders WHERE id::text LIKE 'de300000-%')
		OR EXISTS (SELECT 1 FROM stockout_reports WHERE id::text LIKE 'de300000-%') THEN
		RAISE EXCEPTION 'demo activity is already loaded: run make db-demo-remove first';
	END IF;
END $$;
""")
    out.write(
        "CREATE TEMP TABLE demo_stock (id uuid, store_id uuid, condom_id uuid, "
        "unit_of_measure_id uuid, on_hand bigint, reserved bigint, created_at timestamptz) "
        "ON COMMIT DROP;\n"
    )
    emit(
        out,
        "demo_stock",
        "id, store_id, condom_id, unit_of_measure_id, on_hand, reserved, created_at",
        demo.stock,
    )
    out.write("""
-- The balance rows the demo's batches hang off, created empty where a store has none yet.
INSERT INTO order_store_stock (id, store_id, condom_id, unit_of_measure_id, on_hand, reserved,
	created_at, updated_at)
SELECT id, store_id, condom_id, unit_of_measure_id, 0, 0, created_at, created_at FROM demo_stock
ON CONFLICT (store_id, condom_id, unit_of_measure_id) DO NOTHING;
""")
    for table, columns in TABLES:
        emit(out, table, columns, demo.rows[table])
    out.write("""
-- Balances: add the demo's net stock and reservations to each store's row.
UPDATE order_store_stock b SET on_hand = b.on_hand + d.on_hand, reserved = b.reserved + d.reserved
FROM demo_stock d
WHERE b.store_id = d.store_id AND b.condom_id = d.condom_id
	AND b.unit_of_measure_id = d.unit_of_measure_id;

-- Each movement's balance after it, now that demo and real movements interleave.
UPDATE inventory_movements m SET on_hand_after = x.running
FROM (SELECT id, sum(quantity) OVER (PARTITION BY store_id, condom_id, unit_of_measure_id
		ORDER BY created_at, id) AS running
	FROM inventory_movements
	WHERE (store_id, condom_id, unit_of_measure_id) IN (SELECT store_id, condom_id,
		unit_of_measure_id FROM demo_stock)) x
WHERE x.id = m.id AND m.on_hand_after <> x.running;

-- Every balance the demo touched must still equal its ledger and its batches.
DO $$ DECLARE bad text; BEGIN
	SELECT string_agg(s.name, ', ') INTO bad
	FROM order_store_stock b JOIN stores s ON s.id = b.store_id
	WHERE (b.store_id, b.condom_id, b.unit_of_measure_id) IN (SELECT store_id, condom_id,
			unit_of_measure_id FROM demo_stock)
		AND (b.on_hand <> (SELECT coalesce(sum(quantity), 0) FROM inventory_movements m
				WHERE m.store_id = b.store_id AND m.condom_id = b.condom_id
					AND m.unit_of_measure_id = b.unit_of_measure_id)
			OR b.on_hand <> (SELECT coalesce(sum(on_hand), 0) FROM stock_batches sb
				WHERE sb.store_id = b.store_id AND sb.condom_id = b.condom_id
					AND sb.unit_of_measure_id = b.unit_of_measure_id));
	IF bad IS NOT NULL THEN
		RAISE EXCEPTION 'demo stock does not reconcile at %', bad;
	END IF;
END $$;
COMMIT;
""")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("refs", help="JSON printed by scripts/demo_activity_refs.sql")
    parser.add_argument("--seed", type=int, default=2026, help="random seed (default 2026)")
    parser.add_argument(
        "--months",
        type=int,
        default=12,
        help="whole months of history before this one (default 12)",
    )
    args = parser.parse_args()
    with open(args.refs, encoding="utf-8") as f:
        refs = json.load(f)
    now = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=15)
    demo = Demo(refs, args.seed, args.months, now)
    demo.run()
    write_sql(demo, sys.stdout)
    counts = ", ".join(f"{len(rows)} {name}" for name, rows in demo.rows.items() if rows)
    print(f"demo activity from {demo.start:%Y-%m-%d}: {counts}", file=sys.stderr)


if __name__ == "__main__":
    main()
