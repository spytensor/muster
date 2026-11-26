import { useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n";
import { serverUrlFrom } from "../lib/pkce";
import { useSession } from "../session";
import { mono, useColors } from "../theme";
import { Button, Card, Field, Notice, useAction } from "../ui";

const markLight = require("../../assets/splash-mark.png");
const markDark = require("../../assets/splash-mark-dark.png");

/** The only screen a signed-out person sees: one button, and which server it signs in to. */
export function SignIn() {
  const { t } = useI18n();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState(session.server);
  const tidy = serverUrlFrom(address);
  // Plain http is for a server on this machine during development; anywhere else it can be read on the way.
  const insecure =
    session.server.startsWith("http://") &&
    !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(session.server);
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.page,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={styles.top}>
          <Image
            source={c.dark ? markDark : markLight}
            accessibilityIgnoresInvertColors
            style={styles.mark}
          />
          <Text accessibilityRole="header" style={[styles.title, { color: c.text }]}>
            {t.signIn.title}
          </Text>
          <Text style={[styles.lead, { color: c.muted }]}>{t.signIn.lead}</Text>
        </View>
        <View style={{ gap: 12 }}>
          {error && <Notice tone="bad">{error}</Notice>}
          <Button
            label={busy ? t.signIn.opening : t.signIn.button}
            busy={busy}
            disabled={editing}
            onPress={() =>
              void run(async () => {
                await session.signIn();
              })
            }
          />
          {insecure && <Notice>{t.signIn.insecure}</Notice>}
          <Card>
            {editing ? (
              <>
                <Field
                  label={t.signIn.server}
                  value={address}
                  onChangeText={setAddress}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  placeholder="https://muster.example.com"
                />
                <Text style={[styles.hint, { color: tidy ? c.muted : c.bad }]}>
                  {tidy || !address.trim() ? t.signIn.serverHint : t.signIn.serverInvalid}
                </Text>
                <View style={styles.row}>
                  <Button
                    small
                    variant="outline"
                    label={t.common.cancel}
                    style={{ flex: 1 }}
                    onPress={() => {
                      setAddress(session.server);
                      setEditing(false);
                    }}
                  />
                  <Button
                    small
                    label={t.signIn.use}
                    style={{ flex: 1 }}
                    disabled={!tidy}
                    onPress={() => {
                      if (!tidy) return;
                      void session.setServer(tidy).then(() => {
                        setAddress(tidy);
                        setEditing(false);
                      });
                    }}
                  />
                </View>
              </>
            ) : (
              <View style={[styles.row, { alignItems: "center" }]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.hint, { color: c.muted }]}>{t.signIn.server}</Text>
                  <Text numberOfLines={1} style={{ fontFamily: mono, fontSize: 14, color: c.text }}>
                    {session.server}
                  </Text>
                </View>
                <Button
                  small
                  variant="outline"
                  label={t.signIn.change}
                  disabled={busy}
                  onPress={() => setEditing(true)}
                />
              </View>
            )}
          </Card>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: "space-between", paddingHorizontal: 24, gap: 32 },
  top: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  mark: { width: 72, height: 72, marginBottom: 8 },
  title: { fontSize: 26, fontWeight: "700", letterSpacing: -0.4, textAlign: "center" },
  lead: { fontSize: 16, lineHeight: 23, textAlign: "center", maxWidth: 320 },
  hint: { fontSize: 13, lineHeight: 18 },
  row: { flexDirection: "row", gap: 10 },
});
