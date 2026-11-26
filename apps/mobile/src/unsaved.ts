import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { useI18n } from "./i18n";

/**
 * Keeps what was typed from being thrown away by a swipe, Back or the close button (the
 * review of CHA-261): while something is unsaved, leaving asks first. Returns how to leave
 * once it is saved, which does not ask.
 */
export function useUnsaved(dirty: boolean) {
  const navigation = useNavigation();
  const { t } = useI18n();
  const [leaving, setLeaving] = useState(false);
  usePreventRemove(dirty && !leaving, ({ data }) =>
    Alert.alert(t.common.unsaved, t.common.unsavedLead, [
      { text: t.common.keepEditing, style: "cancel" },
      {
        text: t.common.discard,
        style: "destructive",
        onPress: () => navigation.dispatch(data.action),
      },
    ]),
  );
  useEffect(() => {
    if (leaving) navigation.goBack();
  }, [leaving, navigation]);
  return () => setLeaving(true);
}
