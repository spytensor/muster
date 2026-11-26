import { ActionSheetIOS } from "react-native";
import type { Menu } from "./menu";

/** Asks the person to pick one of a few actions, in the system's action sheet. Cancelling calls nothing. */
export function choose(menu: Menu, picked: (index: number) => void): void {
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: menu.title,
      options: [...menu.options, menu.cancel],
      destructiveButtonIndex: menu.destructive,
      cancelButtonIndex: menu.options.length,
    },
    (index) => {
      if (index < menu.options.length) picked(index);
    },
  );
}
