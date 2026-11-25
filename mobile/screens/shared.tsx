import React, { useCallback, useState } from "react";
import { Platform, View } from "react-native";
import { useFocusEffect, router } from "expo-router";
import { useT, useTheme, type ThemeMode } from "@/lib/theme";
import Screen from "@/components/m/Screen";
import { Avatar, Fields, List, Row, Section, Seg, Sheet, Toggle, Txt } from "@/components/m/kit";
import type { IconName } from "@/components/m/Icon";
import { ago, initials } from "@/lib/format";
import { TAB_LABEL, useNav } from "@/lib/nav";
import { DCFP, HM_HOTSPOT, RIDER } from "@/lib/seed";
import { ROLE_LABEL, useMe, useSession } from "@/lib/session";
import { DELIVERY_REF, HOTSPOT_REF, isUnread, STOCKOUT_REF } from "@/lib/notifications";
import { useNotes, useStore } from "@/lib/store";
import type { AppEvent } from "@/lib/types";
import { call } from "./common";
import { TYPE } from "@/lib/fonts";

const ORG: Record<string, (e: AppEvent) => string> = {
  DCFP: () => `${DCFP.district} district`,
  Rider: (e) => `${e.actor} · rider`,
  MOH: () => "Ministry of Health",
  NMS: () => "National Medical Stores",
  JMS: () => "Joint Medical Store",
  System: () => "CLIMS",
};
export const orgOf = (e: AppEvent) => e.org ?? (ORG[e.role] ? ORG[e.role](e) : e.actor);

const NOTE_IC: Record<string, IconName> = {
  DCFP: "building",
  Rider: "truck",
  MOH: "shield",
  "Hotspot manager": "pin",
  VHT: "user",
  System: "info",
};

export function useOpenNote() {
  const nav = useNav();
  const me = useMe();
  const { readNotice } = useStore();
  return useCallback(
    (e: AppEvent) => {
      if (e.serverId) {
        readNotice(e);
        // A delivery agent opens what they are to carry.
        if (e.ref.startsWith(DELIVERY_REF))
          return nav.go(`assignment/${e.ref.slice(DELIVERY_REF.length)}`);
        // A delivery opens the stockout, where the hotspot manager confirms what arrived.
        if (e.ref.startsWith(STOCKOUT_REF))
          return nav.go(`stockout/${e.ref.slice(STOCKOUT_REF.length)}`);
        if (e.ref.startsWith(HOTSPOT_REF) && me.role === "vht")
          return nav.go(`hotspot/${e.ref.slice(HOTSPOT_REF.length)}`);
        // Nothing else to open: the notification says it all.
        return;
      }
      if (e.ref.startsWith("MAP-")) return nav.go("map");
      if (e.ref.startsWith("REQ-")) return nav.go("request");
      if (me.role === "rider") return nav.go(`delivery/${e.ref}`);
      return nav.go(`order/${e.ref}`);
    },
    [nav, me.role, readNotice],
  );
}

export function Inbox() {
  const nav = useNav();
  const me = useMe();
  const { s, markRead, refreshNotices } = useStore();
  const notes = useNotes().slice(0, 50);
  const open = useOpenNote();
  // What was unread when the inbox opened stays marked "new" while it is on screen.
  const [rd] = useState(() => s.read[me.role] ?? 0);
  const [freshIds] = useState(() => new Set(notes.filter((e) => isUnread(e, rd)).map((e) => e.id)));
  const unread = notes.some((e) => isUnread(e, s.read[me.role] ?? 0));

  // Check the API for anything new whenever the inbox is opened.
  useFocusEffect(
    useCallback(() => {
      refreshNotices();
    }, [refreshNotices]),
  );

  // Like the design: notifications count as read after you've looked at the inbox briefly.
  useFocusEffect(
    useCallback(() => {
      if (!unread) return;
      const t = setTimeout(() => markRead(me.role), 1600);
      return () => clearTimeout(t);
    }, [unread, markRead, me.role]),
  );

  const isFresh = (e: AppEvent) => freshIds.has(e.id) || isUnread(e, rd);
  const row = (e: AppEvent) => (
    <Row
      key={e.id}
      t={e.text}
      s={`${e.body ? `${e.body}\n` : ""}${orgOf(e)} · ${ago(e.t)}`}
      dot={isFresh(e)}
      ic={NOTE_IC[e.role] ?? "bell"}
      onPress={() => open(e)}
    />
  );
  const fresh = notes.filter(isFresh);
  const old = notes.filter((e) => !isFresh(e));
  return (
    <Screen title="Notifications" backLabel={TAB_LABEL[nav.tab]}>
      {fresh.length ? <List h="New">{fresh.map(row)}</List> : null}
      <List
        h={fresh.length ? "Earlier" : undefined}
        empty={
          fresh.length
            ? undefined
            : "No notifications yet. You will be notified here when something needs you."
        }
      >
        {old.map(row)}
      </List>
    </Screen>
  );
}

