import React from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Redirect, Tabs } from "expo-router";
import { useT } from "@/lib/theme";
import PushBanner from "@/components/m/PushBanner";
import PushNotifications from "@/components/m/PushNotifications";
import TabBar from "@/components/m/TabBar";
import { Skeleton, SkeletonList } from "@/components/m/kit";
import { useColumn } from "@/hooks/useResponsive";
import { useSession } from "@/lib/session";
import { StoreProvider, useStore } from "@/lib/store";
import { ChooseNewPassword } from "@/screens/account";

const TAB_ROUTES = ["hotspots", "requests", "dashboard", "orders", "deliveries", "history", "me"];

/** The shape of a tab while the phone's saved data loads: title, search bar and list rows. */
function LoadingShell() {
  const T = useT();
  const insets = useSafeAreaInsets();
  const col = useColumn();
  return (
    <View style={{ flex: 1, backgroundColor: T.bg, paddingTop: insets.top + 16 }}>
      <View style={[col.style, { gap: 16 }]}>
        <View style={{ paddingHorizontal: 16, gap: 16 }}>
          <Skeleton w="45%" h={30} r={8} />
          <Skeleton h={T.srH} r={T.srR} />
        </View>
        <SkeletonList rows={6} />
      </View>
    </View>
  );
}

function Signed() {
  const { ready } = useStore();
  if (!ready) return <LoadingShell />;
  return (
    <View style={{ flex: 1 }}>
      {/* Every role's tabs are registered; TabBar shows only the signed-in role's. */}
      {/* Tabs cross-fade on switch instead of cutting. */}
      <Tabs
        tabBar={(p) => <TabBar {...p} />}
        screenOptions={{ headerShown: false, animation: "fade" }}
      >
        {TAB_ROUTES.map((n) => (
          <Tabs.Screen key={n} name={n} />
        ))}
      </Tabs>
      <PushBanner />
      <PushNotifications />
    </View>
  );
}

export default function AppLayout() {
  const { user } = useSession();
  if (!user) return <Redirect href="/signin" />;
  // A password someone else chose is replaced before anything else loads: until then the API
  // refuses every other request, so the store, push registration and tabs wait.
  if (user.mustChangePassword && !user.demo) return <ChooseNewPassword />;
  return (
    <StoreProvider key={user.id}>
      <Signed />
    </StoreProvider>
  );
}
