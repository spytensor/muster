import { Alert } from "react-native";

export interface Menu {
  title?: string;
  options: string[];
  /** Which option removes something, to mark it. */
  destructive?: number;
  cancel: string;
}

/** Asks the person to pick one of a few actions. `picked` gets the option's index; cancelling calls nothing. */
export function choose(menu: Menu, picked: (index: number) => void): void {
  Alert.alert(menu.title ?? "", undefined, [
    ...menu.options.map((text, index) => ({
      text,
      style: index === menu.destructive ? ("destructive" as const) : ("default" as const),
      onPress: () => picked(index),
    })),
    { text: menu.cancel, style: "cancel" as const },
  ]);
}