export function Me() {
  const T = useT();
  const nav = useNav();
  const me = useMe();
  const { signOut } = useSession();
  const { s, offline, reset } = useStore();
  const { mode, setMode } = useTheme();
  const [push, setPush] = useState(true);
  const [outbox, setOutbox] = useState(false);
  const nq = s.outbox.length;
  const changedAt = me.passwordChangedAt ? Date.parse(me.passwordChangedAt) : NaN;
  const passwordChanged = Number.isFinite(changedAt) ? changedAt : undefined;
  const demoHotspot =
    me.demo && me.role === "hm" ? s.hotspots.find((h) => h.id === HM_HOTSPOT) : undefined;
  const hotspot = me.hotspot ?? demoHotspot;
  const demoArea =
    me.demo && me.role === "vht"
      ? [
          ...new Set(
            s.hotspots
              .filter((h) => h.vhts.includes(me.name))
              .map((h) => h.subcounty)
              .filter(Boolean),
          ),
        ].join(" & ")
      : undefined;
  const demoPlate = me.demo && me.role === "rider" ? RIDER.plate : undefined;
  const district =
    hotspot?.district ||
    me.store?.district_name ||
    me.subcounty?.district_name ||
    me.organisationUnit?.district ||
    (me.demo ? DCFP.district : undefined);
  const assignments = [
    { label: "Location", name: me.location },
    {
      label: "Hotspot",
      name: hotspot?.name,
      detail: [hotspot?.type, hotspot?.village, hotspot?.subcounty, hotspot?.district]
        .filter(Boolean)
        .join(" · "),
    },
    {
      label: "Organisation unit",
      name: me.organisationUnit?.name,
      detail: [
        me.organisationUnit?.subcounty,
        me.organisationUnit?.district,
        me.organisationUnit?.region,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    { label: "Subcounty", name: me.subcounty?.name, detail: me.subcounty?.district_name },
    {
      label: "Store",
      name: me.store?.name,
      detail:
        me.store?.district_name ||
        (me.store?.store_type === "national" ? "National warehouse" : undefined),
    },
    { label: "Area", name: demoArea },
    { label: "Motorbike", name: demoPlate },
  ].filter(({ name }) => !!name?.trim());
  return (
    <Screen title="Me" root>
      <Section>
        <View style={{ alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 16 }}>
          <Avatar ini={initials(me.name)} size={72} />
          <Txt style={{ ...TYPE.title, fontWeight: T.ios ? "700" : "600", textAlign: "center" }}>
            {me.name}
          </Txt>
          <Txt style={{ color: T.fg2, ...TYPE.subhead, textAlign: "center" }}>
            {[ROLE_LABEL[me.role], district].filter(Boolean).join(" · ")}
          </Txt>
        </View>
      </Section>
      <List h="Account" f={me.demo ? undefined : "Only an administrator can change your username."}>
        <Row t="Username" v={me.username} />
        {me.email ? <Row t="Email" v={me.email} /> : null}
        {me.phone ? <Row t="Phone" v={me.phone} /> : null}
        {me.demo ? null : (
          <Row t="Edit details" fg={T.tint} chev onPress={() => nav.go("details")} />
        )}
      </List>
      {me.demo ? null : (
        <List h="Password">
          <Row
            t="Change password"
            s={passwordChanged ? `Last changed ${ago(passwordChanged)}` : undefined}
            fg={T.tint}
            chev
            onPress={() => nav.go("password")}
          />
        </List>
      )}
      <List
        h="Assignments"
        f="Your district focal person manages your role and assignments."
        empty="No assignment details available."
      >
        {assignments.map(({ label, name, detail }) => (
          <Row key={label} t={label} s={[name, detail].filter(Boolean).join("\n")} />
        ))}
      </List>
      <Fields
        card
        h="Appearance"
        f={mode === "system" ? "Follows your phone's light or dark setting." : undefined}
      >
        <Seg<ThemeMode>
          label="Theme"
          options={[
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
          value={mode}
          onChange={setMode}
        />
      </Fields>
      <Fields card h="Notifications">
        <Toggle
          label="Push notifications"
          sub="Order and delivery updates"
          value={push}
          onChange={setPush}
        />
      </Fields>
      <List
        h="Offline"
        f="Anything you do without network is saved on this phone and sent automatically when you are back online."
      >
        <Row t="Connection" v={offline ? "Offline" : "Online"} vfg={offline ? T.warnFg : T.fg2} />
        <Row
          t="Waiting to send"
          v={String(nq)}
          chev={nq > 0}
          onPress={nq ? () => setOutbox(true) : undefined}
        />
      </List>
      <List h="Support">
        <Row t="Help & guides" ic="help" chev onPress={() => nav.go("help")} />
        {me.demo ? (
          <Row
            t="Call district focal person"
            s={`${DCFP.name} · ${DCFP.phone}`}
            ic="phone"
            onPress={() => call(DCFP.phone)}
          />
        ) : null}
      </List>
      {me.demo ? (
        <List h="Demo" f="You're using sample Wakiso data. It stays on this phone.">
          <Row t="Reset sample data" fg={T.tint} onPress={reset} />
        </List>
      ) : null}
      <List f={`CLIMS mobile 2.0 · ${Platform.OS === "ios" ? "iOS" : "Android"}`}>
        <Row
          t="Sign out"
          fg={T.danger}
          onPress={async () => {
            await signOut();
            router.replace("/signin");
          }}
        />
      </List>
      <Sheet
        visible={outbox}
        title="Waiting to send"
        icon="clock"
        tone={offline ? "warning" : "info"}
        onClose={() => setOutbox(false)}
      >
        {offline ? (
          <Txt style={{ marginHorizontal: 24, marginBottom: 12, color: T.fg2, ...TYPE.subhead }}>
            These will send automatically when the phone is back online.
          </Txt>
        ) : null}
        <List empty="Nothing waiting.">
          {s.outbox.map((it) => (
            <Row key={it.id} t={it.label} s={`Saved ${ago(it.at)}`} ic="upload" />
          ))}
        </List>
      </Sheet>
    </Screen>
  );
}

const GUIDES: Record<string, [string, string][]> = {
  vht: [
    [
      "Mapping a hotspot",
      "Stand at the entrance and capture GPS. Add the contact person and a photo of the dispenser.",
    ],
    [
      "Requesting stock for a hotspot",
      "Count what is left with the contact person, then send. The district reviews it within a day.",
    ],
  ],
  hm: [
    [
      "Reporting a stockout",
      "Tap Report stockout on Home. Count what is left and say how much you need.",
    ],
    [
      "When the rider arrives",
      "Count the condoms with the rider, sign the delivery note, then confirm receipt in the app.",
    ],
  ],
  rider: [
    [
      "Collecting stock",
      "Check the delivery note and batch numbers against what you load at the district store.",
    ],
    [
      "At the hotspot",
      "Count with the contact person, get their signature and photograph the signed delivery note.",
    ],
    [
      "No network at the hotspot",
      "Finish the handover anyway. It sends when you have network again.",
    ],
  ],
};

export function Help() {
  const me = useMe();
  return (
    <Screen title="Help" backLabel="Me">
      <List h="Guides">
        {GUIDES[me.role].map(([t, s]) => (
          <Row key={t} t={t} s={s} fw="500" />
        ))}
      </List>
      <List
        h="Contact"
        f="Working without network? Keep going — the app saves your work and sends it later."
      >
        <Row
          t={`Call ${DCFP.name}`}
          s={`District focal person · ${DCFP.district}`}
          ic="phone"
          onPress={() => call(DCFP.phone)}
        />
      </List>
    </Screen>
  );
}
