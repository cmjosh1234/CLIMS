import React from "react";
import { useLocalSearchParams } from "expo-router";
import Screen from "@/components/m/Screen";
import { Banner } from "@/components/m/kit";
import { HM_HOTSPOT } from "@/lib/seed";
import { useMe } from "@/lib/session";
import { useStore } from "@/lib/store";
import { OrderScreen } from "./order";
import { RiderDelivery, RiderReceipt } from "./rider";
import { RiderAssignment } from "./riderLive";
import { ChangePassword, EditDetails } from "./account";
import { Help, Inbox } from "./shared";
import { StockoutForm } from "./stockout";
import { StockoutScreen } from "./stockoutDetail";
import { RequestForm, VhtHotspot, VhtMap, VhtMapDone } from "./vht";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Renders `/<tab>/<kind>/<id?>` inside any tab's stack, so detail pages keep
 * the tab bar and the tab the user came from, as in the design.
 */
export default function Detail() {
  const { path } = useLocalSearchParams<{ path: string[] }>();
  const me = useMe();
  const { s } = useStore();
  const [kind, id] = Array.isArray(path) ? path : [path];

  switch (kind) {
    case "order":
      if (!id) return null;
      // Stockout notifications sent to the API (and inbox notes about them) open their own screen.
      return s.orders.find((o) => o.id === id)?.source === "api" || UUID.test(id) ? (
        <StockoutScreen id={id} />
      ) : (
        <OrderScreen id={id} />
      );
    case "stockout":
      return id ? <StockoutScreen id={id} /> : null;
    case "hotspot":
      return id ? <VhtHotspot id={id} /> : null;
    case "request":
      // Signed-in VHTs send real stockout alerts; demo sign-ins and hotspot managers use samples.
      if (me.demo)
        return me.role === "hm" ? (
          <RequestForm hotspotId={HM_HOTSPOT} fixed />
        ) : (
          <RequestForm hotspotId={id} />
        );
      if (me.role === "hm")
        return me.hotspotId ? (
          <StockoutForm
            fixed={{
              id: me.hotspotId,
              name: me.hotspot?.name || "Your hotspot",
              village: me.hotspot?.village ?? "",
              subcounty: me.hotspot?.subcounty ?? "",
              district: me.hotspot?.district ?? "",
            }}
          />
        ) : (
          <Screen title="Report stockout">
            <Banner
              tone="neutral"
              title="No hotspot linked to your account"
              body="Call your district focal person to link your hotspot."
            />
          </Screen>
        );
      return <StockoutForm hotspotId={id} />;
    case "map":
      return id ? <VhtMapDone id={id} /> : <VhtMap />;
    case "assignment":
      return id ? <RiderAssignment id={id} /> : null;
    case "delivery":
      return id ? <RiderDelivery id={id} /> : null;
    case "receipt":
      return id ? <RiderReceipt id={id} /> : null;
    case "help":
      return <Help />;
    // The person's own account, opened from Me. Sample-data sign-ins have no account to change.
    case "details":
      return me.demo ? null : <EditDetails />;
    case "password":
      return me.demo ? null : <ChangePassword />;
    case "inbox":
      return <Inbox />;
  }
  return (
    <Screen title="Not found">
      <Banner tone="neutral" title="This page isn't available" />
    </Screen>
  );
}
