import Ionicons from "@expo/vector-icons/Ionicons";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, Image, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { I18nProvider, useI18n } from "./src/i18n";
import { api } from "./src/lib/api";
import type { Approval } from "./src/lib/types";
import { type RootParams, useNav, Waiting } from "./src/nav";
import { AgentEditor } from "./src/screens/AgentEditor";
import { Agents } from "./src/screens/Agents";
import { Home } from "./src/screens/Chat";
import { DocumentEditor } from "./src/screens/DocumentEditor";
import { Documents } from "./src/screens/Documents";
import { FileText } from "./src/screens/FileText";
import { Inbox } from "./src/screens/Inbox";
import { Project } from "./src/screens/Project";
import { SettingPart, Settings } from "./src/screens/Settings";
import { SignIn } from "./src/screens/SignIn";
import { SessionProvider, useSession } from "./src/session";
import { type Colors, useColors } from "./src/theme";
import { Button, LoadError, Loading } from "./src/ui";

const markLight = require("./assets/splash-mark.png");
const markDark = require("./assets/splash-mark-dark.png");
const styles = StyleSheet.create({ cover: { alignItems: "center", justifyContent: "center" } });

const Stack = createNativeStackNavigator<RootParams>();

/**
 * Counts what waits for the person, for the mark on the pill and the row in the drawer:
 * approvals to decide, and what they were told and have not read. Each is asked for on its
 * own: an older server that tells nothing still has its approvals counted.
 */
function useWaitingCount() {
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => {
    void Promise.all([
      api<Approval[]>("/api/app/approvals")
        .then((all) => all.filter((approval) => approval.status === "pending").length)
        .catch(() => null),
      api<{ unread: number }>("/api/app/notices")
        .then((told) => told.unread)
        .catch(() => 0),
    ]).then(([pending, unread]) => {
      if (pending !== null) setCount(pending + unread);
    });
  }, []);
  // Recounted when the app opens or comes back to the front; screens recount after a decision.
  useEffect(() => {
    refresh();
    const watching = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => watching.remove();
  }, [refresh]);
  return useMemo(() => ({ count, refresh }), [count, refresh]);
}

const Inside = createNativeStackNavigator<RootParams>();

/**
 * The sheet: one stack of its own, so a screen opened from it is pushed inside it with the
 * system's back, not laid over it as a second sheet.
 */
function Sheet() {
  const { t } = useI18n();
  const c = useColors();
  const outer = useNav();
  // The system draws its own glass round a bar button, so this is the mark alone.
  const close = () => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t.common.done}
      hitSlop={10}
      onPress={() => outer.goBack()}
      style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
    >
      <Ionicons name="close" size={22} color={c.text} />
    </Pressable>
  );
  return (
    <Inside.Navigator screenOptions={bar(c)}>
      <Inside.Screen
        name="Agents"
        component={Agents}
        options={{ title: t.app.agents, headerLeft: close }}
      />
      <Inside.Screen
        name="Documents"
        component={Documents}
        options={{ title: t.app.documents, headerLeft: close }}
      />
      <Inside.Screen
        name="Inbox"
        component={Inbox}
        options={{ title: t.app.inbox, headerLeft: close }}
      />
      <Inside.Screen name="Project" component={Project} options={{ title: "" }} />
      <Inside.Screen
        name="Settings"
        component={Settings}
        options={{ title: t.app.settings, headerLeft: close }}
      />
      <Inside.Screen name="Setting" component={SettingPart} options={{ title: "" }} />
      <Inside.Screen
        name="Document"
        component={DocumentEditor}
        options={{ title: t.app.docs.new }}
      />
      <Inside.Screen name="FileText" component={FileText} options={{ title: "" }} />
      <Inside.Screen name="Agent" component={AgentEditor} options={{ title: t.app.builder.new }} />
    </Inside.Navigator>
  );
}

/** How a bar inside a sheet looks: the page's own colour, no line under it. */
const bar = (c: Colors) => ({
  headerBackButtonDisplayMode: "minimal" as const,
  headerShadowVisible: false,
  headerStyle: { backgroundColor: c.page },
  headerTitleStyle: { fontSize: 17, fontWeight: "600" as const },
  headerTintColor: c.text,
  contentStyle: { backgroundColor: c.page },
});

/**
 * Signed in: the conversation, and one sheet over it that holds everything else. No tabs
 * (CHA-260).
 */
function Screens() {
  const c = useColors();
  const waiting = useWaitingCount();
  return (
    <Waiting.Provider value={waiting}>
      <Stack.Navigator screenListeners={{ focus: waiting.refresh }} screenOptions={bar(c)}>
        <Stack.Screen name="Home" component={Home} options={{ headerShown: false }} />
        <Stack.Screen
          name="Sheet"
          component={Sheet}
          options={{ headerShown: false, presentation: "modal" }}
        />
        {/* A file opened from the conversation itself: its text, in a sheet of its own. */}
        <Stack.Screen
          name="FileText"
          component={FileText}
          options={{ title: "", presentation: "modal" }}
        />
      </Stack.Navigator>
    </Waiting.Provider>
  );
}

function Unreachable() {
  const { t } = useI18n();
  const session = useSession();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingTop: insets.top }}>
      <LoadError message={t.common.network} onRetry={session.retry} />
      <View style={{ paddingHorizontal: 16, alignItems: "flex-start" }}>
        <Button
          small
          variant="ghost"
          label={t.settings.signOut}
          onPress={() => void session.signOut()}
        />
      </View>
    </View>
  );
}

/** True while the app is not in front: in the app switcher, or with a system sheet over it. */
function useAway(): boolean {
  const [away, setAway] = useState(AppState.currentState !== "active");
  useEffect(() => {
    const watching = AppState.addEventListener("change", (state) => setAway(state !== "active"));
    return () => watching.remove();
  }, []);
  return away;
}

function Root() {
  const away = useAway();
  const session = useSession();
  const c = useColors();
  const theme = useMemo(() => {
    const base = c.dark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: c.accentText,
        background: c.page,
        card: c.card,
        text: c.text,
        border: c.border,
        notification: c.accent,
      },
    };
  }, [c]);
  return (
    <View style={{ flex: 1, backgroundColor: c.page }}>
      <StatusBar style={c.dark ? "light" : "dark"} />
      {session.status === "starting" ? (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <Loading />
        </View>
      ) : session.status === "signedOut" ? (
        <SignIn />
      ) : session.status === "unreachable" ? (
        <Unreachable />
      ) : (
        // A new sign-in starts from the first screen, not where the last person left off.
        <NavigationContainer theme={theme} key={session.me?.sessionId}>
          <Screens />
        </NavigationContainer>
      )}
      {/* What the app switcher photographs is this cover, not a conversation or a file list. */}
      {away && session.status === "signedIn" && (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: c.page }]}
        >
          <Image
            source={c.dark ? markDark : markLight}
            accessibilityIgnoresInvertColors
            style={{ width: 64, height: 64 }}
          />
        </View>
      )}
    </View>
  );
}

function Localized() {
  const { locale } = useSession();
  return (
    <I18nProvider locale={locale}>
      <Root />
    </I18nProvider>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <Localized />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
